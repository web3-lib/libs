import type { CallOverrides } from './aggregate.js'
import type { Call } from './call.js'
import { formatUnits } from './erc20.js'
import { getAmountsForLiquidity, getFeeGrowthInside, getFeesEarned, getSqrtRatioAtTick, sqrtPriceToPrice, tickToPrice } from './lpMath.js'
import { v4Positions, type LpV4Options } from './lpV4.js'
import { defillamaPrices, type PriceSource, type TokenSource } from './owner.js'
import type { Provider } from './provider.js'
import { TRON_CHAIN_ID, isTronAddress, isTronChain, toEvmAddress, toTronAddress } from './tron.js'
import { withSignal } from './util.js'

// ---------------------------------------------------------------------------
// 协议表
// ---------------------------------------------------------------------------

export type LpVersion = 'v2' | 'v3' | 'v4'

/** 一个 DEX 在一条链上的部署 */
export interface LpProtocol {
  /** 协议 id，如 'uniswap-v3'、'pancakeswap-v2' */
  id: string
  /** 显示名，如 'Uniswap V3' */
  name: string
  version: LpVersion
  chainId: number
  /** V2：工厂合约（getPair、识别 LP 代币属于哪个协议）；V3：池子的工厂合约（getPool） */
  factory?: string
  /** V3 / V4：仓位 NFT 合约（NonfungiblePositionManager / PositionManager） */
  positionManager?: string
  /** V4：StateView（读池子和仓位的状态） */
  stateView?: string
  /** V4：仓位合约的部署区块（深度扫描 Transfer 事件的默认起点；不知道时为 undefined） */
  deployBlock?: number
}

const v2 = (id: string, name: string, chainId: number, factory: string): LpProtocol => ({ id, name, version: 'v2', chainId, factory })
const v3 = (id: string, name: string, chainId: number, positionManager: string, factory: string): LpProtocol => ({ id, name, version: 'v3', chainId, positionManager, factory })
const v4 = (chainId: number, positionManager: string, stateView: string, deployBlock?: number): LpProtocol => ({
  id: 'uniswap-v4',
  name: 'Uniswap V4',
  version: 'v4',
  chainId,
  positionManager,
  stateView,
  ...(deployBlock !== undefined ? { deployBlock } : {}),
})

const UNI_V3_NPM = '0xC36442b4a4522E871399CD717aBDD847Ab11FE88'
const UNI_V3_FACTORY = '0x1F98431c8aD98523631AE4a59f267346ea31F984'
const CAKE_V3_NPM = '0x46A15B0b27311cedF172AB29E4f4766fbE7F4364'
const CAKE_V3_FACTORY = '0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865'
const SUSHI_V2_FACTORY = '0xc35DADB65012eC5796536bD9864eD8773aBc74C4'

/**
 * 内置的 DEX 部署（2026-10 在链上逐个核对：V3 的 name / factory、V2 的 allPairsLength）。
 * 不在表里的 DEX / 链可以通过 `protocols` 选项传入自己的 LpProtocol。
 */
