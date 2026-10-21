/**
 * 代币风险检查（子路径 `@w3lib/sui-batch-call/risk`）：Sui 的 Coin 是标准对象，没有转账税、不能在合约里拦截转账，风险主要在发行方的权限：
 * - 监管币（DenyCapV2）：发行方可以冻结地址（被冻结的地址不能再用这个币作交易输入）、可能可以全局暂停
 * - TreasuryCap 在谁手里：在地址 / 对象里 = 可以增发；冻结（不可变）或已转成固定供应 = 不能增发
 * - 元数据（名称、symbol、图标）还能不能改
 * - 能不能卖：用 /swap 在只读调用里买入再卖出（可选）
 * 信息来自节点的 GetCoinInfo（Coin Registry 的 Currency 或旧的 CoinMetadata）和这些对象本身
 */
import { SUI_COIN_TYPE, normalizeStructTag, normalizeSuiAddress } from './address.js'
import type { SuiClient } from './client.js'
import { GrpcError, isNodeFault } from './grpc.js'
import { ProtoWriter, type ProtoMessage } from './proto.js'
import { inspectTransaction, type SuiObject } from './services.js'
import type { SwapOptions } from './swap.js'
import { encodeTransactionData, pure } from './write/bcs.js'
import { PtbBuilder } from './write/ptb.js'

/** 系统的 DenyList 共享对象 */
const DENY_LIST = '0x0000000000000000000000000000000000000000000000000000000000000403'

/** 权限对象（TreasuryCap、DenyCapV2、MetadataCap）在谁手里 */
export interface CapHolder {
  /** 对象 ID */
  id: string
  /**
   * address：地址拥有；object：在别的对象里（如动态字段，root 是最外层的对象）；shared：共享对象；immutable：已冻结（谁都改不了）；
   * burned：转给了 0x0 地址（谁都用不了）；not-found：节点读不到（包在别的对象的字段里，或已删除）
   */
  owner: 'address' | 'object' | 'shared' | 'immutable' | 'consensus-address' | 'burned' | 'not-found' | 'unknown'
  /** 地址拥有时的地址 */
  address: string | null
  /** 在别的对象里时：最外层的对象（ID、类型、它的所有者） */
  root: { id: string; type: string | null; owner: CapHolder['owner']; address: string | null } | null
}

export type SupplyState = 'fixed' | 'burn-only' | 'mintable' | 'unknown'

export interface SellCheck {
  /** ok：买得到也卖得出；no-pool：没有和 SUI（或经过 USDC）的池子；buy-failed：有池子但买不进；sell-failed：买进后卖不出 */
  stage: 'ok' | 'no-pool' | 'buy-failed' | 'sell-failed'
  /** 买入的路线（卖出按原路返回）：每一跳的协议和池子 */
  route: Array<{ protocol: string; pool: string }> | null
  /** 买入用的 SUI、买到的代币、卖回的 SUI（最小单位） */
  amountIn: string
  bought: string | null
  back: string | null
  /** 来回一趟损失的比例（0~1，含两次手续费和价格影响） */
  roundTripLoss: number | null
  error: string | null
}

