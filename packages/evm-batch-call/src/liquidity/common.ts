import { Interface, MaxUint256, ZeroAddress, getAddress, getBigInt, parseUnits, type BigNumberish } from 'ethers'

import { formatUnits } from '../erc20.js'
import { LP_PROTOCOLS, type LpPosition, type LpProtocol, type LpToken, type LpVersion } from '../lp.js'
import { sqrtPriceToPrice, tickToPrice } from '../lpMath.js'
import type { Provider } from '../provider.js'
import { isTronAddress, isTronChain, toEvmAddress, toTronAddress } from '../tron.js'
import type { LiquidityOptions, LiquidityPlan, LiquidityTx, PositionRef } from './types.js'

export const ZERO_ADDRESS = ZeroAddress
export { MAX_UINT128 } from '../lpMath.js'
const MAX_UINT160 = 2n ** 160n - 1n
/** Uniswap 的 Permit2（各 EVM 链上地址相同），V4 的仓位合约通过它收取代币 */
export const PERMIT2_ADDRESS = '0x000000000022D473030F116dDEE9F6B43aC78BA3'
/** Permit2 授权的有效期：30 天（与 Uniswap 网页一致） */
const PERMIT2_EXPIRATION = 30 * 24 * 3600

export const erc20Interface = new Interface([
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
])
const permit2Interface = new Interface([
  'function allowance(address owner, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)',
  'function approve(address token, address spender, uint160 amount, uint48 expiration)',
])

/** 一次构建用到的公共信息 */
export interface Ctx {
  provider: Provider
  chainId: number
  tron: boolean
  /** 0x 格式（ABI 编码用） */
  owner: string
  recipient: string
  slippage: number
  /** 截止时间（秒级时间戳） */
  deadline: number
  options: LiquidityOptions
}

/** 地址统一成 0x 的校验和格式（Tron 的 T 地址先转换） */
export function evm(address: string): string {
  return getAddress(isTronAddress(address) ? toEvmAddress(address) : address)
}

export const same = (a: string, b: string) => evm(a) === evm(b)

/** 输出的地址：Tron 上转成 T 地址 */
export function out(ctx: Pick<Ctx, 'tron'>, address: string): string {
  return ctx.tron ? toTronAddress(address) : address
}

export async function createCtx(provider: Provider, owner: string, options: LiquidityOptions): Promise<Ctx> {
  const chainId = await provider.getChainId()
  const slippage = options.slippage ?? 0.005
  if (!(slippage >= 0 && slippage < 1)) {
    throw new RangeError(`slippage must be in [0, 1): ${slippage}`)
  }
  const seconds = options.deadline ?? 1200
  if (!(seconds > 0)) {
    throw new RangeError(`deadline must be greater than 0: ${seconds}`)
  }
  return {
    provider,
    chainId,
    tron: isTronChain(chainId),
    owner: evm(owner),
    recipient: evm(options.recipient ?? owner),
    slippage,
    deadline: Math.floor(Date.now() / 1000) + Math.floor(seconds),
    options,
  }
}

/** 是否是主币地址（NATIVE_TOKEN / 零地址，或 Provider 配置的主币地址） */
export function isNative(ctx: Ctx, address: string): boolean {
  return evm(address) === ZERO_ADDRESS || ctx.provider.isNativeToken(address) || ctx.provider.isNativeToken(evm(address))
}

/** 代币信息（symbol / 精度）；零地址是 V4 的主币 */
export async function tokenInfo(ctx: Ctx, addresses: readonly string[]): Promise<LpToken[]> {
  const nativeAlias = ctx.provider.isNativeToken(ZERO_ADDRESS) ? undefined : ctx.provider.nativeTokens[0]
  const query = addresses.map((a) => (a === ZERO_ADDRESS && nativeAlias !== undefined ? nativeAlias : a))
  const details = await ctx.provider.tokens(query, { fields: ['symbol', 'decimals'] })
  return addresses.map((address, i) => {
    const d = details[i]
    return { address: out(ctx, address), native: d?.native ?? false, symbol: d?.symbol ?? null, decimals: d?.decimals ?? null }
  })
}

export function fmt(value: bigint, token: LpToken): string | null {
  return token.decimals === null ? null : formatUnits(value, token.decimals)
}

/** 解析输入的数量：amount（最小单位）和 formatted 二选一，都没给时返回 undefined */
export function parseAmount(raw: BigNumberish | undefined, formatted: string | undefined, token: LpToken, name: string): bigint | undefined {
  if (raw !== undefined && formatted !== undefined) {
    throw new Error(`Pass either ${name} or ${name}Formatted, not both`)
  }
  let value: bigint
  if (formatted !== undefined) {
    if (token.decimals === null) {
      throw new Error(`Cannot read the decimals of ${token.address}; pass ${name} in raw units instead of ${name}Formatted`)
    }
    value = parseUnits(formatted, token.decimals)
  } else if (raw !== undefined) {
    value = getBigInt(raw)
  } else {
    return undefined
  }
  if (value < 0n) {
    throw new RangeError(`${name} must not be negative`)
  }
  return value
}