export const LP_PROTOCOLS: readonly LpProtocol[] = [
  // Ethereum
  v2('uniswap-v2', 'Uniswap V2', 1, '0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f'),
  v2('sushiswap-v2', 'SushiSwap', 1, '0xC0AEe478e3658e2610c5F7A4A2E1777cE9e4f2Ac'),
  v2('pancakeswap-v2', 'PancakeSwap V2', 1, '0x1097053Fd2ea711dad45caCcc45EfF7548fCB362'),
  v3('uniswap-v3', 'Uniswap V3', 1, UNI_V3_NPM, UNI_V3_FACTORY),
  v3('pancakeswap-v3', 'PancakeSwap V3', 1, CAKE_V3_NPM, CAKE_V3_FACTORY),
  // BSC
  v2('pancakeswap-v2', 'PancakeSwap V2', 56, '0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73'),
  v2('uniswap-v2', 'Uniswap V2', 56, '0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6'),
  v2('sushiswap-v2', 'SushiSwap', 56, SUSHI_V2_FACTORY),
  v3('pancakeswap-v3', 'PancakeSwap V3', 56, CAKE_V3_NPM, CAKE_V3_FACTORY),
  v3('uniswap-v3', 'Uniswap V3', 56, '0x7b8A01B39D58278b5DE7e48c8449c9f4F5170613', '0xdB1d10011AD0Ff90774D0C6Bb92e5C5c8b4461F7'),
  // Base
  v2('uniswap-v2', 'Uniswap V2', 8453, '0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6'),
  v2('pancakeswap-v2', 'PancakeSwap V2', 8453, '0x02a84c1b3BBD7401a5f7fa98a384EBC70bB5749E'),
  v3('uniswap-v3', 'Uniswap V3', 8453, '0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1', '0x33128a8fC17869897dcE68Ed026d694621f6FDfD'),
  v3('pancakeswap-v3', 'PancakeSwap V3', 8453, CAKE_V3_NPM, CAKE_V3_FACTORY),
  // Arbitrum
  v2('uniswap-v2', 'Uniswap V2', 42161, '0xf1D7CC64Fb4452F05c498126312eBE29f30Fbcf9'),
  v2('sushiswap-v2', 'SushiSwap', 42161, SUSHI_V2_FACTORY),
  v2('pancakeswap-v2', 'PancakeSwap V2', 42161, '0x02a84c1b3BBD7401a5f7fa98a384EBC70bB5749E'),
  v3('uniswap-v3', 'Uniswap V3', 42161, UNI_V3_NPM, UNI_V3_FACTORY),
  v3('pancakeswap-v3', 'PancakeSwap V3', 42161, CAKE_V3_NPM, CAKE_V3_FACTORY),
  // Optimism
  v2('uniswap-v2', 'Uniswap V2', 10, '0x0c3c1c532F1e39EdF36BE9Fe0bE1410313E074Bf'),
  v3('uniswap-v3', 'Uniswap V3', 10, UNI_V3_NPM, UNI_V3_FACTORY),
  // Polygon
  v2('uniswap-v2', 'Uniswap V2', 137, '0x9e5A52f57b3038F1B8EeE45F28b3C1967e22799C'),
  v2('sushiswap-v2', 'SushiSwap', 137, SUSHI_V2_FACTORY),
  v3('uniswap-v3', 'Uniswap V3', 137, UNI_V3_NPM, UNI_V3_FACTORY),
  // Avalanche
  v3('uniswap-v3', 'Uniswap V3', 43114, '0x655C406EBFa14EE2006250925e54ec43AD184f8B', '0x740b1c1de25031C31FF4fC9A62f554A55cdC1baD'),
  // Uniswap V4（PositionManager / StateView 在链上核对过：name、poolManager 一致）
  v4(1, '0xbd216513d74c8cf14cf4747e6aaa6420ff64ee9e', '0x7ffe42c4a5deea5b0fec41c94c136cf115597227', 21689089),
  v4(56, '0x7a4a5c919ae2541aed11041a1aeee68f1287f95b', '0xd13dd3d6e93f276fafc9db9e6bb47c1180aee0c4', 45970613),
  v4(8453, '0x7c5f5a4bbd8fd63184577525326123b519429bdc', '0xa3c0c9b65bad0b08107aa264b0f3db444b867a71', 25350993),
  v4(42161, '0xd88f38f930b7952f2db2432cb002e7abbf3dd869', '0x76fd297e2d437cd7f76d50f01afe6160f86e9990', 297842893),
  v4(10, '0x3c3ea4b57a46241e54610e5f022e5c45859a1017', '0xc18a3169788f4f75a170290584eca6395c75ecdb', 130947681),
  v4(137, '0x1ec2ebf4f37e7363fdfe3551602425af0b3ceef9', '0x5ea1bd7974c8a611cbab0bdcafcb1d9cc9b3ba5a', 66980394),
  // Tron：SunSwap（V2 工厂的 allPairsLength、V3 仓位合约的 name / factory 在链上核对过）
  v2('sunswap-v2', 'SunSwap V2', TRON_CHAIN_ID.mainnet, 'TKWJdrQkqHisa1X8HUdHEfREvTzw4pMAaY'),
  v3('sunswap-v3', 'SunSwap V3', TRON_CHAIN_ID.mainnet, 'TLSWrv7eC1AZCXkRjpqMZUmvgd99cj7pPF', 'TThJt8zaJzJMhCEScH7zWKnp5buVZqys9x'),
]

/**
 * 各链常见的计价币：查 V2 LP 时，用“传入的代币 × 计价币”（以及计价币之间）在工厂合约里查池子。
 * 主流池子几乎都有一边是这些币
 */
export const LP_QUOTE_TOKENS: Readonly<Record<number, readonly string[]>> = {
  1: [
    '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', // WETH
    '0xdAC17F958D2ee523a2206206994597C13D831ec7', // USDT
    '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', // USDC
    '0x6B175474E89094C44Da98b954EedeAC495271d0F', // DAI
  ],
  56: [
    '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c', // WBNB
    '0x55d398326f99059fF775485246999027B3197955', // USDT
    '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', // USDC
    '0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56', // BUSD
  ],
  8453: [
    '0x4200000000000000000000000000000000000006', // WETH
    '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', // USDC
  ],
  42161: [
    '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', // WETH
    '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', // USDC
    '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', // USDT
  ],
  10: [
    '0x4200000000000000000000000000000000000006', // WETH
    '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85', // USDC
    '0x94b008aA00579c1307B0EF2c499aD98a8ce58e58', // USDT
  ],
  137: [
    '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270', // WPOL
    '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', // USDC
    '0xc2132D05D31c914a87C6611C10748AEb04B58e8F', // USDT
  ],
  43114: [
    '0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7', // WAVAX
    '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E', // USDC
  ],
  [TRON_CHAIN_ID.mainnet]: [
    'TNUC9Qb1rRpS5CbWLmNMxXBjyFoydXjWFR', // WTRX
    'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', // USDT
    'TPYmHEhy5n8TCEfYGqW2rPxsghSfzghPDn', // USDD
    'TSSMHYeV2uE9qYH95DqyoCuNCzEL1NvU3S', // SUN
  ],
}