export interface CoinRisk {
  token: string
  /** 节点认得这个代币（有 CoinMetadata / Currency） */
  exists: boolean
  symbol: string | null
  /** 监管币：发行时创建了 DenyCapV2（或 v1 的 DenyCap），持有者可以冻结地址 */
  regulated: boolean | null
  denyCap: CapHolder | null
  /** 冻结权限还有人能用：DenyCap（或包着它的最外层对象）已冻结 / 转给 0x0 时为 false；不知道 DenyCap 在哪时为 null */
  canFreeze: boolean | null
  /** 冻结权限允许全局暂停（暂停后谁都不能用这个币作交易输入） */
  allowGlobalPause: boolean | null
  /** 当前 epoch 是否在全局暂停中（监管币才查） */
  paused: boolean | null
  /** options.address 在当前 epoch 是否被冻结（监管币且传了 address 才查） */
  denied: boolean | null
  /** 供应：fixed 不能增发（TreasuryCap 已冻结 / 转成固定供应）；burn-only 只能销毁；mintable 有人持有 TreasuryCap；unknown 不知道 TreasuryCap 在哪 */
  supply: SupplyState
  treasuryCap: CapHolder | null
  /** 总供应量（最小单位）；读不到时为 null */
  totalSupply: string | null
  /** 元数据（名称、symbol、描述、图标）还能不能被改；不知道时为 null */
  metadataMutable: boolean | null
  /** 元数据对象：Coin Registry 的 Currency，或旧的 CoinMetadata */
  metadata: { id: string; type: 'currency' | 'coin-metadata' | 'unknown'; owner: CapHolder['owner'] } | null
  /** Coin Registry 的 MetadataCap（拿着它的人可以改元数据） */
  metadataCap: CapHolder | null
  /** 能不能卖（sell: false 时为 null） */
  sell: SellCheck | null
  /** 买得进但卖不出，或来回损失 ≥ 90% */
  honeypot: boolean | null
  /**
   * 汇总的风险标记：not-found、regulated（可以冻结地址）、global-pause（可以全局暂停）、paused、denied、mintable、supply-unknown、
   * mutable-metadata、honeypot、cannot-buy、no-pool、high-round-trip-loss（> 10%）
   */
  flags: string[]
}

export interface CoinRiskOptions {
  /** 检查这个地址有没有被冻结（监管币） */
  address?: string
  /** 模拟买入再卖出检查能不能卖，默认 true（用 /swap 找路线，按需加载） */
  sell?: boolean
  /** 模拟买入用的 SUI（最小单位），默认 0.1 SUI */
  amount?: bigint
  /** 找路线的参数（同 /swap：protocols、pools、intermediates、concurrency） */
  swap?: Omit<SwapOptions, 'signal' | 'slippage'>
  signal?: AbortSignal
}

/** GetCoinInfo 里风险检查要用的字段（sui.rpc.v2：CoinMetadata、CoinTreasury、RegulatedCoinMetadata） */
interface RawCoinInfo {
  symbol: string | null
  metadataId: string | null
  metadataCapId: string | null
  /** 0 未知、1 已领取、2 未领取、3 已删除 */
  metadataCapState: number
  treasuryId: string | null
  totalSupply: bigint | null
  /** 0 未知、1 固定、2 只能销毁 */
  supplyState: number
  /** 0 未知、1 监管、2 不监管 */
  regulatedState: number
  denyCapId: string | null
  allowGlobalPause: boolean | null
}

async function rawCoinInfo(client: SuiClient, coinType: string, signal?: AbortSignal): Promise<RawCoinInfo | null> {
  let m: ProtoMessage
  try {
    m = (await client.transport.unary('sui.rpc.v2.StateService/GetCoinInfo', new ProtoWriter().string(1, coinType).finish(), { signal })).message
  } catch (err) {
    if (err instanceof GrpcError && err.code === 5) return null
    throw err
  }
  const meta = m.message(2)
  const treasury = m.message(3)
  const regulated = m.message(4)
  const id = (s: string | null | undefined) => (s ? normalizeSuiAddress(s) : null)
  return {
    symbol: meta?.string(4) || null,
    metadataId: id(meta?.string(1)),
    metadataCapId: id(meta?.string(7)),
    metadataCapState: meta?.number(8) ?? 0,
    treasuryId: id(treasury?.string(1)),
    totalSupply: treasury?.uint(2) ?? null,
    supplyState: treasury?.number(3) ?? 0,
    regulatedState: regulated?.number(6) ?? 0,
    denyCapId: id(regulated?.string(3)),
    allowGlobalPause: regulated?.has(4) ? regulated.bool(4) : null,
  }
}

const ZERO = normalizeSuiAddress('0x0')
const ownerKind = (o: SuiObject | null): CapHolder['owner'] =>
  !o ? 'not-found' : !o.owner || o.owner.kind === 'unknown' ? 'unknown' : o.owner.kind === 'address' && normalizeSuiAddress(o.owner.address ?? '') === ZERO ? 'burned' : o.owner.kind

