import { ed25519 } from '@noble/curves/ed25519.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { base58, base64 } from '@scure/base'

import { ASSOCIATED_TOKEN_PROGRAM_ID, MIN_CONTEXT_SLOT_NOT_REACHED, RpcError, SYSTEM_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddress } from '../src/index.js'
import { COMPUTE_BUDGET_PROGRAM_ID } from '../src/write/instructions.js'
import { createMockNode, mintData, tokenAccountData, type MockAccount } from './mock.js'

const NATIVE_MINT_ADDRESS = 'So11111111111111111111111111111111111111112'

/** 新建代币账户的租金（165 字节） */
export const TOKEN_ACCOUNT_RENT = 2_039_280n
/** 0 字节系统账户的免租下限 */
export const RENT_EXEMPT_MIN = 890_880n

export function keypair(seedByte: number) {
  const seed = new Uint8Array(32).fill(seedByte)
  const publicKey = ed25519.getPublicKey(seed)
  const secretKey = new Uint8Array(64)
  secretKey.set(seed)
  secretKey.set(publicKey, 32)
  return { seed, secretKey, address: base58.encode(publicKey) }
}

export interface FakeSolanaOptions {
  /** 广播后过几次 getSignatureStatuses 才上链，默认 0（广播时立即上链） */
  landAfterPolls?: number
  /** blockhash 有效的区块数，默认 150；函数时按第几次 getLatestBlockhash 决定 */
  validBlocks?: number | ((call: number) => number)
  /** 前几次（不同签名的）广播丢弃：交易永远不会上链 */
  drop?: number
  /** getRecentPrioritizationFees 返回的费用 */
  priorityFees?: number[]
  /** 状态查询落后几个 slot（模拟负载均衡后面落后的节点：最近几个 slot 上链的交易查不到） */
  statusLag?: number
  /** System 转账消耗的计算单元，默认 150（调大可以模拟超出单笔交易的计算上限） */
  systemTransferUnits?: number
  /** 确认状态逐步推进：上链后第一次查询为 processed，之后 confirmed，再过 finalizeAfter 次（默认 3）为 finalized。默认直接 confirmed */
  progression?: { finalizeAfter?: number }
  /**
   * 其他程序的假实现（如 DEX）：按指令修改状态（state 是这笔交易执行中的状态，可以直接改）；抛错时整笔交易失败。
   * keys / signers 是指令的账户和是否签名
   */
  programs?: Record<string, (ix: { keys: string[]; signers: boolean[]; data: Uint8Array }, state: Record<string, MockAccount>) => void>
}

/** 拦截请求：返回 undefined 时照常处理；可以抛错、返回别的结果，或调用 next 后再处理 */
export type Interceptor = (method: string, params: readonly unknown[], next: () => Promise<unknown>) => Promise<unknown> | unknown

class TxError extends Error {
  constructor(
    readonly err: unknown,
    readonly logs: string[] = [],
  ) {
    super(JSON.stringify(err))
  }
}

interface ParsedTx {
  signatures: Uint8Array[]
  message: Uint8Array
  numSigners: number
  numReadonlySigned: number
  numReadonlyUnsigned: number
  keys: string[]
  blockhash: string
  instructions: Array<{ program: string; accounts: number[]; data: Uint8Array }>
}