// ---------------------------------------------------------------------------
// 结果类型
// ---------------------------------------------------------------------------

export interface LpToken {
  address: string
  /** 是否是主币（V4 的池子可以直接用主币，地址为零地址） */
  native: boolean
  symbol: string | null
  /** 读不到精度时为 null（这时 formatted 字段也为 null） */
  decimals: number | null
}

interface LpPositionBase {
  chainId: number
  /** 协议 id，如 'uniswap-v3'；工厂不在协议表里的 V2 LP 为 'v2:<工厂地址>'（Tron 上是 T 地址；读不到工厂时为 'v2:unknown'） */
  protocol: string
  /** 协议显示名，如 'Uniswap V3'；不认识的 V2 工厂为 'Unknown V2' */
  protocolName: string
  /** 池子地址（V4 为 poolId） */
  pool: string
  token0: LpToken
  token1: LpToken
  /** 这个仓位对应的 token0 / token1 数量（最小单位的十进制字符串；V3 / V4 是现在全部移除能拿到的数量，不含手续费） */
  amount0: string
  amount1: string
  /** 按精度换算后的数量；读不到精度时为 null */
  amount0Formatted: string | null
  amount1Formatted: string | null
  /** 开启 prices 时：这个仓位的美元价值（数量不为 0 的代币没有价格时为 null）；没开启时不返回 */
  valueUsd?: number | null
}

/** V2（Uniswap V2 及其分叉）：持有池子的 LP 代币，手续费已经计入份额，没有单独的未领取手续费 */
export interface LpV2Position extends LpPositionBase {
  version: 'v2'
  /** 持有的 LP 代币数量（最小单位） */
  balance: string
  /** LP 代币总量 */
  totalSupply: string
  /** 占池子的份额（0~1） */
  share: number
}

/** V3 / V4（集中流动性）：一个仓位 NFT */
export interface LpConcentratedPosition extends LpPositionBase {
  version: 'v3' | 'v4'
  /** 仓位 NFT 的 tokenId（十进制字符串） */
  tokenId: string
  /** 仓位 NFT 合约 */
  positionManager: string
  /** 手续费档位（百万分之一：500 = 0.05%）；V4 动态手续费池子为当前的 lpFee */
  fee: number
  tickLower: number
  tickUpper: number
  /** 池子当前的 tick */
  tick: number
  /** 当前价格是否在仓位的区间内（在区间内才赚手续费） */
  inRange: boolean
  /** 仓位的流动性 L */
  liquidity: string
  /** 价格都是 token1 / token0（按精度换算，只用于展示）；读不到精度时为 null */
  price: number | null
  priceLower: number | null
  priceUpper: number | null
  /** 未领取的手续费（最小单位） */
  fees0: string
  fees1: string
  fees0Formatted: string | null
  fees1Formatted: string | null
  /** 开启 prices 时：未领取手续费的美元价值；没开启时不返回 */
  feesUsd?: number | null
  /** V4：池子的 hooks 合约（没有时为零地址） */
  hooks?: string
}

export type LpPosition = LpV2Position | LpConcentratedPosition

