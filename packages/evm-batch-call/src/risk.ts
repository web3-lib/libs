/**
 * 代币风险检查（子路径 `@w3lib/evm-batch-call/risk`）：在 eth_call 里模拟“买入 → 转账 → 卖出”（deployless 的探测合约，不部署、不发交易），
 * 算出买入税、转账税、卖出税，判断能不能卖（貔貅盘）；另外看合约是不是可升级的代理、owner 有没有放弃。
 * 只能检查在内置 V2 协议里有 代币 / 包装主币 池子的代币；Tron 不支持
 */
import { AbiCoder, Interface, concat } from 'ethers'

import { LP_PROTOCOLS, LP_QUOTE_TOKENS, type LpProtocol } from './lp.js'
import type { Provider } from './provider.js'
import { TOKEN_PROBE_BYTECODE } from './tokenProbe.js'
import { isExecutionError } from './errors.js'
import { isTronChain } from './tron.js'

export type ProbeStage = 'ok' | 'buy-failed' | 'transfer-failed' | 'approve-failed' | 'sell-failed'

export interface TokenRisk {
  token: string
  /** 模拟用的 V2 协议和池子（代币 / 包装主币里包装主币一侧最深的）；没有池子时为 null */
  protocol: string | null
  pool: string | null
  /** 模拟到哪一步：ok 全部成功；buy-failed 买不进（可能还没开放交易、限制了合约地址）；sell-failed 卖不出（貔貅盘） */
  stage: ProbeStage | null
  /** 卖不出，或卖出税 ≥ 90% */
  honeypot: boolean | null
  /** 税率（0~1）：实际数量比 Router 报价少多少；对应的步骤没跑到时为 null */
  buyTax: number | null
  sellTax: number | null
  transferTax: number | null
  /** 买入 / 卖出消耗的 gas（异常高可能有额外逻辑） */
  buyGas: number | null
  sellGas: number | null
  /** EIP-1967 代理的实现合约（可升级：规则以后可以改）；不是代理时为 null */
  implementation: string | null
  /** owner()：没有这个方法时为 null；零地址表示已放弃 */
  owner: string | null
  /** 汇总的风险标记：honeypot、cannot-buy、high-buy-tax / high-sell-tax / high-transfer-tax（> 10%）、has-tax（> 0.5%）、proxy、owned、no-pool */
  flags: string[]
}

export interface TokenRiskOptions {
  /** 模拟买入用的主币数量（最小单位），默认包装主币储备的 1 / 1000，最多 1 个主币 */
  amount?: bigint
  /** 用哪些 V2 协议的池子，默认这条链内置表里有 Router 的 V2 协议 */
  protocols?: readonly LpProtocol[]
}

const coder = AbiCoder.defaultAbiCoder()
const factoryInterface = new Interface(['function getPair(address tokenA, address tokenB) view returns (address)'])
const pairInterface = new Interface(['function token0() view returns (address)', 'function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)'])
const ownerInterface = new Interface(['function owner() view returns (address)'])
/** EIP-1967 的实现合约槽位：bytes32(uint256(keccak256('eip1967.proxy.implementation')) - 1) */
const IMPLEMENTATION_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc'
const STAGES: readonly ProbeStage[] = ['ok', 'buy-failed', 'transfer-failed', 'approve-failed', 'sell-failed']
const ZERO = '0x0000000000000000000000000000000000000000'

type Node = { call(tx: { from?: string; to?: string; data: string; value?: bigint }): Promise<string>; getStorage?(address: string, slot: string): Promise<string> }

/**
 * 检查代币的风险（每个代币一次模拟的 eth_call，加上一次 multicall 找池子、读 owner）。
 *
 * ```ts
 * const [risk] = await tokenRisks(provider, [token])
 * // { stage: 'ok', honeypot: false, buyTax: 0.05, sellTax: 0.05, transferTax: 0, flags: ['has-tax', 'owned'], … }
 * ```
 */