const dead = (o: CapHolder['owner'] | undefined) => o === 'immutable' || o === 'burned'
/** 要 &mut 的权限对象（增发、改冻结名单）还有人能用：它和最外层对象都没有冻结、没有转给 0x0 */
const mutableBy = (h: CapHolder) => !dead(h.owner) && !dead(h.root?.owner)
/** 只要 & 的（改元数据、领取 MetadataCap）：冻结的也能用；转给 0x0（或最外层对象转给 0x0）时没人能用；读不到、在冻结的对象里（只能经那个合约）时不知道 */
const readableBy = (h: CapHolder): boolean | null =>
  h.owner === 'burned' || h.root?.owner === 'burned' ? false : h.owner === 'not-found' || h.owner === 'unknown' || h.root?.owner === 'immutable' ? null : true

/** 对象的持有者：在别的对象里时一直往上找到最外层（最多 5 层） */
async function holderOf(client: SuiClient, o: SuiObject | null, id: string, signal?: AbortSignal): Promise<CapHolder> {
  const kind = ownerKind(o)
  const holder: CapHolder = { id, owner: kind, address: kind === 'address' || kind === 'consensus-address' ? (o?.owner?.address ?? null) : null, root: null }
  let current = o
  for (let depth = 0; depth < 5 && current?.owner?.kind === 'object' && current.owner.address; depth++) {
    const [parent] = await client.objects([current.owner.address], { fields: ['type', 'owner'], signal })
    if (!parent) {
      holder.root = { id: normalizeSuiAddress(current.owner.address), type: null, owner: 'not-found', address: null }
      break
    }
    const k = ownerKind(parent)
    holder.root = { id: normalizeSuiAddress(parent.objectId), type: parent.type, owner: k, address: k === 'address' || k === 'consensus-address' ? (parent.owner?.address ?? null) : null }
    current = parent
  }
  return holder
}

/**
 * 全局暂停和地址是否被冻结（当前 epoch）：deny_list 的只读调用。
 * v1（DenyCap）只有地址名单（coin::deny_list_contains），没有全局暂停，paused 为 null
 */
async function denyStatus(client: SuiClient, coinType: string, address: string | undefined, v1: boolean, signal?: AbortSignal): Promise<{ paused: boolean | null; denied: boolean | null }> {
  if (v1 && !address) return { paused: null, denied: null }
  const [list] = await client.objects([DENY_LIST], { fields: ['owner'], signal })
  const version = list?.owner?.initialSharedVersion
  if (version === null || version === undefined) return { paused: null, denied: null }
  const ptb = new PtbBuilder()
  const deny = ptb.object({ kind: 'shared', objectId: DENY_LIST, initialSharedVersion: version, mutable: false })
  if (v1) ptb.moveCall('0x2::coin::deny_list_contains', [coinType], [deny, ptb.pure(pure.address(address as string))])
  else {
    ptb.moveCall('0x2::coin::deny_list_v2_is_global_pause_enabled_current_epoch', [coinType], [deny])
    if (address) ptb.moveCall('0x2::coin::deny_list_v2_contains_current_epoch', [coinType], [deny, ptb.pure(pure.address(address))])
  }
  const sender = normalizeSuiAddress('0x0')
  const bytes = encodeTransactionData({ kind: ptb.build(), sender, gas: { payment: [], owner: sender, price: 1000n, budget: 50_000_000_000n }, expiration: { kind: 'none' } })
  const { result, outputs } = await inspectTransaction(client.transport, bytes, { signal })
  if (!result.success) return { paused: null, denied: null }
  const bool = (v: unknown) => (typeof v === 'boolean' ? v : null)
  if (v1) return { paused: null, denied: bool(outputs[0]?.[0]) }
  return { paused: bool(outputs[0]?.[0]), denied: address ? bool(outputs[1]?.[0]) : null }
}

/**
 * 检查代币的风险（每个代币：GetCoinInfo 一次、读权限对象一两轮；监管币多一次只读调用；sell 时用 /swap 找路线并模拟买入再卖出）。
 *
 * ```ts
 * const [usdc] = await coinRisks(sui, [USDC])
 * // { regulated: true, allowGlobalPause: true, supply: 'mintable', treasuryCap: { owner: 'object', root: { type: '…::treasury::Treasury<…>' } }, flags: ['regulated', 'global-pause', 'mintable', …] }
 * ```
 */