export interface LpPositionsOptions extends CallOverrides {
  /**
   * 查哪些协议：协议 id（如 ['uniswap-v3', 'pancakeswap-v2']），或自己的 LpProtocol（内置表里没有的 DEX / 链）。
   * 默认这条链上内置的全部协议
   */
  protocols?: ReadonlyArray<string | LpProtocol>
  /** 只查这些类型，默认全部 */
  versions?: readonly LpVersion[]
  /** V2：直接指定要查的池子（LP 代币）地址，不限协议 */
  pools?: readonly string[]
  /** V2：用这些代币 × 计价币在工厂合约里找池子（如用户持有的代币，可以来自资产列表） */
  tokens?: readonly string[]
  /** V2：计价币，默认 LP_QUOTE_TOKENS 里这条链的 */
  quoteTokens?: readonly string[]
  /** V2：从代币来源发现 LP 代币（如 alchemy({ apiKey }) 能列出地址持有的全部 ERC20，包括 LP 代币） */
  source?: TokenSource
  /**
   * V4：怎么找仓位。V4 的仓位合约不能按地址列出 NFT：传已知的 tokenIds，或开启 scan 扫描 Transfer 事件。
   * 两个都没有时不查 V4
   */
  v4?: LpV4Options
  /** V3 / V4：也返回已经撤出全部流动性、手续费也领完了的仓位（NFT 还在），默认不返回 */
  includeClosed?: boolean
  /** V3 / V4：每个协议最多核对多少个仓位 NFT（超出时取最近的：V3 按持有顺序取最后的，V4 取 tokenId 最大的），默认 500 */
  maxPositions?: number
  /** 美元价值（可选）：true 用 DefiLlama，也可以传自己的 PriceSource。默认不查 */
  prices?: boolean | PriceSource
  /**
   * 价格源出错时调用（服务不可用、被拦截等）：这时照样返回仓位，只是 valueUsd / feesUsd 为 null，
   * 用它区分“价格服务出错”和“这个代币没有价格”。回调本身出错会被忽略
   */
  onPriceError?: (error: unknown) => void
  /** 自定义 fetch（价格、代币来源用） */
  fetch?: typeof fetch
}

// ---------------------------------------------------------------------------
// ABI
// ---------------------------------------------------------------------------

const V2_FACTORY_ABI = ['function getPair(address tokenA, address tokenB) view returns (address)']
const V2_PAIR_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function totalSupply() view returns (uint256)',
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function factory() view returns (address)',
  'function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
]
const V3_NPM_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)',
  'function positions(uint256 tokenId) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)',
]
const V3_FACTORY_ABI = ['function getPool(address tokenA, address tokenB, uint24 fee) view returns (address)']
// 只声明前几个返回值：各分叉后面的字段类型不同（如 PancakeSwap 的 feeProtocol 是 uint32），多出来的数据解码时忽略
const V3_POOL_ABI = [
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick)',
  'function feeGrowthGlobal0X128() view returns (uint256)',
  'function feeGrowthGlobal1X128() view returns (uint256)',
  'function ticks(int24 tick) view returns (uint128 liquidityGross, int128 liquidityNet, uint256 feeGrowthOutside0X128, uint256 feeGrowthOutside1X128)',
]

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'
const U128_MASK = (1n << 128n) - 1n
/** 地址统一成小写的 0x 格式再比较（Tron 的 T 地址先转换；合约调用返回的地址都是 0x 格式） */
const lower = (address: string) => (isTronAddress(address) ? toEvmAddress(address) : address).toLowerCase()

/** 选项里传给合约调用的部分（区块、取消等） */
function callOverrides(options: CallOverrides): CallOverrides {
  const { blockTag, from, minBlock, signal } = options
  return { ...(blockTag !== undefined ? { blockTag } : {}), ...(from !== undefined ? { from } : {}), ...(minBlock !== undefined ? { minBlock } : {}), ...(signal ? { signal } : {}) }
}

// ---------------------------------------------------------------------------
// 查询
// ---------------------------------------------------------------------------

/** 选出要查的协议 */
export function resolveLpProtocols(chainId: number, options: Pick<LpPositionsOptions, 'protocols' | 'versions'> = {}): LpProtocol[] {
  const builtin = LP_PROTOCOLS.filter((p) => p.chainId === chainId)
  const selected = options.protocols
    ? options.protocols.flatMap((p) => {
        if (typeof p !== 'string') {
          return p.chainId === chainId ? [p] : []
        }
        const found = builtin.filter((b) => b.id === p)
        if (!found.length) {
          throw new Error(`Unknown LP protocol ${p} on chain ${chainId}; pass an LpProtocol object for protocols that are not built in`)
        }
        return found
      })
    : builtin
  return options.versions ? selected.filter((p) => options.versions?.includes(p.version)) : selected
}

/** 解出 V2 / V3 的原始仓位（还没有代币信息） */
interface RawV2 {
  version: 'v2'
  protocol: LpProtocol | null
  factory: string
  pool: string
  token0: string
  token1: string
  balance: bigint
  totalSupply: bigint
  amount0: bigint
  amount1: bigint
}

interface RawConcentrated {
  version: 'v3' | 'v4'
  protocol: LpProtocol
  pool: string
  tokenId: bigint
  token0: string
  token1: string
  fee: number
  tickLower: number
  tickUpper: number
  tick: number
  sqrtPriceX96: bigint
  liquidity: bigint
  amount0: bigint
  amount1: bigint
  fees0: bigint
  fees1: bigint
  hooks?: string
}

type RawPosition = RawV2 | RawConcentrated

