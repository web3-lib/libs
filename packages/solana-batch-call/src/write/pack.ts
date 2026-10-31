import { MAX_COMPUTE_UNITS, setComputeUnitLimit, setComputeUnitPrice } from './instructions.js'
import { MAX_ACCOUNT_LOCKS, PACKET_DATA_SIZE, compileMessage, transactionSize, type Instruction } from './transaction.js'

/** 打包用的占位 blockhash（大小与真实值相同） */
export const PLACEHOLDER_BLOCKHASH = '11111111111111111111111111111111'

/** 计算预算指令（上限 + 单价）：发送时排在最前面 */
export function budgetInstructions(units: number, price: bigint): Instruction[] {
  return [setComputeUnitLimit(units), setComputeUnitPrice(price)]
}

/** 加上计算预算指令后，这些指令能否放进一笔交易（完整编译一次；不超过 1232 字节和 64 个账户） */
export function fitsInTransaction(payer: string, instructions: readonly Instruction[]): boolean {
  const message = compileMessage(payer, [...budgetInstructions(MAX_COMPUTE_UNITS, 0n), ...instructions], PLACEHOLDER_BLOCKHASH)
  return transactionSize(message) <= PACKET_DATA_SIZE && message.accountKeys.length <= MAX_ACCOUNT_LOCKS
}

function compactLength(n: number): number {
  return n < 0x80 ? 1 : n < 0x4000 ? 2 : 3
}

/**
 * 增量估算 legacy 交易的大小（与 compileMessage + transactionSize 的结果相同）：
 * 签名数 + 64 × 签名数 + 3 字节头 + 账户数 + 32 × 账户数 + 32 字节 blockhash + 指令数 + 各指令（程序下标 1 + 账户数 + 账户下标 + 数据长度 + 数据）。
 * 只记累计的账户集合（是否签名者）和指令字节，加一个调用只看它自己的指令
 */
class SizeEstimate {
  /** 账户 → 是否签名者 */
  readonly #signer = new Map<string, boolean>()
  #signers = 0
  #instructions = 0
  #instructionBytes = 0

  constructor(payer: string) {
    this.#signer.set(payer, true)
    this.#signers = 1
    this.add(budgetInstructions(MAX_COMPUTE_UNITS, 0n))
  }

  /** 加入这些指令后的大小和账户数（不修改状态） */
  probe(instructions: readonly Instruction[]): { size: number; accounts: number } {
    let accounts = this.#signer.size
    let signers = this.#signers
    let bytes = this.#instructionBytes
    const added = new Map<string, boolean>()
    const touch = (pubkey: string, isSigner: boolean) => {
      // 本次已经加过 / 升级过的以 added 为准（累计集合里是非签名者 false 时，?? 不会回落，不能先查累计集合）
      const known = added.has(pubkey) ? added.get(pubkey) : this.#signer.get(pubkey)
      if (known === undefined) {
        accounts++
        if (isSigner) signers++
        added.set(pubkey, isSigner)
      } else if (isSigner && !known) {
        signers++
        added.set(pubkey, true)
      }
    }
    for (const ix of instructions) {
      ix.keys.forEach((k) => touch(k.pubkey, k.isSigner))
      touch(ix.programId, false)
      bytes += 1 + compactLength(ix.keys.length) + ix.keys.length + compactLength(ix.data.length) + ix.data.length
    }
    const count = this.#instructions + instructions.length
    const size = compactLength(signers) + 64 * signers + 3 + compactLength(accounts) + 32 * accounts + 32 + compactLength(count) + bytes
    return { size, accounts }
  }

  fits(instructions: readonly Instruction[]): boolean {
    const { size, accounts } = this.probe(instructions)
    return size <= PACKET_DATA_SIZE && accounts <= MAX_ACCOUNT_LOCKS
  }

  add(instructions: readonly Instruction[]): void {
    for (const ix of instructions) {
      for (const k of [...ix.keys.map((key) => [key.pubkey, key.isSigner] as const), [ix.programId, false] as const]) {
        const [pubkey, isSigner] = k
        const known = this.#signer.get(pubkey)
        if (known === undefined) {
          this.#signer.set(pubkey, isSigner)
          if (isSigner) this.#signers++
        } else if (isSigner && !known) {
          this.#signer.set(pubkey, true)
          this.#signers++
        }
      }
      this.#instructionBytes += 1 + compactLength(ix.keys.length) + ix.keys.length + compactLength(ix.data.length) + ix.data.length
      this.#instructions++
    }
  }
}

export interface PackOptions {
  /** 每笔交易最多几个调用，默认不限（只受交易大小 / 账户数限制） */
  batchSize?: number
  /** 只能单独成一笔交易的调用（如计算单元和优先费用固定的扫空转账） */
  alone?: (index: number) => boolean
}

/** 打包结果的一笔交易：包含的调用下标；tooLarge 为 true 时是单个调用自己就放不进一笔交易 */
export interface Pack {
  indices: number[]
  tooLarge: boolean
}

/**
 * 把调用按顺序打包成交易（batchCall / batchTransfer / batchCollect 的发送和 /reclaim、/claim 的批量计划共用）：
 * 相邻的调用放进同一笔，直到加上计算预算指令后超过 1232 字节或 64 个账户、或达到 batchSize；alone 的调用单独成一笔；
 * 单个调用自己就放不进的单独成一笔并标记 tooLarge。
 * 大小按累计的账户集合和指令字节增量估算（每加一个调用只看它自己的指令），每笔打完再完整编译校验一次
 */
export function packUnits(payer: string, units: ReadonlyArray<{ instructions: readonly Instruction[] }>, options: PackOptions = {}): Pack[] {
  const batchSize = options.batchSize ?? Number.POSITIVE_INFINITY
  const alone = options.alone ?? (() => false)
  const packs: Pack[] = []
  let i = 0
  while (i < units.length) {
    const estimate = new SizeEstimate(payer)
    const first = (units[i] as { instructions: readonly Instruction[] }).instructions
    if (!estimate.fits(first)) {
      packs.push({ indices: [i], tooLarge: true })
      i++
      continue
    }
    estimate.add(first)
    const indices = [i++]
    if (!alone(indices[0] as number)) {
      while (i < units.length && indices.length < batchSize && !alone(i)) {
        const next = (units[i] as { instructions: readonly Instruction[] }).instructions
        if (!estimate.fits(next)) break
        estimate.add(next)
        indices.push(i++)
      }
    }
    // 完整编译校验一次（估算与编译结果应当一致；万一不一致，去掉末尾的调用直到放得下，去掉的留给下一笔）
    while (indices.length > 1 && !fitsInTransaction(payer, indices.flatMap((k) => (units[k] as { instructions: readonly Instruction[] }).instructions))) {
      indices.pop()
      i--
    }
    packs.push({ indices, tooLarge: false })
  }
  return packs
}
