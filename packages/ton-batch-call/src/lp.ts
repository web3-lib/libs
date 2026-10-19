/**
 * LP 仓位（子路径 `@w3lib/ton-batch-call/lp`）：STON.fi v1 / v2、DeDust 的 LP Jetton。
 * 持有的 Jetton 里按主合约的 admin（STON.fi 的 router）和元数据（DeDust）找出候选，再用 router / factory 的
 * get_pool_address 核对池子地址（仿冒的 LP 空投过不了这一步），按 LP 份额 × 储备算出撤出能拿到的数量
 */
import { isValidTonAddress, parseTonAddress, toFriendlyAddress, toRawAddress } from './address.js'
import type { TonClient } from './client.js'
import { NATIVE_TON, TON_DECIMALS } from './constants.js'
import { formatUnits } from './format.js'
import { runGetMethod, type Stack } from './getters.js'
import { isNodeFault } from './http.js'
import type { RequestOptions } from './http.js'
import { beginCell, type Cell } from './write/cell.js'

export type TonLpProtocol = 'stonfi-v1' | 'stonfi-v2' | 'dedust'

export const TON_LP_PROTOCOLS: Readonly<Record<TonLpProtocol, { name: string }>> = {
  'stonfi-v1': { name: 'STON.fi v1' },
  'stonfi-v2': { name: 'STON.fi v2' },
  dedust: { name: 'DeDust' },
}

export const STONFI_V1_ROUTER = '0:779dcc815138d9500e449c5291e7f12738c23d575b5310000f6a253bd607384e'
export const DEDUST_FACTORY = '0:5f0564fb5f604783db57031ce1cf668a88d4d4d6da6de4db222b4b920d6fd800'
/** STON.fi v2 用的 pTON v2.1 */
export const PTON_V2_MASTER = '0:671963027f7f85659ab55b821671688601cdcf1ee674fc7fbbb1a776a18d34a3'
/** STON.fi 的 pTON（代表 TON 的 Jetton）：v1、v2.1 */
export const PTON_MASTERS = new Set(['0:8cdc1d7640ad5ee326527fc1ad0514f468b30dc84b0173f0e155f451b4e11f7c', '0:671963027f7f85659ab55b821671688601cdcf1ee674fc7fbbb1a776a18d34a3'])