async function v2Positions(provider: Provider, owner: string, protocols: LpProtocol[], allV2: LpProtocol[], options: LpPositionsOptions, chainId: number): Promise<RawV2[]> {
  const { pools = [], tokens = [], quoteTokens = LP_QUOTE_TOKENS[chainId] ?? [], source, fetch: fetchOption } = options
  const overrides = callOverrides(options)
  const candidates = new Set(pools.map(lower))

  // 代币来源（如 alchemy）列出的代币里可能有 LP 代币：都当作候选，下面用 token0 / token1 / factory 识别
  if (source) {
    const fetchFn = fetchOption ?? ((...args: Parameters<typeof fetch>) => fetch(...args))
    const discovered = (await source.discover({ chainId, owner, fetch: fetchFn, provider })) ?? []
    for (const token of discovered) {
      candidates.add(lower(token.address))
    }
  }

  // 传入的代币 × 计价币（以及计价币之间）在每个 V2 工厂里查池子
  const quotes = [...new Set(quoteTokens.map(lower))]
  const bases = [...new Set([...tokens.map(lower), ...quotes])]
  const pairKeys = new Set<string>()
  const getPair: Call[] = []
  for (const protocol of protocols) {
    const factory = provider.contract(protocol.factory as string, V2_FACTORY_ABI)
    for (const base of bases) {
      for (const quote of quotes) {
        const key = `${lower(protocol.factory as string)}:${[base, quote].sort().join(':')}`
        if (base === quote || pairKeys.has(key)) {
          continue
        }
        pairKeys.add(key)
        getPair.push(factory.getPair(base, quote))
      }
    }
  }
  for (const pair of await provider.tryAll<string>(getPair, overrides)) {
    if (pair && pair !== ZERO_ADDRESS) {
      candidates.add(lower(pair))
    }
  }
  if (!candidates.size) {
    return []
  }

  // 持有的 LP 代币
  const list = [...candidates]
  const balances = await provider.tryAll<bigint>(
    list.map((pair) => provider.contract(pair, V2_PAIR_ABI).balanceOf(owner)),
    overrides,
  )
  const held = list.filter((_, i) => (balances[i] ?? 0n) > 0n)
  if (!held.length) {
    return []
  }

  // 池子详情：token0 / token1 / 储备 / 总量 / 工厂（识别协议；读不到的不是 V2 池子）
  const details = await provider.tryAll(
    held.flatMap((pair) => {
      const c = provider.contract(pair, V2_PAIR_ABI)
      return [c.token0(), c.token1(), c.getReserves(), c.totalSupply(), c.factory()]
    }),
    overrides,
  )
  const selectedFactories = new Set(protocols.map((p) => lower(p.factory as string)))
  return held.flatMap((pool, i): RawV2[] => {
    const [token0, token1, reserves, totalSupply, factory] = details.slice(i * 5, i * 5 + 5) as [string | null, string | null, { 0: bigint; 1: bigint } | null, bigint | null, string | null]
    if (!token0 || !token1 || !reserves || !totalSupply) {
      return []
    }
    const factoryAddress = factory ? lower(factory) : ''
    const protocol = allV2.find((p) => lower(p.factory as string) === factoryAddress) ?? null
    // 显式传入的池子不限协议；查出来 / 来源发现的只保留选中的协议（来源里的普通代币没有 token0，上面已经去掉）
    if (!pools.some((p) => lower(p) === pool) && protocol && !selectedFactories.has(factoryAddress)) {
      return []
    }
    const balance = balances[list.indexOf(pool)] as bigint
    return [
      {
        version: 'v2',
        protocol,
        factory: factoryAddress,
        pool,
        token0,
        token1,
        balance,
        totalSupply,
        amount0: totalSupply === 0n ? 0n : (reserves[0] * balance) / totalSupply,
        amount1: totalSupply === 0n ? 0n : (reserves[1] * balance) / totalSupply,
      },
    ]
  })
}