export async function coinRisks(client: SuiClient, coinTypes: readonly string[], options: CoinRiskOptions = {}): Promise<CoinRisk[]> {
  const { signal } = options
  const swapModule = options.sell === false ? null : import('./swap.js')
  const amount = options.amount ?? 100_000_000n
  // 每个代币要找路线、做几十次只读调用：一次最多检查 4 个代币
  return mapPool(coinTypes, 4, async (raw): Promise<CoinRisk> => {
      const token = normalizeStructTag(raw)
      const info = await rawCoinInfo(client, token, signal)
      const ids = [info?.treasuryId, info?.denyCapId, info?.metadataId, info?.metadataCapState === 1 ? info.metadataCapId : null].map((x) => x ?? null)
      const present = ids.filter((id): id is string => id !== null)
      const read = present.length ? await client.objects(present, { fields: ['type', 'owner', 'json'], signal }) : []
      const byId = new Map(present.map((id, i) => [id, read[i] ?? null]))
      const at = (k: number) => (ids[k] ? (byId.get(ids[k] as string) ?? null) : null)
      const holder = (k: number) => (ids[k] ? holderOf(client, at(k), ids[k] as string, signal) : Promise.resolve(null))
      const [treasuryCap, denyCap, metadataCap] = await Promise.all([holder(0), holder(1), holder(3)])

      const regulated = !info ? null : info.regulatedState === 1 || !!info.denyCapId ? true : info.regulatedState === 2 ? false : token === SUI_COIN_TYPE ? false : null
      // v1 的冻结权限是 coin::DenyCap（没有全局暂停），v2 是 DenyCapV2
      const v1 = /^0x0*2::coin::DenyCap</.test(at(1)?.type ?? '')
      const capJson = at(1)?.json as { allow_global_pause?: unknown } | null | undefined
      const allowGlobalPause = !regulated ? (regulated === false ? false : null) : v1 ? false : typeof capJson?.allow_global_pause === 'boolean' ? capJson.allow_global_pause : info?.allowGlobalPause ?? null
      // 改冻结名单要 &mut DenyCap：DenyCap（或包着它的最外层对象）已冻结 / 转给 0x0 时谁都改不了
      const canFreeze = !regulated ? (regulated === false ? false : null) : !denyCap || denyCap.owner === 'not-found' || denyCap.owner === 'unknown' ? null : !mutableBy(denyCap) ? false : true
      const deny = regulated
        ? await denyStatus(client, token, options.address && normalizeSuiAddress(options.address), v1, signal).catch((err: unknown) => {
            if (isNodeFault(err) || signal?.aborted) throw err
            return { paused: null, denied: null }
          })
        : { paused: regulated === false ? false : null, denied: regulated === false && options.address ? false : null }

      // 供应：节点给出的固定 / 只能销毁优先；否则看 TreasuryCap
      let supply: SupplyState = 'unknown'
      if (info?.supplyState === 1 || token === SUI_COIN_TYPE) supply = 'fixed'
      else if (info?.supplyState === 2) supply = 'burn-only'
      // 增发要 &mut TreasuryCap：它（或包着它的最外层对象）已冻结 / 转给 0x0 时不能增发
      else if (treasuryCap) supply = treasuryCap.owner === 'not-found' || treasuryCap.owner === 'unknown' ? 'unknown' : mutableBy(treasuryCap) ? 'mintable' : 'fixed'

      // 元数据：Coin Registry 的 Currency 看 MetadataCap 的状态，旧的 CoinMetadata 看是否冻结；没有冻结时由 TreasuryCap 的持有者修改
      const metaObject = at(2)
      const metaType = /^0x0*2::coin_registry::Currency</.test(metaObject?.type ?? '') ? 'currency' : /^0x0*2::coin::CoinMetadata</.test(metaObject?.type ?? '') ? 'coin-metadata' : 'unknown'
      // 改元数据 / 领取 MetadataCap 只要 &TreasuryCap（冻结的也能用：谁都可以传）；没有 TreasuryCap 时：供应已固定的为不能改，否则不知道
      const byTreasury = treasuryCap ? readableBy(treasuryCap) : supply === 'fixed' || supply === 'burn-only' ? false : null
      let metadataMutable: boolean | null = null
      if (metaType === 'currency') {
        // 已删除：不能改；已领取：MetadataCap 的持有者能改（setter 按引用取它，转给 0x0 才算没人能用）；未领取：TreasuryCap 的持有者可以领取后修改
        metadataMutable = info?.metadataCapState === 3 ? false : info?.metadataCapState === 1 ? (metadataCap ? readableBy(metadataCap) : null) : info?.metadataCapState === 2 ? byTreasury : null
      } else if (metaType === 'coin-metadata') {
        metadataMutable = metaObject?.owner?.kind === 'immutable' ? false : byTreasury
      }

      let sell: SellCheck | null = null
      if (swapModule && token !== SUI_COIN_TYPE) {
        const { roundTrip } = await swapModule
        const r = await roundTrip(client, normalizeSuiAddress(options.address ?? '0x0'), token, amount, { ...options.swap, signal }).catch((err: unknown) => {
          // 节点的问题抛出；其他（如交易构建不出来）当作买不进
          if (isNodeFault(err) || signal?.aborted) throw err
          return { stage: 'buy-failed' as const, route: null, bought: null, back: null, error: err instanceof Error ? err.message : String(err) }
        })
        sell = {
          stage: r.stage,
          route: r.route ? r.route.hops.map((h) => ({ protocol: h.protocol, pool: h.pool })) : null,
          amountIn: amount.toString(),
          bought: r.bought === null ? null : r.bought.toString(),
          back: r.back === null ? null : r.back.toString(),
          roundTripLoss: r.back === null ? null : Math.max(0, 1 - Number(r.back) / Number(amount)),
          error: r.error,
        }
      }
      const honeypot = !sell || sell.stage === 'no-pool' || sell.stage === 'buy-failed' ? null : sell.stage === 'sell-failed' || (sell.roundTripLoss ?? 0) >= 0.9

      const risk: Omit<CoinRisk, 'flags'> = {
        token,
        exists: !!info,
        symbol: token === SUI_COIN_TYPE ? 'SUI' : (info?.symbol ?? null),
        regulated,
        denyCap,
        canFreeze,
        allowGlobalPause,
        paused: deny.paused,
        denied: deny.denied,
        supply,
        treasuryCap,
        totalSupply: info?.totalSupply === null || info?.totalSupply === undefined ? null : info.totalSupply.toString(),
        metadataMutable,
        metadata: ids[2] ? { id: ids[2] as string, type: metaType, owner: ownerKind(metaObject) } : null,
        metadataCap,
        sell,
        honeypot,
      }
      return { ...risk, flags: flagsOf(risk) }
  })
}

/** 并发数为 limit 的 map，结果按输入顺序 */
async function mapPool<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++
        out[i] = await fn(items[i] as T)
      }
    }),
  )
  return out
}

function flagsOf(r: Omit<CoinRisk, 'flags'>): string[] {
  const flags: string[] = []
  if (!r.exists) flags.push('not-found')
  // 冻结权限已经没人能用时不算风险
  if (r.regulated && r.canFreeze !== false) flags.push('regulated')
  if (r.allowGlobalPause && r.canFreeze !== false) flags.push('global-pause')
  if (r.paused) flags.push('paused')
  if (r.denied) flags.push('denied')
  if (r.supply === 'mintable') flags.push('mintable')
  if (r.supply === 'unknown' && r.exists) flags.push('supply-unknown')
  if (r.metadataMutable) flags.push('mutable-metadata')
  if (r.honeypot) flags.push('honeypot')
  if (r.sell?.stage === 'buy-failed') flags.push('cannot-buy')
  if (r.sell?.stage === 'no-pool') flags.push('no-pool')
  if (r.sell?.roundTripLoss !== null && r.sell?.roundTripLoss !== undefined && r.sell.roundTripLoss > 0.1) flags.push('high-round-trip-loss')
  return flags
}