/** STON.fi v2 的 router（地址哈希，base64url），2026-10 时的全部；新的 router 用 options.stonfiRouters 加上 */
export const STONFI_V2_ROUTERS: ReadonlySet<string> = new Set([
  '029cNUwqIRapzXMj6622wSUHQMMD5_A2wqGklHdEuU8',
  '0Oo-d6ttR7mbcOqHJZu8-C1NnBuktjir6UkjB-ePHe4',
  '4HmxDAOsq4iO0jH3xOuQyFQPa80kZnxlf4Mt8pSIS4k',
  '4eaBz730cD7tmzkQRgqCxDuFkGSi-H5OQw9YMnXjRvY',
  '4tXllNx1lrLfKMGPDjKtg8_ZySRB1ETs2vEfv8BBm_M',
  '5J3Liduuz8txJi9lwDe2LEjUDFLvLvhh7FvY1ZY3B_E',
  '8Mo4I501yVT4144tzj7VIpXAo3HhlUDixsK_f7ES4yI',
  '8fvo1FPT1LR5bT2GV-8HcyItEj2NymfJ7zrNImb0CXc',
  '9dbLh5Kzv9TG-SCHWBceWT8t_DLh6Hh8enQPkEWg_MM',
  'AU_RgsgyOtAmwuHOrkt9xxQ8GqnejHXYsCCMOwl04DU',
  'Ap9epvTq2fpsNfOjODZSKVT_E296uklfWl_DY0oFXyU',
  'AxBTEzJwvoLub9lNGWPAGGhoQDpPU3BAoNUzqrgFt68',
  'Blfb8NdbSltkDgmAlxJiHcrnzN6eQn3IB3GPTYogS30',
  'CRuacmT1hIkIjFSXX-2w0YES84OkEee6inkbDqzDvp0',
  'E7zvwV35BaHDl4Zb3tNRGX7IshY6FftJPQi5qYMLc1Y',
  'EGG529RBitFm_JpN7xFuL2x08r-3DnHyZT1kPO_-v6k',
  'IBERebb6zZ9ADNka675PjLrRj-tGS-9GyT7qrwkxmPs',
  'Ii1eu-wYBzVxFLgydwsPCuVjoiUjvOsYfGEKti7YSRI',
  'Ir9yLsWAOmRhLpzoGUk7jAc26Y8EW1sNPflrBPoqiig',
  'LGuaf1FsVA2lPZ_W6NwgL9sUTazRY2nYZu9CUAHrHVY',
  'M9Q9GVIhv_Vwso6ydfsU8fgp5p0NydyzCkO7GU6_l5Q',
  'Mg-zvAr1XUfABCXK_enxyNYnxattUvEDLdXM4uSHyT8',
  'MmNpQUOkbFXvPAik5nh9wVlrFAlru7oEDWn-ZMCw2AI',
  'QpdSQDZE6TKSfTd5WZLTzKadm7UXtr1cB6J9JWvIm0Y',
  'QrZTe2cveqsft8h9GIuFdEjbUPvEW4WGjbOuTAuB8H4',
  'UBKyYtAx4CmLHiB7a0JODeQkCwq912MJECBMNBzbOO8',
  'UP1AUL0fa8lIyg8Io7aIssoGtlpfsiZumPIJdJPhw4c',
  'UjV_-ZkopAVbbVoSGiG9H_IyVO3y-pL8shVaaXe3VkQ',
  'WY-54VzYQeDva0Qp-KhkvNg2Wj1D5cjNpOma270NY9w',
  'Xfb31n5-jDqgWBBGBXshapYjmJZ9c5xZJX6fAdNs5Us',
  'YoDJ22ODVNbsHb83q7VeZr_8iO9vNkfn31u12RVjxFU',
  'Yyv5I2OUfw6Mk0X39dPVcxa0pShQgv4DjliDLchLwnI',
  'YzOwdjymvNiDyq1BWzBWinkAxRkzEZ672NU5qbQuysc',
  'aoAk3a7UqHe-lK3DngC0oiwqd1rjSBUAUL8o45UDL8A',
  'c5KgDeFYmHUtuJQ9nxT3vKHR59q1JHzGGxCfPBASgQE',
  'cKQRhAG_jYI1MaZgEQIFZfAuBf-RrF8Wd3abANas0Ho',
  'cgAy-UWtnZXazEgXLYH0ptl9ltT-tTVVtkWA2_HiTSQ',
  'g0_XQk-dqXX7CzVtHuqj-U93IKuzOFIO9s5BmID9e7Y',
  'gnTZo-EGzY64PzzPiSRPgfX_3M1y5GJqzuz_VJAOrbc',
  'kYMLhWz0Ue0xqHZCcG44gbTbW9IX8ySJYlfuZGOpSq8',
  'kuFBGuVGiS8zssionqkDkNj_TPu5F6ZDuR5z9wb9udE',
  'oaETqblDOHKTeiEc6jU65D_YlWR2KB4MTAAQ1VNvL5U',
  'os--BQldpWJbxTxGIS9yapfFsCDu0L272E_i0B9EprQ',
  'osqaAVjSBD5WqwadOFHj8hI-cx9GQx8bkTaidVkMdxQ',
  'qbmLaueZ4ZMGA5i-Dlo7K3WMvN4I-f-PZzUUOQqzzs0',
  'sZGFUHH1ysPbifjDLbrb0dgrtA1QmRXyzQaejcF4DvI',
  'sdBwyfw8S8Q0kMn7BKhyPEbOuZ8oL3Zng_UWu62NeTk',
  'uu6NvtlM0dXCRa1Bi-TOzgJy4BvKGP7R2k4Bpkety0A',
  'wD8nuxwDwAJeFl6c-YzgnYX9h_YfUJJM0UPuiubrIrk',
  'wWFI-ShD1EK24-3Wu-NlGCSHk_UFOQtnSrItdknUN8o',
])
/** 地址哈希（base64url），STONFI_V2_ROUTERS 的键 */
export const hashKey = (raw: string) => {
  const a = parseTonAddress(raw)
  if (!a || a.workchain !== 0) return ''
  let s = ''
  for (const b of a.hash) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

// ---------------------------------------------------------------------------
// 价格源
// ---------------------------------------------------------------------------

export interface TonPriceSource {
  readonly name: string
  /** 返回代币（NATIVE_TON 或 Jetton 主合约的原始地址） → 美元价格 */
  prices(ctx: { tokens: readonly string[]; fetch: typeof fetch; signal?: AbortSignal }): Promise<Map<string, number>>
}

/** DefiLlama 价格（免费免 Key）；confidence 低于 minConfidence（默认 0.9）的价格不用 */
export function defillamaPrices(options: { minConfidence?: number } = {}): TonPriceSource {
  const minConfidence = options.minConfidence ?? 0.9
  return {
    name: 'defillama',
    async prices({ tokens, fetch: fetchFn, signal }) {
      const result = new Map<string, number>()
      const keyOf = (t: string) => (t === NATIVE_TON ? 'coingecko:the-open-network' : `ton:${toFriendlyAddress(t)}`)
      const back = new Map(tokens.map((t) => [keyOf(t), t]))
      const keys = [...back.keys()]
      for (let i = 0; i < keys.length; i += 50) {
        const res = await fetchFn(`https://coins.llama.fi/prices/current/${keys.slice(i, i + 50).map(encodeURIComponent).join(',')}`, { signal })
        if (!res.ok) throw new Error(`DefiLlama prices: HTTP ${res.status}`)
        const body = (await res.json()) as { coins?: Record<string, { price?: number; confidence?: number }> }
        for (const [key, coin] of Object.entries(body.coins ?? {})) {
          const token = back.get(key)
          if (token && typeof coin.price === 'number' && Number.isFinite(coin.price) && (coin.confidence === undefined || coin.confidence >= minConfidence)) result.set(token, coin.price)
        }
      }
      return result
    },
  }
}

// ---------------------------------------------------------------------------
// 结果
// ---------------------------------------------------------------------------

export interface TonLpToken {
  /** NATIVE_TON（'TON'，STON.fi 的 pTON 也显示为 TON）或 Jetton 主合约地址（用户友好格式） */
  address: string
  symbol: string | null
  decimals: number
  /** 精度未知：Jetton 的元数据在链下、索引器还没读到，decimals 暂按 9（Formatted 字段不可信） */
  decimalsUnknown?: true
}

export interface TonLpPosition {
  type: 'amm'
  protocol: TonLpProtocol
  protocolName: string
  /** 池子地址（也是 LP Jetton 的主合约） */
  pool: string
  /** 持有者的 LP Jetton 钱包 */
  lpWallet: string
  token0: TonLpToken
  token1: TonLpToken
  /** 持有的 LP 数量和 LP 总量（最小单位） */
  balance: string
  totalSupply: string
  /** 份额（0~1，浮点数） */
  share: number
  /** 撤出全部 LP 能拿到的数量（最小单位，向下取整） */
  amount0: string
  amount1: string
  amount0Formatted: string
  amount1Formatted: string
  /** 池子储备 */
  reserve0: string
  reserve1: string
  /** 交易手续费（万分之一，25 = 0.25%）；读不到时为 null */
  feeBps: number | null
  /** STON.fi v2 的池子类型（constant_product / stableswap …）；DeDust 为 'volatile' / 'stable' */
  poolType: string | null
  /** 开启 prices 时：两种代币的美元价值（数量不为 0 的代币没有价格时为 null） */
  valueUsd?: number | null
}

export interface LpPositionsOptions extends RequestOptions {
  protocols?: readonly TonLpProtocol[]
  /** 返回 LP 余额为 0 的仓位（Jetton 钱包还在），默认 false */
  includeClosed?: boolean
  /** 额外认可的 STON.fi v2 router（新部署的 router 还不在内置列表里时） */
  stonfiRouters?: readonly string[]
  prices?: boolean | TonPriceSource
  onPriceError?: (err: unknown) => void
  fetch?: typeof fetch
}

interface MasterRow {
  address: string
  total_supply?: string
  admin_address?: string | null
  jetton_content?: { uri?: string } | null
}

interface RawPool {
  protocol: TonLpProtocol
  pool: string
  /** STON.fi：router 的 Jetton 钱包（之后换成主合约）；DeDust：资产（主合约或 TON） */
  token0: string
  token1: string
  reserve0: bigint
  reserve1: bigint
  totalSupply: bigint
  feeBps: number | null
  poolType: string | null
  router: string | null
}

const sliceOf = (address: string) => beginCell().storeAddress(address).endCell()

/** DeDust 的资产：native$0000 / jetton$0001 workchain:int8 address:uint256 */
function dedustAsset(cell: Cell): string {
  const s = cell.beginParse()
  const type = s.loadUintNumber(4)
  if (type === 0) return NATIVE_TON
  if (type !== 1) throw new Error(`Unsupported DeDust asset type ${type}`)
  const wc = Number(s.loadInt(8))
  return `${wc}:${[...s.loadBytes(32)].map((b) => b.toString(16).padStart(2, '0')).join('')}`
}

async function readPool(client: TonClient, protocol: TonLpProtocol, pool: string, routers: Set<string>, signal?: AbortSignal): Promise<RawPool | null> {
  const t = client.transport
  const opts = { signal }
  if (protocol === 'stonfi-v2') {
    const s = await runGetMethod(t, pool, 'get_pool_data', [], opts)
    s.num() // is_locked
    const router = s.address() as string
    if (!routers.has(hashKey(router))) return null
    const totalSupply = s.num()
    const [reserve0, reserve1] = [s.num(), s.num()]
    const [w0, w1] = [s.address() as string, s.address() as string]
    const lpFee = Number(s.num())
    const protocolFee = Number(s.num())
    const check = await runGetMethod(t, router, 'get_pool_address', [{ type: 'slice', cell: sliceOf(w0) }, { type: 'slice', cell: sliceOf(w1) }], opts)
    if (check.address() !== toRawAddress(pool)) return null
    const poolType = await runGetMethod(t, pool, 'get_pool_type', [], opts).then((x: Stack) => x.string()).catch(() => null)
    // v2 的手续费以万分之一计（lp_fee + protocol_fee，如 20 + 10 = 0.3%）
    return { protocol, pool, token0: w0, token1: w1, reserve0, reserve1, totalSupply, feeBps: lpFee + protocolFee, poolType, router }
  }
  if (protocol === 'stonfi-v1') {
    const s = await runGetMethod(t, pool, 'get_pool_data', [], opts)
    const [reserve0, reserve1] = [s.num(), s.num()]
    const [w0, w1] = [s.address() as string, s.address() as string]
    const lpFee = Number(s.num())
    const protocolFee = Number(s.num())
    s.num() // ref_fee：从协议手续费里分给推荐人，不另外收
    const check = await runGetMethod(t, STONFI_V1_ROUTER, 'get_pool_address', [{ type: 'slice', cell: sliceOf(w0) }, { type: 'slice', cell: sliceOf(w1) }], opts)
    if (check.address() !== toRawAddress(pool)) return null
    // v1 的手续费以万分之一计
    // 总量和储备都从链上读（索引器的总量可能落后）
    const totalSupply = (await runGetMethod(t, pool, 'get_jetton_data', [], opts)).num()
    return { protocol, pool, token0: w0, token1: w1, reserve0, reserve1, totalSupply, feeBps: lpFee + protocolFee, poolType: 'constant_product', router: STONFI_V1_ROUTER }
  }
  const assets = await runGetMethod(t, pool, 'get_assets', [], opts)
  const [c0, c1] = [assets.cell(), assets.cell()]
  const stable = Number((await runGetMethod(t, pool, 'is_stable', [], opts)).num())
  const check = await runGetMethod(t, DEDUST_FACTORY, 'get_pool_address', [{ type: 'num', value: stable }, { type: 'slice', cell: c0 }, { type: 'slice', cell: c1 }], opts)
  if (check.address() !== toRawAddress(pool)) return null
  const reserves = await runGetMethod(t, pool, 'get_reserves', [], opts)
  const [reserve0, reserve1] = [reserves.num(), reserves.num()]
  const fee = await runGetMethod(t, pool, 'get_trade_fee', [], opts).catch(() => null)
  const feeBps = fee ? Math.round((Number(fee.num()) / Number(fee.num())) * 10_000) : null
  const totalSupply = (await runGetMethod(t, pool, 'get_jetton_data', [], opts)).num()
  return { protocol, pool, token0: dedustAsset(c0), token1: dedustAsset(c1), reserve0, reserve1, totalSupply, feeBps, poolType: stable ? 'stable' : 'volatile', router: null }
}

/**
 * 地址的 LP 仓位。toncenter 没有 API Key 时每秒 1 次请求，每个池子要 2~5 个 get 方法调用，池子多时较慢
 *
 * ```ts
 * import { lpPositions } from '@w3lib/ton-batch-call/lp'
 * await lpPositions(ton, owner, { prices: true })
 * ```
 */
export async function lpPositions(client: TonClient, owner: string, options: LpPositionsOptions = {}): Promise<TonLpPosition[]> {
  const { signal } = options
  if (!isValidTonAddress(owner)) throw new Error(`Invalid TON address: ${owner}`)
  const protocols = new Set(options.protocols ?? (Object.keys(TON_LP_PROTOCOLS) as TonLpProtocol[]))
  const routers = new Set([...STONFI_V2_ROUTERS, ...(options.stonfiRouters ?? []).map((r) => hashKey(toRawAddress(r)))])
  // 持有的 Jetton；includeClosed 时连余额为 0 的 Jetton 钱包也要
  const held: Array<{ token: string; wallet: string; balance: string }> = []
  for (let offset = 0; ; offset += 1000) {
    const res = await client.transport.get<{ jetton_wallets?: Array<{ address: string; jetton: string; balance: string }> }>(
      'jetton/wallets',
      { owner_address: [toRawAddress(owner)], exclude_zero_balance: options.includeClosed ? undefined : true, limit: 1000, offset },
      { signal },
    )
    const page = res.jetton_wallets ?? []
    for (const w of page) held.push({ token: w.jetton, wallet: toFriendlyAddress(w.address), balance: w.balance })
    if (page.length < 1000) break
  }
  if (!held.length) return []

  // 主合约的 admin（STON.fi 是 router）、元数据 URI（DeDust）、总量
  const masters = new Map<string, MasterRow>()
  const rawHeld = held.map((b) => toRawAddress(b.token))
  for (let i = 0; i < rawHeld.length; i += 100) {
    const res = await client.transport.get<{ jetton_masters?: MasterRow[] }>('jetton/masters', { address: rawHeld.slice(i, i + 100), limit: 100 }, { signal })
    for (const m of res.jetton_masters ?? []) masters.set(toRawAddress(m.address), m)
  }
  const candidates = held.flatMap((b, i) => {
    const raw = rawHeld[i] as string
    const m = masters.get(raw)
    const admin = m?.admin_address ? toRawAddress(m.admin_address) : null
    const protocol: TonLpProtocol | null =
      admin === STONFI_V1_ROUTER ? 'stonfi-v1' : admin && routers.has(hashKey(admin)) ? 'stonfi-v2' : !admin && m?.jetton_content?.uri?.startsWith('https://api.dedust.io/') ? 'dedust' : null
    return protocol && protocols.has(protocol) ? [{ protocol, pool: raw, balance: BigInt(b.balance), lpWallet: b.wallet }] : []
  })
  if (!candidates.length) return []
  const pools: Array<RawPool | null> = []
  for (const c of candidates) {
    pools.push(
      // 不是池子（get 方法不存在 / 出错）的跳过；节点问题（限频、超时等）直接抛出，不悄悄少返回仓位
      await readPool(client, c.protocol, c.pool, routers, signal).catch((err: unknown) => {
        if (signal?.aborted || isNodeFault(err)) throw err
        return null
      }),
    )
  }
  // STON.fi 的 token 是 router 的 Jetton 钱包：换成主合约（pTON → TON）
  const wallets = [...new Set(pools.flatMap((p) => (p && p.protocol !== 'dedust' ? [p.token0, p.token1] : [])))]
  const masterOf = new Map<string, string>()
  for (let i = 0; i < wallets.length; i += 100) {
    const res = await client.transport.get<{ jetton_wallets?: Array<{ address: string; jetton: string }> }>('jetton/wallets', { address: wallets.slice(i, i + 100), limit: 100 }, { signal })
    for (const w of res.jetton_wallets ?? []) {
      const jetton = toRawAddress(w.jetton)
      masterOf.set(toRawAddress(w.address), PTON_MASTERS.has(jetton) ? NATIVE_TON : jetton)
    }
  }
  const resolved = candidates.flatMap((c, i) => {
    const p = pools[i]
    if (!p) return []
    const t0 = p.protocol === 'dedust' ? p.token0 : masterOf.get(p.token0)
    const t1 = p.protocol === 'dedust' ? p.token1 : masterOf.get(p.token1)
    const supply = p.totalSupply
    if (!t0 || !t1) return []
    return [{ c, p, t0, t1, supply }]
  })
  const jettonTokens = [...new Set(resolved.flatMap((r) => [r.t0, r.t1]).filter((t) => t !== NATIVE_TON))]
  const priceSource = options.prices === true ? defillamaPrices() : options.prices || null
  const fetchFn = options.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args))
  const loadPrices = async () => {
    if (!priceSource) return new Map<string, number>()
    try {
      return await priceSource.prices({ tokens: [NATIVE_TON, ...jettonTokens], fetch: fetchFn, signal })
    } catch (err) {
      if (signal?.aborted) throw err
      try {
        options.onPriceError?.(err)
      } catch {
        // 回调出错不影响结果
      }
      return new Map<string, number>()
    }
  }
  const [details, priceMap] = await Promise.all([jettonTokens.length ? client.jettons(jettonTokens, { signal }) : Promise.resolve([]), loadPrices()])
  const meta = new Map(details.map((d) => [toRawAddress(d.address), d]))
  const token = (t: string): TonLpToken =>
    t === NATIVE_TON
      ? { address: NATIVE_TON, symbol: 'TON', decimals: TON_DECIMALS }
      : { address: toFriendlyAddress(t), symbol: meta.get(t)?.symbol ?? null, decimals: meta.get(t)?.decimals ?? TON_DECIMALS, ...(meta.get(t)?.decimalsUnknown ? { decimalsUnknown: true as const } : {}) }

  const list = resolved.map(({ c, p, t0, t1, supply }): TonLpPosition => {
    const token0 = token(t0)
    const token1 = token(t1)
    const amount0 = supply > 0n ? (c.balance * p.reserve0) / supply : 0n
    const amount1 = supply > 0n ? (c.balance * p.reserve1) / supply : 0n
    const out: TonLpPosition = {
      type: 'amm',
      protocol: p.protocol,
      protocolName: TON_LP_PROTOCOLS[p.protocol].name,
      pool: toFriendlyAddress(p.pool),
      lpWallet: c.lpWallet,
      token0,
      token1,
      balance: c.balance.toString(),
      totalSupply: supply.toString(),
      share: supply > 0n ? Number(c.balance) / Number(supply) : 0,
      amount0: amount0.toString(),
      amount1: amount1.toString(),
      amount0Formatted: formatUnits(amount0, token0.decimals),
      amount1Formatted: formatUnits(amount1, token1.decimals),
      reserve0: p.reserve0.toString(),
      reserve1: p.reserve1.toString(),
      feeBps: p.feeBps,
      poolType: p.poolType,
    }
    if (priceSource) {
      const usd = (t: string, formatted: string, amount: bigint) => {
        if (amount === 0n) return 0
        const price = priceMap.get(t)
        return price === undefined ? null : Number(formatted) * price
      }
      const v0 = usd(t0, out.amount0Formatted, amount0)
      const v1 = usd(t1, out.amount1Formatted, amount1)
      out.valueUsd = v0 === null || v1 === null ? null : v0 + v1
    }
    return out
  })
  return priceSource ? list.sort((a, b) => (b.valueUsd ?? -1) - (a.valueUsd ?? -1)) : list
}