async function v3Positions(provider: Provider, owner: string, protocols: LpProtocol[], options: LpPositionsOptions): Promise<RawConcentrated[]> {
  const { includeClosed = false } = options
  const maxPositions = Math.floor(options.maxPositions ?? 500)
  const overrides = callOverrides(options)
  if (!protocols.length || !(maxPositions > 0)) {
    return []
  }

  // 每个协议持有几个仓位 NFT → 逐个取 tokenId
  const counts = await provider.tryAll<bigint>(
    protocols.map((p) => provider.contract(p.positionManager as string, V3_NPM_ABI).balanceOf(owner)),
    overrides,
  )
  const indexCalls: Call[] = []
  const indexOwners: LpProtocol[] = []
  protocols.forEach((protocol, i) => {
    // 仓位很多的地址（做市机器人等）只看最近的 maxPositions 个：新铸造的 NFT 排在最后
    const count = Number(counts[i] ?? 0n)
    const npm = provider.contract(protocol.positionManager as string, V3_NPM_ABI)
    for (let index = Math.max(0, count - maxPositions); index < count; index++) {
      indexCalls.push(npm.tokenOfOwnerByIndex(owner, index))
      indexOwners.push(protocol)
    }
  })
  if (!indexCalls.length) {
    return []
  }
  const tokenIds = await provider.tryAll<bigint>(indexCalls, overrides)
  const ids = tokenIds.flatMap((id, i) => (id === null ? [] : [{ protocol: indexOwners[i] as LpProtocol, tokenId: id }]))

  // 仓位详情
  type PositionData = { token0: string; token1: string; fee: bigint; tickLower: bigint; tickUpper: bigint; liquidity: bigint; feeGrowthInside0LastX128: bigint; feeGrowthInside1LastX128: bigint; tokensOwed0: bigint; tokensOwed1: bigint }
  const positions = await provider.tryAll<PositionData>(
    ids.map(({ protocol, tokenId }) => provider.contract(protocol.positionManager as string, V3_NPM_ABI).positions(tokenId)),
    overrides,
  )
  const open = ids
    .map((item, i) => ({ ...item, data: positions[i] ?? null }))
    .filter((x): x is typeof x & { data: PositionData } => x.data !== null)
    .filter((x) => includeClosed || x.data.liquidity > 0n || x.data.tokensOwed0 > 0n || x.data.tokensOwed1 > 0n)
  if (!open.length) {
    return []
  }

  // 池子地址（同一个协议、同一对代币、同一档手续费只查一次）
  const poolKey = (x: (typeof open)[number]) => `${x.protocol.positionManager}:${lower(x.data.token0)}:${lower(x.data.token1)}:${x.data.fee}`
  const poolKeys = [...new Set(open.map(poolKey))]
  const poolSamples = poolKeys.map((key) => open.find((x) => poolKey(x) === key) as (typeof open)[number])
  const poolAddresses = await provider.tryAll<string>(
    poolSamples.map((x) => provider.contract(x.protocol.factory as string, V3_FACTORY_ABI).getPool(x.data.token0, x.data.token1, x.data.fee)),
    overrides,
  )
  const poolOf = new Map(poolKeys.map((key, i) => [key, poolAddresses[i] && poolAddresses[i] !== ZERO_ADDRESS ? (poolAddresses[i] as string) : null]))

  // 池子状态（每个池子一次）+ 每个仓位两端 tick 的手续费增长
  const pools = [...new Set([...poolOf.values()].filter((p): p is string => p !== null).map(lower))]
  const poolCalls = pools.flatMap((pool) => {
    const c = provider.contract(pool, V3_POOL_ABI)
    return [c.slot0(), c.feeGrowthGlobal0X128(), c.feeGrowthGlobal1X128()]
  })
  const tickCalls = open.flatMap((x) => {
    const pool = poolOf.get(poolKey(x))
    if (!pool) {
      return []
    }
    const c = provider.contract(pool, V3_POOL_ABI)
    return [c.ticks(x.data.tickLower), c.ticks(x.data.tickUpper)]
  })
  const state = await provider.tryAll([...poolCalls, ...tickCalls], overrides)
  const poolState = new Map(
    pools.map((pool, i) => {
      const [slot0, global0, global1] = state.slice(i * 3, i * 3 + 3) as [{ 0: bigint; 1: bigint } | null, bigint | null, bigint | null]
      return [pool, slot0 && global0 !== null && global1 !== null ? { sqrtPriceX96: slot0[0], tick: Number(slot0[1]), global0, global1 } : null]
    }),
  )

  let t = poolCalls.length
  return open.flatMap((x): RawConcentrated[] => {
    const pool = poolOf.get(poolKey(x))
    if (!pool) {
      return []
    }
    const lowerTick = state[t++] as { 2: bigint; 3: bigint } | null
    const upperTick = state[t++] as { 2: bigint; 3: bigint } | null
    const s = poolState.get(lower(pool))
    if (!s || !lowerTick || !upperTick) {
      return []
    }
    const tickLower = Number(x.data.tickLower)
    const tickUpper = Number(x.data.tickUpper)
    const [amount0, amount1] = getAmountsForLiquidity(s.sqrtPriceX96, getSqrtRatioAtTick(tickLower), getSqrtRatioAtTick(tickUpper), x.data.liquidity)
    const inside0 = getFeeGrowthInside(s.tick, tickLower, tickUpper, s.global0, lowerTick[2], upperTick[2])
    const inside1 = getFeeGrowthInside(s.tick, tickLower, tickUpper, s.global1, lowerTick[3], upperTick[3])
    return [
      {
        version: 'v3',
        protocol: x.protocol,
        pool,
        tokenId: x.tokenId,
        token0: x.data.token0,
        token1: x.data.token1,
        fee: Number(x.data.fee),
        tickLower,
        tickUpper,
        tick: s.tick,
        sqrtPriceX96: s.sqrtPriceX96,
        liquidity: x.data.liquidity,
        amount0,
        amount1,
        // 与仓位合约一致：tokensOwed += uint128(新增)，按 uint128 截断 / 回绕（正常仓位不会碰到）
        fees0: (x.data.tokensOwed0 + (getFeesEarned(x.data.liquidity, inside0, x.data.feeGrowthInside0LastX128) & U128_MASK)) & U128_MASK,
        fees1: (x.data.tokensOwed1 + (getFeesEarned(x.data.liquidity, inside1, x.data.feeGrowthInside1LastX128) & U128_MASK)) & U128_MASK,
      },
    ]
  })
}