export async function tokenRisks(provider: Provider, tokens: readonly string[], options: TokenRiskOptions = {}): Promise<TokenRisk[]> {
  const chainId = await provider.getChainId()
  if (isTronChain(chainId)) throw new Error('tokenRisks is not supported on Tron')
  const wrapped = LP_QUOTE_TOKENS[chainId]?.[0]
  const protocols = (options.protocols ?? LP_PROTOCOLS.filter((p) => p.chainId === chainId)).filter((p) => p.version === 'v2' && p.router && p.factory)
  if (!wrapped || !protocols.length) throw new Error(`No V2 protocol with a router on chain ${chainId}`)

  // 1. 每个代币在每个 V2 协议里和包装主币的池子，以及 owner()
  const pairCalls = tokens.flatMap((t) => protocols.map((p) => provider.contract(p.factory as string, factoryInterface).getPair(t, wrapped)))
  const ownerCalls = tokens.map((t) => provider.contract(t, ownerInterface).owner())
  const first = await provider.tryAll([...pairCalls, ...ownerCalls])
  const pairs = first.slice(0, pairCalls.length) as Array<string | null>
  const owners = first.slice(pairCalls.length) as Array<string | null>
  const found = pairs.flatMap((pair, i) => (pair && pair.toLowerCase() !== ZERO ? [{ i, pair }] : []))
  const reserves = found.length
    ? await provider.tryAll(found.flatMap(({ pair }) => [provider.contract(pair, pairInterface).token0(), provider.contract(pair, pairInterface).getReserves()]))
    : []
  // 每个代币：包装主币一侧最深的池子
  const best: Array<{ protocol: LpProtocol; pair: string; wrappedReserve: bigint } | null> = tokens.map(() => null)
  found.forEach(({ i, pair }, k) => {
    const token0 = reserves[k * 2] as string | null
    const r = reserves[k * 2 + 1] as { 0: bigint; 1: bigint } | null
    if (!token0 || !r) return
    const wrappedReserve = token0.toLowerCase() === wrapped.toLowerCase() ? r[0] : r[1]
    const t = Math.floor(i / protocols.length)
    const current = best[t]
    if (wrappedReserve > 0n && (!current || wrappedReserve > current.wrappedReserve)) best[t] = { protocol: protocols[i % protocols.length] as LpProtocol, pair, wrappedReserve }
  })

  const { runOnNodes } = await import('./write/rpc.js')
  const node = <T>(method: string, fn: (n: Node) => Promise<T>, isFinal?: (err: unknown) => boolean) => runOnNodes(provider.rpc, method, (n) => fn(n as unknown as Node), isFinal)
  const ONE = 10n ** 18n

  return Promise.all(
    tokens.map(async (token, t): Promise<TokenRisk> => {
      const pick = best[t]
      const owner = owners[t] ?? null
      const implementation = await node('getStorage', (n) => (n.getStorage ? n.getStorage(token, IMPLEMENTATION_SLOT) : Promise.resolve('0x')))
        .then((slot) => (slot && BigInt(slot) !== 0n ? `0x${slot.slice(-40)}` : null))
        .catch(() => null)
      const base = { token, implementation, owner, buyTax: null, sellTax: null, transferTax: null, buyGas: null, sellGas: null }
      if (!pick) return { ...base, protocol: null, pool: null, stage: null, honeypot: null, flags: flagsOf({ ...base, stage: null, honeypot: null }, true) }

      const amount = options.amount ?? min(pick.wrappedReserve / 1000n, ONE)
      // deployless：没有 to 的 eth_call 执行构造函数；从包装主币合约发起（它持有大量主币，eth_call 不需要签名）
      const data = concat([TOKEN_PROBE_BYTECODE, coder.encode(['address', 'address', 'address'], [pick.protocol.router, token, pick.pair])])
      let decoded: bigint[] | null = null
      try {
        // 探测合约自己不会 revert（每一步都 try）；执行出错（如买入时代币合约把调用方拒之门外导致整体 revert）算买不进，
        // 节点、网络、限频的错误照常抛出，不当成代币的风险
        const out = await node('call', (n) => n.call({ from: wrapped, data, value: amount }), isExecutionError)
        decoded = coder.decode(new Array<string>(11).fill('uint256'), out).toArray() as bigint[]
      } catch (err) {
        if (!isExecutionError(err)) throw err
        decoded = null
      }
      if (!decoded) {
        const failed = { ...base, protocol: pick.protocol.id, pool: pick.pair, stage: 'buy-failed' as const, honeypot: null }
        return { ...failed, flags: flagsOf(failed, false) }
      }
      const [stageIndex, buyQuote, bought, transferSent, transferReceived, sellAmount, sellQuote, sold, buyGas, sellGas, pairReceived] = decoded as [bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint]
      const stage = STAGES[Number(stageIndex)] ?? 'buy-failed'
      const tax = (actual: bigint, expected: bigint) => (expected > 0n ? Math.max(0, 1 - Number((actual * 1_000_000n) / expected) / 1_000_000) : null)
      const result = {
        ...base,
        protocol: pick.protocol.id,
        pool: pick.pair,
        stage,
        buyTax: stage === 'buy-failed' ? null : tax(bought, buyQuote),
        transferTax: stage === 'ok' || stage === 'approve-failed' || stage === 'sell-failed' ? tax(transferReceived, transferSent) : null,
        // 卖出税：池子实际收到的代币（转账时扣的税，精确），和实际换回的主币比报价少多少（有的代币卖出时顺便把收来的税也卖进同一个池子，
        // 池子那边看不出来），取较大的
        sellTax: stage === 'ok' ? Math.max(tax(pairReceived, sellAmount) ?? 0, tax(sold, sellQuote) ?? 0) : null,
        buyGas: stage === 'buy-failed' ? null : Number(buyGas),
        sellGas: stage === 'ok' ? Number(sellGas) : null,
        honeypot: stage === 'sell-failed' || stage === 'transfer-failed' || stage === 'approve-failed' ? true : stage === 'ok' ? (tax(sold, sellQuote) ?? 0) >= 0.9 : null,
      }
      return { ...result, flags: flagsOf(result, false) }
    }),
  )
}

const min = (a: bigint, b: bigint) => (a < b ? a : b)

function flagsOf(r: Omit<TokenRisk, 'flags' | 'protocol' | 'pool'>, noPool: boolean): string[] {
  const flags: string[] = []
  if (noPool) flags.push('no-pool')
  if (r.honeypot) flags.push('honeypot')
  if (r.stage === 'buy-failed') flags.push('cannot-buy')
  for (const [name, value] of [
    ['buy', r.buyTax],
    ['sell', r.sellTax],
    ['transfer', r.transferTax],
  ] as const) {
    if (value !== null && value > 0.1) flags.push(`high-${name}-tax`)
  }
  if ([r.buyTax, r.sellTax, r.transferTax].some((v) => v !== null && v > 0.005)) flags.push('has-tax')
  if (r.implementation) flags.push('proxy')
  if (r.owner && r.owner.toLowerCase() !== ZERO) flags.push('owned')
  return flags
}
