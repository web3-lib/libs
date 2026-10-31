/** Tron 节点访问（TronRpc：参考区块、链参数、账户资源、模拟、广播）与资源计费（带宽 / 能量 / 激活费） */
import { hexlify, toUtf8String } from 'ethers'

import type { EthersLikeProvider } from '../../aggregate.js'
import { decodeRevertReason } from '../../errors.js'
import { errorText } from '../../fallback.js'
import { TronProvider } from '../../tron.js'
import { runOnNodes } from '../rpc.js'
import type { SendOptions, TronSendOptions } from '../send.js'
import { encodeRawData, encodeTransaction, toTronHex, type RefBlock, type TronContract } from './codec.js'

// ---- 节点访问 ----

export interface ChainParams {
  /** 每单位能量烧多少 sun */
  energyFee: bigint
  /** 每字节带宽烧多少 sun */
  bandwidthFee: bigint
  /** 转 TRX 给没激活的地址时的激活费（1 TRX） */
  newAccountFee: bigint
  /** 创建账户的带宽：质押带宽不够时烧的 TRX（0.1 TRX） */
  createAccountFee: bigint
}

/** 账户状态：余额和可用资源 */
export interface Resources {
  exists: boolean
  balance: bigint
  /** 剩余免费带宽（没激活的账户没有） */
  free: number
  /** 剩余质押带宽 */
  staked: number
  /** 剩余能量（质押得到的） */
  energy: number
}

/**
 * 按 java-tron 的顺序用带宽：质押带宽够就用质押的，否则免费带宽够就用免费的，两者不能凑在一起用；都不够时整笔按字节烧 TRX。
 * 会扣减 r 里的剩余带宽，返回要烧的 sun
 */
export function bandwidthBurn(r: { free: number; staked: number }, bytes: number, fee: bigint): bigint {
  if (r.staked >= bytes) {
    r.staked -= bytes
    return 0n
  }
  if (r.free >= bytes) {
    r.free -= bytes
    return 0n
  }
  return BigInt(bytes) * fee
}

/**
 * 转 TRX 的手续费：给没激活的地址转时，java-tron 按创建账户计费：激活费 + 创建账户的带宽（质押带宽够时用质押的，否则烧 createAccountFee），
 * 不再收普通带宽费，也不能用免费带宽；给已激活的地址转时按普通带宽。会扣减 r 里的剩余带宽，返回要烧的 sun
 */
export function transferBurn(r: { free: number; staked: number }, bytes: number, params: ChainParams, activates: boolean): bigint {
  if (!activates) return bandwidthBurn(r, bytes, params.bandwidthFee)
  if (r.staked >= bytes) {
    r.staked -= bytes
    return params.newAccountFee
  }
  return params.newAccountFee + params.createAccountFee
}

/** 按预估能量（× 1.2 余量）扣减账户能量，返回要烧的 sun */
export function energyBurn(r: { energy: number }, energy: number, fee: bigint): bigint {
  const need = Math.ceil(energy * 1.2)
  const burned = Math.max(0, need - r.energy)
  r.energy = Math.max(0, r.energy - need)
  return BigInt(burned) * fee
}

/** 带宽按交易字节数 + 64（节点给交易结果预留的大小）计 */
const RESULT_RESERVE = 64

export class TronRpc {
  #ref: { at: number; value: Promise<RefBlock> } | null = null
  #params: Promise<ChainParams> | null = null
  /** 最近发出的交易 ID：同样内容、同一毫秒生成的交易 ID 相同，要错开 */
  readonly #recent = new Set<string>()

  constructor(
    readonly rpc: EthersLikeProvider,
    readonly options: SendOptions & TronSendOptions,
  ) {}

  request<T = any>(path: string, body: Record<string, unknown> = {}): Promise<T> {
    return runOnNodes(this.rpc, path, async (node) => tronNode(node).request(path, body) as Promise<T>)
  }