function reportPriceError(onPriceError: ((error: unknown) => void) | undefined, err: unknown): void {
  try {
    onPriceError?.(err)
  } catch {
    // 回调出错不影响查询结果
  }
}

/** 补上代币信息（symbol / 精度）、换算数量、可选的美元价值 */
async function finalize(provider: Provider, chainId: number, raw: RawPosition[], options: LpPositionsOptions): Promise<LpPosition[]> {
  const { prices, fetch: fetchOption } = options
  const overrides = callOverrides(options)
  const tron = isTronChain(chainId)
  /** 输出的地址：Tron 上转成 T 地址（与 tronWeb 等一致） */
  const out = (address: string) => (tron && /^0x[0-9a-fA-F]{40}$/.test(address) ? toTronAddress(address) : address)
  /** 价格源的键：EVM 小写 0x 地址；Tron 用 T 地址（区分大小写） */
  const priceKey = (address: string) => (tron ? toTronAddress(address) : lower(address))
  const addresses = [...new Set(raw.flatMap((r) => [lower(r.token0), lower(r.token1)]))]
  // V4 的主币池子 currency 是零地址：Provider 的 nativeTokens 不含零地址时（如配置成只认 0xeeee…），按它的第一个主币地址查主币信息
  const nativeAlias = provider.isNativeToken(ZERO_ADDRESS) ? undefined : provider.nativeTokens[0]
  const query = addresses.map((a) => (a === ZERO_ADDRESS && nativeAlias !== undefined ? nativeAlias : a))
  const details = addresses.length ? await provider.tokens(query, { ...overrides, fields: ['symbol', 'decimals'] }) : []
  const info = new Map(
    addresses.map((address, i): [string, LpToken] => {
      const d = details[i]
      return [address, { address: out(address), native: d?.native ?? false, symbol: d?.symbol ?? null, decimals: d?.decimals ?? null }]
    }),
  )
  const token = (address: string): LpToken => {
    const t = info.get(lower(address)) as LpToken
    return { ...t, address: out(address) }
  }
  const fmt = (value: bigint, t: LpToken) => (t.decimals === null ? null : formatUnits(value, t.decimals))

  // 美元价值（可选）
  const priceSource = prices === true ? defillamaPrices() : prices || null
  let priceMap = new Map<string, number>()
  if (priceSource && raw.length) {
    const fetchFn = fetchOption ?? ((...args: Parameters<typeof fetch>) => fetch(...args))
    const nativeToken = [...info.values()].find((t) => t.native)
    // 价格源出错（服务不可用、被拦截等）时照样返回仓位，只是不带价格（valueUsd / feesUsd 为 null）
    try {
      priceMap = await priceSource.prices({
        chainId,
        tokens: addresses.filter((a) => !info.get(a)?.native).map((a) => (tron ? toTronAddress(a) : a)),
        nativeSymbol: nativeToken ? nativeToken.symbol : null,
        fetch: fetchFn,
      })
    } catch (err) {
      // 同步抛错和 reject 都在这里接住
      reportPriceError(options.onPriceError, err)
    }
  }
  const usd = (t: LpToken, formatted: string | null) => {
    const price = priceMap.get(t.native ? 'native' : priceKey(t.address))
    return formatted === null || price === undefined ? null : Number(formatted) * price
  }
  const sum = (a: number | null, b: number | null, amountA: bigint, amountB: bigint) => {
    // 数量为 0 的一边没有价格也不影响
    if ((a === null && amountA > 0n) || (b === null && amountB > 0n)) {
      return null
    }
    return (a ?? 0) + (b ?? 0)
  }

  const list = raw.map((r): LpPosition => {
    const token0 = token(r.token0)
    const token1 = token(r.token1)
    const amount0Formatted = fmt(r.amount0, token0)
    const amount1Formatted = fmt(r.amount1, token1)
    const base = {
      chainId,
      // 不认识的工厂：'v2:<工厂地址>'（Tron 上是 T 地址；读不到工厂时为 'v2:unknown'）
      protocol: r.protocol ? r.protocol.id : `v2:${(r as RawV2).factory ? out((r as RawV2).factory as string) : 'unknown'}`,
      protocolName: r.protocol ? r.protocol.name : 'Unknown V2',
      pool: r.version === 'v4' ? r.pool : out(r.pool),
      token0,
      token1,
      amount0: r.amount0.toString(),
      amount1: r.amount1.toString(),
      amount0Formatted,
      amount1Formatted,
      ...(priceSource ? { valueUsd: sum(usd(token0, amount0Formatted), usd(token1, amount1Formatted), r.amount0, r.amount1) } : {}),
    }
    if (r.version === 'v2') {
      return {
        ...base,
        version: 'v2',
        balance: r.balance.toString(),
        totalSupply: r.totalSupply.toString(),
        share: r.totalSupply === 0n ? 0 : Number((r.balance * 10n ** 18n) / r.totalSupply) / 1e18,
      }
    }
    const fees0Formatted = fmt(r.fees0, token0)
    const fees1Formatted = fmt(r.fees1, token1)
    const decimalsKnown = token0.decimals !== null && token1.decimals !== null
    return {
      ...base,
      version: r.version,
      tokenId: r.tokenId.toString(),
      positionManager: out(r.protocol.positionManager as string),
      fee: r.fee,
      tickLower: r.tickLower,
      tickUpper: r.tickUpper,
      tick: r.tick,
      inRange: r.tick >= r.tickLower && r.tick < r.tickUpper,
      liquidity: r.liquidity.toString(),
      price: decimalsKnown ? sqrtPriceToPrice(r.sqrtPriceX96, token0.decimals as number, token1.decimals as number) : null,
      priceLower: decimalsKnown ? tickToPrice(r.tickLower, token0.decimals as number, token1.decimals as number) : null,
      priceUpper: decimalsKnown ? tickToPrice(r.tickUpper, token0.decimals as number, token1.decimals as number) : null,
      fees0: r.fees0.toString(),
      fees1: r.fees1.toString(),
      fees0Formatted,
      fees1Formatted,
      ...(priceSource ? { feesUsd: sum(usd(token0, fees0Formatted), usd(token1, fees1Formatted), r.fees0, r.fees1) } : {}),
      ...(r.hooks !== undefined ? { hooks: r.hooks } : {}),
    }
  })
  // 有价格时按价值从高到低（仓位价值 + 未领取手续费），没有价格的排在后面
  if (priceSource) {
    const total = (p: LpPosition) => (p.valueUsd === null || p.valueUsd === undefined ? -1 : p.valueUsd + ('feesUsd' in p ? (p.feesUsd ?? 0) : 0))
    list.sort((a, b) => total(b) - total(a))
  }
  return list
}