function parse(raw: Uint8Array): ParsedTx {
  let o = 0
  const compact = () => {
    let value = 0
    for (let shift = 0; ; shift += 7) {
      const b = raw[o++] as number
      value |= (b & 0x7f) << shift
      if (!(b & 0x80)) return value
    }
  }
  const sigCount = compact()
  const signatures = Array.from({ length: sigCount }, () => raw.slice(o, (o += 64)))
  const messageStart = o
  const numSigners = raw[o++] as number
  const numReadonlySigned = raw[o++] as number
  const numReadonlyUnsigned = raw[o++] as number
  const keyCount = compact()
  const keys = Array.from({ length: keyCount }, () => base58.encode(raw.slice(o, (o += 32))))
  const blockhash = base58.encode(raw.slice(o, (o += 32)))
  const ixCount = compact()
  const instructions = Array.from({ length: ixCount }, () => {
    const program = keys[raw[o++] as number] as string
    const n = compact()
    const accounts = Array.from({ length: n }, () => raw[o++] as number)
    const len = compact()
    const data = raw.slice(o, (o += len))
    return { program, accounts, data }
  })
  if (o !== raw.length) throw new Error('fake: trailing bytes')
  if (sigCount !== numSigners) throw new Error('fake: signature count mismatch')
  return { signatures, message: raw.slice(messageStart), numSigners, numReadonlySigned, numReadonlyUnsigned, keys, blockhash, instructions }
}

const u64 = (data: Uint8Array, offset: number) => new DataView(data.buffer, data.byteOffset).getBigUint64(offset, true)

function clone(accounts: Record<string, MockAccount>): Record<string, MockAccount> {
  return Object.fromEntries(Object.entries(accounts).map(([k, a]) => [k, { ...a, data: a.data?.slice() }]))
}

/**
 * 假 Solana 节点：读方法走 createMockNode，写方法真的解析 / 验签 / 执行交易（System 转账、ATA 创建、Token TransferChecked / CloseAccount、计算预算）
 */