  /** 参考区块（缓存 3 秒） */
  refBlock(fresh = false): Promise<RefBlock> {
    if (fresh || !this.#ref || Date.now() - this.#ref.at > 3_000) {
      const value = this.request('wallet/getblock', { detail: false })
        .catch(() => this.request('wallet/getnowblock'))
        .then((block: { blockID?: string; block_header?: { raw_data?: { number?: number; timestamp?: number } } }) => {
          const header = block?.block_header?.raw_data
          if (!block?.blockID || header?.number === undefined || header.timestamp === undefined) {
            throw new Error('Unable to read the latest Tron block')
          }
          return { number: header.number, hash: block.blockID, timestamp: header.timestamp }
        })
      value.catch(() => {
        if (this.#ref?.value === value) this.#ref = null
      })
      this.#ref = { at: Date.now(), value }
    }
    return this.#ref.value
  }

  params(): Promise<ChainParams> {
    this.#params ??= this.request<{ chainParameter?: Array<{ key: string; value?: number }> }>('wallet/getchainparameters').then((res) => {
      const map = new Map((res?.chainParameter ?? []).map((p) => [p.key, BigInt(p.value ?? 0)]))
      return {
        energyFee: map.get('getEnergyFee') ?? 210n,
        bandwidthFee: map.get('getTransactionFee') ?? 1000n,
        newAccountFee: map.get('getCreateNewAccountFeeInSystemContract') ?? 1_000_000n,
        createAccountFee: map.get('getCreateAccountFee') ?? 100_000n,
      }
    })
    this.#params.catch(() => (this.#params = null))
    return this.#params
  }

  async resources(address: string): Promise<Resources> {
    const hex = toTronHex(address)
    const [account, res] = await Promise.all([
      this.request<{ address?: string; balance?: number }>('wallet/getaccount', { address: hex }),
      this.request<Record<string, number>>('wallet/getaccountresource', { address: hex }),
    ])
    const n = (key: string) => Number(res?.[key] ?? 0)
    const exists = Boolean(account?.address)
    return {
      exists,
      balance: BigInt(account?.balance ?? 0),
      free: exists ? Math.max(0, n('freeNetLimit') - n('freeNetUsed')) : 0,
      staked: Math.max(0, n('NetLimit') - n('NetUsed')),
      energy: Math.max(0, n('EnergyLimit') - n('EnergyUsed')),
    }
  }

  readonly #exists = new Map<string, Promise<boolean>>()
  readonly #contracts = new Map<string, Promise<boolean>>()

  /** 账户是否已激活（转 TRX 给没激活的地址要付激活费） */
  accountExists(address: string): Promise<boolean> {
    let cached = this.#exists.get(address)
    if (!cached) {
      cached = this.request<{ address?: string }>('wallet/getaccount', { address: toTronHex(address) }).then((a) => Boolean(a?.address))
      cached.catch(() => this.#exists.delete(address))
      this.#exists.set(address, cached)
    }
    return cached
  }

  /** 地址是不是合约（主网禁止用 TransferContract 给合约转 TRX，要用合约调用带 call_value） */
  isContract(address: string): Promise<boolean> {
    let cached = this.#contracts.get(address)
    if (!cached) {
      cached = this.request<Record<string, unknown>>('wallet/getcontract', { value: toTronHex(address) }).then((c) => Boolean(c && (c.bytecode || c.contract_address)))
      cached.catch(() => this.#contracts.delete(address))
      this.#contracts.set(address, cached)
    }
    return cached
  }

  /**
   * 确认交易过期且没有上链：在同一个节点上先读固化的最新区块（时间要超过过期时间 + 60 秒），再查固化的交易信息。
   * 固化的数据不会回滚、也不会落后于先读到的那个区块；查询出错、节点返回错误时一律当作“不确定”（返回 false）
   */
  async expiredForSure(txId: string, expiration: number): Promise<boolean> {
    try {
      return await runOnNodes(this.rpc, 'walletsolidity', async (any) => {
        const node = tronNode(any)
        const block = await node.request('walletsolidity/getblock', { detail: false }).catch(() => node.request('walletsolidity/getnowblock'))
        const time = block?.block_header?.raw_data?.timestamp
        if (typeof time !== 'number' || time <= expiration + 60_000) return false
        const info = await node.request('walletsolidity/gettransactioninfobyid', { value: txId })
        if (!info || typeof info !== 'object' || 'Error' in info) return false
        return !info.id
      })
    } catch {
      return false
    }
  }

  /** 模拟合约调用：返回消耗的能量；revert 时抛出（带原因） */
  async simulate(c: Extract<TronContract, { type: 'trigger' }>): Promise<number> {
    const body: Record<string, unknown> = { owner_address: toTronHex(c.owner), contract_address: toTronHex(c.contract), data: c.data.replace(/^0x/, '') }
    if (c.callValue) body.call_value = Number(c.callValue)
    const res = await this.request('wallet/triggerconstantcontract', body)
    const result = res?.result ?? {}
    if (result.code || res?.transaction?.ret?.[0]?.ret === 'FAILED' || result.result === false) {
      const output = res?.constant_result?.[0]
      const reason = (output && decodeRevertReason(`0x${output}`)) || (typeof result.message === 'string' ? decodeHex(result.message) : '') || String(result.code ?? 'REVERT')
      throw new TronTxError(`execution reverted: ${reason}`)
    }
    return Number(res?.energy_used ?? 0)
  }

  /** 广播：'accepted'；交易本身的问题抛 TronTxError；节点出错（换了节点也不行）返回说明（交易可能已经发出） */
  async broadcast(signed: Uint8Array): Promise<'accepted' | { uncertain: string }> {
    let res: { result?: boolean; code?: string; message?: string }
    try {
      res = await this.request('wallet/broadcasthex', { transaction: hexlify(signed).slice(2) })
    } catch (err) {
      return { uncertain: `broadcast not acknowledged: ${errorText(err)}` }
    }
    if (res?.result || res?.code === 'DUP_TRANSACTION_ERROR') {
      return 'accepted'
    }
    const message = res?.message ? decodeHex(res.message) : ''
    const text = `${res?.code ?? (res as { Error?: string } | null)?.Error ?? 'unknown response'}${message ? `: ${message}` : ''}`
    // 只有交易本身的问题（签名、合约校验、带宽不够、太大）才确定没发出去。其余（TAPOS 参考区块对不上、节点忙、
    // 未固化等）可能只是这个节点的问题，而前一个超时的节点也许已经收下了这笔：按“不确定”继续跟踪，直到确认过期
    if (res?.code && FINAL_BROADCAST_CODES.has(res.code)) {
      throw new TronTxError(text)
    }
    return { uncertain: `broadcast not acknowledged: ${text}` }
  }

  remember(txId: string): boolean {
    if (this.#recent.has(txId)) return false
    this.#recent.add(txId)
    return true
  }
}

export class TronTxError extends Error {}

function tronNode(node: EthersLikeProvider): TronProvider {
  if (!(node instanceof TronProvider)) throw new Error('Not a Tron node')
  return node
}

/** 确定交易没被收下的广播错误码 */
const FINAL_BROADCAST_CODES = new Set(['SIGERROR', 'CONTRACT_VALIDATE_ERROR', 'CONTRACT_EXE_ERROR', 'BANDWITH_ERROR', 'TOO_BIG_TRANSACTION_ERROR', 'TOO_BIG_TRANSACTION_RESULT_ERROR'])

export function decodeHex(hex: string): string {
  try {
    return toUtf8String(`0x${hex}`)
  } catch {
    return hex
  }
}

/** 签名后交易的字节数（估算带宽）；参考区块等字段长度固定，用占位值即可 */
export function transactionBytes(contract: TronContract, feeLimit: bigint): number {
  const raw = encodeRawData(contract, { number: 2 ** 40, hash: '00'.repeat(32), timestamp: 2 ** 41 }, 2 ** 41, 2 ** 41, contract.type === 'trigger' ? feeLimit : 0n)
  return encodeTransaction(raw, '00'.repeat(65)).length + RESULT_RESERVE
}