/** 按滑点向下取：value × (1 − slippage) */
export function minus(value: bigint, slippage: number): bigint {
  return (value * (1_000_000n - BigInt(Math.round(slippage * 1e6)))) / 1_000_000n
}

/** 移除的数量：percent（百分数）或 liquidity，二选一，默认全部 */
export function removeAmount(total: bigint, percent: number | undefined, liquidity: BigNumberish | undefined): bigint {
  if (percent !== undefined && liquidity !== undefined) {
    throw new Error('Pass either percent or liquidity, not both')
  }
  if (liquidity !== undefined) {
    const value = getBigInt(liquidity)
    if (value <= 0n || value > total) {
      throw new RangeError(`liquidity must be in (0, ${total}]: ${value}`)
    }
    return value
  }
  const p = percent ?? 100
  if (!(p > 0 && p <= 100)) {
    throw new RangeError(`percent must be in (0, 100]: ${p}`)
  }
  const amount = p === 100 ? total : (total * BigInt(Math.round(p * 10_000))) / 1_000_000n
  if (amount === 0n) {
    throw new RangeError(`${p}% of ${total} rounds to 0`)
  }
  return amount
}

/** 选出协议：自定义的优先，再找内置表 */
function candidates(ctx: Ctx): LpProtocol[] {
  return [...(ctx.options.protocols ?? []).filter((p) => p.chainId === ctx.chainId), ...LP_PROTOCOLS.filter((p) => p.chainId === ctx.chainId)]
}

export function protocolById(ctx: Ctx, protocol: string | LpProtocol): LpProtocol {
  if (typeof protocol !== 'string') {
    if (protocol.chainId !== ctx.chainId) {
      throw new Error(`Protocol ${protocol.id} is on chain ${protocol.chainId}, not ${ctx.chainId}`)
    }
    return protocol
  }
  const found = candidates(ctx).find((p) => p.id === protocol)
  if (!found) {
    throw new Error(`Unknown LP protocol ${protocol} on chain ${ctx.chainId}; pass an LpProtocol object (or options.protocols) for protocols that are not built in`)
  }
  return found
}

/** V3 / V4 仓位所属的协议：按 positionManager 找，没有时按协议 id */
export function concentratedProtocol(ctx: Ctx, ref: PositionRef | LpPosition): LpProtocol {
  const pm = 'positionManager' in ref && ref.positionManager ? evm(ref.positionManager) : null
  if (pm) {
    const fromRef = ref.protocol && typeof ref.protocol !== 'string' ? [ref.protocol] : []
    const found = [...fromRef, ...candidates(ctx)].find((p) => (p.version === 'v3' || p.version === 'v4') && p.positionManager && same(p.positionManager, pm))
    if (!found) {
      throw new Error(`Unknown position manager ${pm} on chain ${ctx.chainId}; pass its LpProtocol in options.protocols`)
    }
    return found
  }
  if (!ref.protocol) {
    throw new Error('position needs positionManager or protocol')
  }
  const found = protocolById(ctx, ref.protocol)
  if (found.version === 'v2') {
    throw new Error(`${found.id} is a V2 protocol; V2 positions are identified by pool`)
  }
  return found
}

/** 仓位是哪个版本：LpPosition 自带；PositionRef 有 tokenId 的看协议，否则是 V2 */
export function positionVersion(ctx: Ctx, ref: PositionRef | LpPosition): LpVersion {
  if ('version' in ref && (ref.version === 'v2' || ref.version === 'v3' || ref.version === 'v4')) {
    return ref.version
  }
  if (!('tokenId' in ref) || ref.tokenId === undefined) {
    if (!ref.pool) {
      throw new Error('position needs pool (V2) or tokenId (V3 / V4)')
    }
    // 传了 V3 / V4 的协议却没有 tokenId：说清楚，不要当成 V2 的池子去读
    if (ref.protocol && (typeof ref.protocol === 'string' ? protocolById(ctx, ref.protocol) : ref.protocol).version !== 'v2') {
      throw new Error('position.tokenId is required for V3 / V4 positions')
    }
    return 'v2'
  }
  return concentratedProtocol(ctx, ref).version
}

export function tokenIdOf(ref: PositionRef | LpPosition): bigint {
  if (!('tokenId' in ref) || ref.tokenId === undefined) {
    throw new Error('position.tokenId is required')
  }
  if (typeof ref.tokenId === 'number' && !Number.isSafeInteger(ref.tokenId)) {
    throw new RangeError(`tokenId ${ref.tokenId} is not a safe integer; pass it as a string or bigint`)
  }
  return getBigInt(ref.tokenId)
}

/**
 * 要求先把额度归零才能改成另一个非零值的代币（chainId:小写地址）。只对它们先 approve 0：
 * 有的代币（如 Ethereum 上的 BNB）反过来不允许 approve 0
 */