export function createFakeSolana(options: FakeSolanaOptions = {}) {
  const accounts: Record<string, MockAccount> = {}
  const node = createMockNode({ accounts })
  let height = 1000
  /** 每个实例的 blockhash 都不同（库会记住最近发过的消息，相同的 blockhash 会让不同测试互相影响） */
  const salt = Math.random()
  let blockhashCalls = 0
  const blockhashes = new Map<string, number>() // blockhash → lastValidBlockHeight
  const landed = new Map<string, { slot: number; err: unknown }>()
  const pending: Array<{ signature: string; tx: ParsedTx; polls: number }> = []
  const dropped = new Set<string>()
  let toDrop = options.drop ?? 0
  const sent: string[] = []
  const frozen = new Set<string>()
  const simulations: unknown[] = []

  const writable = (tx: ParsedTx, i: number) =>
    i < tx.numSigners ? i < tx.numSigners - tx.numReadonlySigned : i < tx.keys.length - tx.numReadonlyUnsigned

  /** 执行交易，返回新状态；失败抛 TxError（手续费照扣） */
  function execute(tx: ParsedTx, state: Record<string, MockAccount>): { state: Record<string, MockAccount>; units: number; err: unknown; logs: string[]; fee: bigint } {
    let limit = 200_000 * tx.instructions.length
    let price = 0n
    for (const ix of tx.instructions) {
      if (ix.program === COMPUTE_BUDGET_PROGRAM_ID) {
        if (ix.data[0] === 2) limit = new DataView(ix.data.buffer, ix.data.byteOffset).getUint32(1, true)
        if (ix.data[0] === 3) price = u64(ix.data, 1)
      }
    }
    const fee = 5000n * BigInt(tx.numSigners) + (price * BigInt(limit) + 999_999n) / 1_000_000n
    const payer = tx.keys[0] as string
    const payerAccount = state[payer]
    if (!payerAccount) throw new TxError('AccountNotFound')
    if (payerAccount.owner !== SYSTEM_PROGRAM_ID || payerAccount.data?.length) throw new TxError('InvalidAccountForFee')
    const payerBefore = payerAccount.lamports ?? 0n
    if (payerBefore < fee) throw new TxError('InsufficientFundsForFee')
    // 与 agave 的 validate_fee_payer 一致：扣完手续费后从免租掉进需要交租的状态时，交易直接被拒（不上链、不扣费）
    const payerAfter = payerBefore - fee
    if (payerBefore >= RENT_EXEMPT_MIN && payerAfter > 0n && payerAfter < RENT_EXEMPT_MIN) throw new TxError({ InsufficientFundsForRent: { account_index: 0 } })
    const charged = clone(state)
    ;(charged[payer] as MockAccount).lamports = payerAfter
    const next = clone(charged)
    let units = 0
    const logs: string[] = []
    try {
      tx.instructions.forEach((ix, i) => {
        const key = (k: number) => tx.keys[ix.accounts[k] as number] as string
        const isSigner = (k: number) => (ix.accounts[k] as number) < tx.numSigners
        const fail = (reason: unknown, log?: string): never => {
          if (log) logs.push(log)
          const code = (reason as { Custom?: number }).Custom
          logs.push(`Program ${ix.program} failed: ${code === undefined ? String(reason) : `custom program error: 0x${code.toString(16)}`}`)
          throw new TxError({ InstructionError: [i, reason] }, logs)
        }
        const use = (n: number) => {
          units += n
          if (units > limit) fail('ComputationalBudgetExceeded', `Program ${ix.program} consumed ${units} of ${limit} compute units`)
        }
        const lamports = (address: string) => next[address]?.lamports ?? 0n
        const credit = (address: string, amount: bigint) => {
          next[address] ??= { lamports: 0n, owner: SYSTEM_PROGRAM_ID }
          ;(next[address] as MockAccount).lamports = lamports(address) + amount
        }
        if (ix.program === COMPUTE_BUDGET_PROGRAM_ID) {
          use(150)
          return
        }
        if (ix.program === SYSTEM_PROGRAM_ID) {
          use(options.systemTransferUnits ?? 150)
          if (ix.data.length !== 12 || new DataView(ix.data.buffer, ix.data.byteOffset).getUint32(0, true) !== 2) fail('InvalidInstructionData', 'Program 11111111111111111111111111111111 failed: only Transfer is supported by the fake')
          const from = key(0)
          const amount = u64(ix.data, 4)
          if (!isSigner(0)) fail('MissingRequiredSignature')
          if (next[from]?.data?.length) fail({ Custom: 3 }, 'Transfer: `from` must not carry data')
          if (lamports(from) < amount) fail({ Custom: 1 }, `Transfer: insufficient lamports ${lamports(from)}, need ${amount}`)
          ;(next[from] as MockAccount).lamports = lamports(from) - amount
          credit(key(1), amount)
          return
        }
        if (ix.program === ASSOCIATED_TOKEN_PROGRAM_ID) {
          const [payerKey, ata, owner, mint, , program] = [0, 1, 2, 3, 4, 5].map(key) as [string, string, string, string, string, string]
          const idempotent = ix.data[0] === 1
          if (ix.data.length > 0 && ix.data[0] !== 0 && !idempotent) fail('InvalidInstructionData')
          if (getAssociatedTokenAddress(owner, mint, program) !== ata) fail('InvalidSeeds', 'Program log: Associated address does not match seed derivation')
          if (next[mint]?.owner !== program || !next[mint]?.data) fail('IncorrectProgramId', 'Program log: Error: IncorrectProgramId')
          const existing = next[ata]
          if (existing?.data?.length) {
            use(4000)
            // CreateIdempotent：已经是这个钱包这个代币的账户时什么都不做；普通 Create 报已存在
            if (!idempotent) fail({ Custom: 0 }, 'Allocate: account already in use')
            if (existing.owner !== program || base58.encode(existing.data.slice(0, 32)) !== mint || base58.encode(existing.data.slice(32, 64)) !== owner) fail('IllegalOwner')
            return
          }
          use(25_000)
          // 地址上事先只有 lamports（有人先转了 SOL）：照常创建，只补差额
          const prefunded = existing?.lamports ?? 0n
          const topUp = prefunded >= TOKEN_ACCOUNT_RENT ? 0n : TOKEN_ACCOUNT_RENT - prefunded
          if (lamports(payerKey) < topUp) fail({ Custom: 1 }, 'Transfer: insufficient lamports')
          ;(next[payerKey] as MockAccount).lamports = lamports(payerKey) - topUp
          const data = tokenAccountData(mint, owner, 0n)
          data[108] = 1
          next[ata] = { lamports: prefunded + topUp, owner: program, data }
          return
        }
        if (ix.program === TOKEN_PROGRAM_ID) {
          if (ix.data[0] === 12) {
            use(6200)
            const [source, mint, dest, authority] = [0, 1, 2, 3].map(key) as [string, string, string, string]
            const amount = u64(ix.data, 1)
            const src = next[source]
            const dst = next[dest]
            // 与 spl-token 的 process_transfer 顺序一致：账户 → 冻结 → 余额 → mint → 精度 → owner
            if (!src?.data?.length || !dst?.data?.length) fail('InvalidAccountData', 'Program log: Error: InvalidAccountData')
            if (frozen.has(source) || frozen.has(dest)) fail({ Custom: 17 }, 'Program log: Error: Account is frozen')
            const balance = u64(src!.data!, 64)
            if (balance < amount) fail({ Custom: 1 }, 'Program log: Error: insufficient funds')
            const srcMint = base58.encode(src!.data!.slice(0, 32))
            if (srcMint !== mint || base58.encode(dst!.data!.slice(0, 32)) !== srcMint) fail({ Custom: 3 }, 'Program log: Error: Account not associated with this Mint')
            if (ix.data[9] !== next[mint]?.data?.[44]) fail({ Custom: 18 }, 'Program log: Error: decimals mismatch')
            if (!isSigner(3) || base58.encode(src!.data!.slice(32, 64)) !== authority) fail({ Custom: 4 }, 'Program log: Error: owner does not match')
            new DataView(src!.data!.buffer).setBigUint64(64, balance - amount, true)
            new DataView(dst!.data!.buffer).setBigUint64(64, u64(dst!.data!, 64) + amount, true)
            return
          }
          if (ix.data[0] === 17) {
            // SyncNative：wSOL 账户的代币余额 = lamports − 免租
            use(3000)
            const acc = next[key(0)]
            if (!acc?.data || base58.encode(acc.data.slice(0, 32)) !== NATIVE_MINT_ADDRESS) fail({ Custom: 19 }, 'Program log: Error: Instruction does not support non-native tokens')
            new DataView(acc!.data!.buffer).setBigUint64(64, (acc!.lamports ?? 0n) - TOKEN_ACCOUNT_RENT, true)
            return
          }
          if (ix.data[0] === 9) {
            use(3000)
            const [account, dest, authority] = [0, 1, 2].map(key) as [string, string, string]
            const acc = next[account]
            if (!acc?.data) fail('InvalidAccountData')
            // wSOL 账户可以带余额关闭（lamports 全部退回）
            if (u64(acc!.data!, 64) !== 0n && base58.encode(acc!.data!.slice(0, 32)) !== NATIVE_MINT_ADDRESS) fail({ Custom: 11 }, 'Program log: Error: Non-native account can only be closed if its balance is zero')
            if (base58.encode(acc!.data!.slice(32, 64)) !== authority || !isSigner(2)) fail({ Custom: 4 }, 'Program log: Error: owner does not match')
            credit(dest, acc!.lamports ?? 0n)
            delete next[account]
            return
          }
        }
        const custom = options.programs?.[ix.program]
        if (custom) {
          use(50_000)
          try {
            custom({ keys: ix.accounts.map((_, k) => key(k)), signers: ix.accounts.map((_, k) => isSigner(k)), data: ix.data }, next)
          } catch (err) {
            fail({ Custom: 6000 }, `Program log: ${err instanceof Error ? err.message : String(err)}`)
          }
          return
        }
        fail('InvalidInstructionData', `Program ${ix.program} failed: unsupported by the fake`)
      })
      // 免租检查（与 agave 的规则一致）：被写过的系统账户余额落在 (0, 免租下限) 之间时，
      // 只有原来就低于下限、且余额没有增加时才允许
      tx.keys.forEach((k, i) => {
        const a = next[k]
        const after = a?.lamports ?? 0n
        const before = charged[k]?.lamports ?? 0n
        const wasPaying = before > 0n && before < RENT_EXEMPT_MIN
        if (writable(tx, i) && a && a.owner === SYSTEM_PROGRAM_ID && !a.data?.length && after > 0n && after < RENT_EXEMPT_MIN && !(wasPaying && after <= before)) {
          throw new TxError({ InsufficientFundsForRent: { account_index: i } }, logs)
        }
      })
      // 与真实节点一致：余额为 0 的系统账户不再存在
      for (const [k, a] of Object.entries(next)) {
        if (a.owner === SYSTEM_PROGRAM_ID && !a.data?.length && (a.lamports ?? 0n) === 0n) delete next[k]
      }
      return { state: next, units, err: null, logs, fee }
    } catch (err) {
      if (!(err instanceof TxError)) throw err
      return { state: charged, units, err: err.err, logs: err.logs, fee }
    }
  }

  function land(entry: { signature: string; tx: ParsedTx }) {
    const lastValid = blockhashes.get(entry.tx.blockhash)
    if (lastValid === undefined || height > lastValid) return // 过期：不会上链
    try {
      const result = execute(entry.tx, accounts)
      for (const k of Object.keys(accounts)) delete accounts[k]
      Object.assign(accounts, result.state)
      node.slot += 1
      landed.set(entry.signature, { slot: node.slot, err: result.err })
    } catch (err) {
      if (err instanceof TxError) return // 付不起手续费：不上链
      throw err
    }
  }

  let interceptor: Interceptor | null = null
  const transport = {
    label: 'fake',
    async request<T>(method: string, params: readonly unknown[] = []): Promise<T> {
      if (interceptor) {
        // 拦截器调用过 next 时直接用它的结果，同一个请求不执行两次
        let called: Promise<T> | null = null
        const result = await interceptor(method, params, () => (called ??= handle<T>(method, params)))
        if (result !== undefined) return result as T
        if (called) return called
      }
      return handle<T>(method, params)
    },
  }
  async function handle<T>(method: string, params: readonly unknown[]): Promise<T> {
      switch (method) {
        case 'getLatestBlockhash': {
          const call = blockhashCalls++
          const valid = typeof options.validBlocks === 'function' ? options.validBlocks(call) : (options.validBlocks ?? 150)
          const blockhash = base58.encode(sha256(new TextEncoder().encode(`blockhash-${salt}-${height}-${call}`)))
          blockhashes.set(blockhash, height + valid)
          return { context: { slot: node.slot }, value: { blockhash, lastValidBlockHeight: height + valid } } as T
        }
        case 'getBlockHeight':
          return height as T
        case 'getEpochInfo':
          return { epoch: 500, slotIndex: 0, slotsInEpoch: 432000, absoluteSlot: node.slot, blockHeight: height } as T
        case 'getRecentPrioritizationFees':
          return (options.priorityFees ?? [0]).map((fee, i) => ({ slot: i, prioritizationFee: fee })) as T
        case 'simulateTransaction': {
          const tx = parse(base64.decode(params[0] as string))
          const config = (params[1] ?? {}) as { sigVerify?: boolean; replaceRecentBlockhash?: boolean; minContextSlot?: number; accounts?: { addresses: string[] } }
          if (config.minContextSlot !== undefined && config.minContextSlot > node.slot) {
            throw new RpcError('Minimum context slot has not been reached', MIN_CONTEXT_SLOT_NOT_REACHED)
          }
          if (config.sigVerify && tx.signatures.some((sig, i) => !ed25519.verify(sig, tx.message, base58.decode(tx.keys[i] as string)))) {
            throw new RpcError('Transaction signature verification failure', -32003)
          }
          simulations.push(tx)
          if (!config.replaceRecentBlockhash && (blockhashes.get(tx.blockhash) ?? -1) < height) {
            return { context: { slot: node.slot }, value: { err: 'BlockhashNotFound', logs: [], unitsConsumed: 0 } } as T
          }
          try {
            const result = execute(tx, accounts)
            // accounts：返回执行后的这些账户（与真实节点一致：不存在时为 null）
            const after = config.accounts?.addresses.map((a) => {
              const acc = result.state[a]
              return acc ? { lamports: Number(acc.lamports ?? 0n), owner: acc.owner, data: [base64.encode(acc.data ?? new Uint8Array()), 'base64'], executable: false } : null
            })
            return { context: { slot: node.slot }, value: { err: result.err, logs: result.logs, unitsConsumed: result.units, ...(after ? { accounts: after } : {}) } } as T
          } catch (err) {
            if (err instanceof TxError) return { context: { slot: node.slot }, value: { err: err.err, logs: err.logs, unitsConsumed: 0 } } as T
            throw err
          }
        }
        case 'sendTransaction': {
          const tx = parse(base64.decode(params[0] as string))
          tx.signatures.forEach((sig, i) => {
            if (!ed25519.verify(sig, tx.message, base58.decode(tx.keys[i] as string))) throw new RpcError('Transaction signature verification failure', -32003)
          })
          const signature = base58.encode(tx.signatures[0] as Uint8Array)
          sent.push(signature)
          if (landed.has(signature) || pending.some((p) => p.signature === signature) || dropped.has(signature)) {
            return signature as T
          }
          if (toDrop > 0) {
            toDrop--
            dropped.add(signature)
            return signature as T
          }
          const entry = { signature, tx, polls: 0 }
          if (!options.landAfterPolls) land(entry)
          else pending.push(entry)
          return signature as T
        }
        case 'getSignatureStatuses': {
          // 每次轮询过去一个块
          height += 1
          node.slot += 1
          for (const entry of [...pending]) {
            if (++entry.polls > (options.landAfterPolls ?? 0)) {
              pending.splice(pending.indexOf(entry), 1)
              land(entry)
            }
          }
          const seen = node.slot - (options.statusLag ?? 0)
          return {
            context: { slot: seen },
            value: (params[0] as string[]).map((s) => {
              const l = landed.get(s)
              if (!l || l.slot > seen) return null
              const age = node.slot - l.slot
              const status = !options.progression ? 'confirmed' : age < 1 ? 'processed' : age <= (options.progression.finalizeAfter ?? 3) ? 'confirmed' : 'finalized'
              return { slot: l.slot, err: l.err, confirmationStatus: status, confirmations: status === 'finalized' ? null : age }
            }),
          } as T
        }
        default:
          return node.request<T>(method, params)
      }
  }

  return {
    transport,
    intercept(fn: Interceptor | null) {
      interceptor = fn
    },
    accounts,
    sent,
    landed,
    simulations,
    frozen,
    get height() {
      return height
    },
    setSol(address: string, lamports: bigint) {
      accounts[address] = { lamports, owner: SYSTEM_PROGRAM_ID }
    },
    sol(address: string) {
      return accounts[address]?.lamports ?? 0n
    },
    addMint(mint: string, decimals: number) {
      accounts[mint] = { lamports: 1_461_600n, owner: TOKEN_PROGRAM_ID, data: mintData({ decimals, supply: 10n ** 18n }) }
    },
    setToken(owner: string, mint: string, amount: bigint) {
      const ata = getAssociatedTokenAddress(owner, mint, TOKEN_PROGRAM_ID)
      const data = tokenAccountData(mint, owner, amount)
      data[108] = 1
      accounts[ata] = { lamports: TOKEN_ACCOUNT_RENT, owner: TOKEN_PROGRAM_ID, data }
      return ata
    },
    token(owner: string, mint: string): bigint | null {
      const a = accounts[getAssociatedTokenAddress(owner, mint, TOKEN_PROGRAM_ID)]
      return a?.data ? u64(a.data, 64) : null
    },
  }
}