/**
 * 查一个地址的 LP 仓位：V2（持有的 LP 代币）、V3 / V4（仓位 NFT）。所有合约读取都用 multicall 批量完成。
 *
 * ```ts
 * await lpPositions(multi, user)                                   // 这条链上内置的全部协议
 * await lpPositions(multi, user, { tokens: heldTokens, prices: true }) // V2 用持有的代币找池子，带美元价值
 * ```
 */
export function lpPositions(provider: Provider, owner: string, options: LpPositionsOptions = {}): Promise<LpPosition[]> {
  // 取消时立即 reject（扫描 / 价格等进行中的请求不中断，结果丢弃）
  return withSignal(options.signal, () => queryLpPositions(provider, owner, options))
}

async function queryLpPositions(provider: Provider, owner: string, options: LpPositionsOptions): Promise<LpPosition[]> {
  const chainId = await provider.getChainId()
  const protocols = resolveLpProtocols(chainId, options)
  const allV2 = [...LP_PROTOCOLS.filter((p) => p.chainId === chainId && p.version === 'v2'), ...protocols.filter((p) => p.version === 'v2')]
  const v2Selected = protocols.filter((p) => p.version === 'v2')
  const v3Selected = protocols.filter((p) => p.version === 'v3')
  const v4Selected = protocols.filter((p) => p.version === 'v4')
  const wantV2 = !options.versions || options.versions.includes('v2')
  const wantV4 = v4Selected.length > 0 && !!(options.v4?.tokenIds?.length || options.v4?.scan)
  const [v2List, v3List, v4List] = await Promise.all([
    wantV2 && (v2Selected.length || options.pools?.length || options.source) ? v2Positions(provider, owner, v2Selected, allV2, options, chainId) : Promise.resolve([]),
    v3Positions(provider, owner, v3Selected, options),
    wantV4 ? v4Positions(provider, owner, v4Selected, options.v4 ?? {}, options.includeClosed ?? false, options.maxPositions ?? 500, callOverrides(options)) : Promise.resolve([]),
  ])
  return finalize(provider, chainId, [...v2List, ...v3List, ...v4List], options)
}