const RESET_FIRST = new Set([
  '1:0xdac17f958d2ee523a2206206994597c13d831ec7', // USDT
  '1:0xdd974d5c2e2928dea5f71b9825b8b646686bd200', // KNC（旧版）
])

/** ERC20 授权：额度不够时 approve（USDT 等已有非零额度时先 approve 0）。amount 为 0 的不需要 */
export async function approvals(ctx: Ctx, items: ReadonlyArray<{ token: string; spender: string; amount: bigint }>): Promise<LiquidityTx[]> {
  const needed = items.filter((i) => i.amount > 0n)
  if (!needed.length) {
    return []
  }
  const current = await ctx.provider.all(needed.map((i) => ctx.provider.contract(i.token, erc20Interface).allowance(ctx.owner, i.spender)))
  return needed.flatMap((item, k): LiquidityTx[] => {
    const allowance = (current as bigint[])[k] as bigint
    if (allowance >= item.amount) {
      return []
    }
    const amount = ctx.options.approve === 'max' ? MaxUint256 : item.amount
    const tx = (value: bigint): LiquidityTx => ({
      kind: 'approve',
      to: out(ctx, item.token),
      data: erc20Interface.encodeFunctionData('approve', [item.spender, value]),
      value: '0',
      token: out(ctx, item.token),
      spender: out(ctx, item.spender),
      amount: value.toString(),
    })
    return allowance > 0n && RESET_FIRST.has(`${ctx.chainId}:${item.token.toLowerCase()}`) ? [tx(0n), tx(amount)] : [tx(amount)]
  })
}

/** V4：代币先授权给 Permit2，再在 Permit2 里授权给仓位合约（额度不够或已过期时） */
export async function permit2Approvals(ctx: Ctx, spender: string, items: ReadonlyArray<{ token: string; amount: bigint }>): Promise<LiquidityTx[]> {
  const needed = items.filter((i) => i.amount > 0n)
  if (!needed.length) {
    return []
  }
  const erc20 = await approvals(
    ctx,
    needed.map((i) => ({ token: i.token, spender: PERMIT2_ADDRESS, amount: i.amount })),
  )
  const permits = (await ctx.provider.all(needed.map((i) => ctx.provider.contract(PERMIT2_ADDRESS, permit2Interface).allowance(ctx.owner, i.token, spender)))) as Array<{ 0: bigint; 1: bigint }>
  const now = Math.floor(Date.now() / 1000)
  const permit2 = needed.flatMap((item, k): LiquidityTx[] => {
    const [amount, expiration] = [permits[k]?.[0] ?? 0n, Number(permits[k]?.[1] ?? 0n)]
    // 额度够、并且在交易截止时间之后才过期：不用再授权
    if (amount >= item.amount && expiration >= ctx.deadline) {
      return []
    }
    // 过期重新授权时保留原来更大的额度（如之前授权过无限额度）
    const value = ctx.options.approve === 'max' ? MAX_UINT160 : amount > item.amount ? amount : item.amount
    return [
      {
        kind: 'permit2',
        to: PERMIT2_ADDRESS,
        data: permit2Interface.encodeFunctionData('approve', [item.token, spender, value, Math.max(now, ctx.deadline) + PERMIT2_EXPIRATION]),
        value: '0',
        token: item.token,
        spender,
        amount: value.toString(),
      },
    ]
  })
  return [...erc20, ...permit2]
}

/** 计划里的价格字段（token1 / token0，按精度换算） */
export function priceFields(token0: LpToken, token1: LpToken, sqrtPriceX96: bigint | null, tickLower: number, tickUpper: number) {
  if (token0.decimals === null || token1.decimals === null) {
    return { price: null, priceLower: null, priceUpper: null }
  }
  return {
    price: sqrtPriceX96 ? sqrtPriceToPrice(sqrtPriceX96, token0.decimals, token1.decimals) : null,
    priceLower: tickToPrice(tickLower, token0.decimals, token1.decimals),
    priceUpper: tickToPrice(tickUpper, token0.decimals, token1.decimals),
  }
}

type PlanInput = Omit<LiquidityPlan, 'chainId' | 'owner' | 'recipient' | 'deadline' | 'amount0Formatted' | 'amount1Formatted' | 'fees0Formatted' | 'fees1Formatted' | 'pool'> & {
  pool: string | null
}

/** 补上公共字段、格式化数量 */
export function makePlan(ctx: Ctx, input: PlanInput): LiquidityPlan {
  const { token0, token1 } = input
  return {
    ...input,
    chainId: ctx.chainId,
    pool: input.pool === null || input.version === 'v4' ? input.pool : out(ctx, input.pool),
    owner: out(ctx, ctx.owner),
    recipient: out(ctx, ctx.recipient),
    amount0Formatted: fmt(BigInt(input.amount0), token0),
    amount1Formatted: fmt(BigInt(input.amount1), token1),
    fees0Formatted: fmt(BigInt(input.fees0), token0),
    fees1Formatted: fmt(BigInt(input.fees1), token1),
    deadline: ctx.deadline,
  }
}
