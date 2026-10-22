/**
 * 内置的主要代币：EVM / Tron 链上没法只靠节点列出持仓，没有应用的代币列表时就查这些（稳定币、包装主币、主流币），
 * Solana 在免费公共节点上也退回这份列表。同时是跨链合并的资产表：同一个资产 id（如 'USDC'）在各链上的地址。
 * 地址 2026-10 在链上核对过（symbol / decimals 读得到）
 */
import type { ChainKind } from './types.js'

/** [地址, 资产 id]；资产 id 相同的代币跨链合并（桥接版 USDC.e 与 USDC 合并，WETH 与 ETH 不合并） */
type Entry = readonly [address: string, asset: string]

export const DEFAULT_TOKENS: Readonly<Record<string, readonly Entry[]>> = {
  'evm:1': [
    ['0xdAC17F958D2ee523a2206206994597C13D831ec7', 'USDT'],
    ['0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', 'USDC'],
    ['0x6B175474E89094C44Da98b954EedeAC495271d0F', 'DAI'],
    ['0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', 'WETH'],
    ['0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599', 'WBTC'],
    ['0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84', 'stETH'],
    ['0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0', 'wstETH'],
    ['0x514910771AF9Ca656af840dff83E8264EcF986CA', 'LINK'],
    ['0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984', 'UNI'],
    ['0x4c9EDD5852cd905f086C759E8383e09bff1E68B3', 'USDe'],
    ['0x6c3ea9036406852006290770BEdFcAbA0e23A0e8', 'PYUSD'],
    ['0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9', 'AAVE'],
  ],
  'evm:10': [
    ['0x94b008aA00579c1307B0EF2c499aD98a8ce58e58', 'USDT'],
    ['0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85', 'USDC'],
    ['0x7F5c764cBc14f9669B88837ca1490cCa17c31607', 'USDC'],
    ['0x4200000000000000000000000000000000000006', 'WETH'],
    ['0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1', 'DAI'],
    ['0x68f180fcCe6836688e9084f035309E29Bf0A2095', 'WBTC'],
    ['0x4200000000000000000000000000000000000042', 'OP'],
  ],
  'evm:56': [
    ['0x55d398326f99059fF775485246999027B3197955', 'USDT'],
    ['0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', 'USDC'],
    ['0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c', 'WBNB'],
    ['0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56', 'BUSD'],
    ['0x2170Ed0880ac9A755fd29B2688956BD959F933F8', 'ETH'],
    ['0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c', 'BTCB'],
    ['0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82', 'CAKE'],
    ['0x1AF3F329e8BE154074D8769D1FFa4eE058B1DBc3', 'DAI'],
    ['0xc5f0f7b66764F6ec8C8Dff7BA683102295E16409', 'FDUSD'],
  ],
  'evm:137': [
    ['0xc2132D05D31c914a87C6611C10748AEb04B58e8F', 'USDT'],
    ['0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', 'USDC'],
    ['0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174', 'USDC'],
    ['0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270', 'WPOL'],
    ['0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619', 'WETH'],
    ['0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063', 'DAI'],
    ['0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6', 'WBTC'],
  ],
  'evm:8453': [
    ['0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', 'USDC'],
    ['0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA', 'USDC'],
    ['0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2', 'USDT'],
    ['0x4200000000000000000000000000000000000006', 'WETH'],
    ['0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb', 'DAI'],
    ['0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf', 'cbBTC'],
    ['0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22', 'cbETH'],
  ],
  'evm:42161': [
    ['0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', 'USDT'],
    ['0xaf88d065e77c8cC2239327C5EDb3A432268e5831', 'USDC'],
    ['0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8', 'USDC'],
    ['0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', 'WETH'],
    ['0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f', 'WBTC'],
    ['0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1', 'DAI'],
    ['0x912CE59144191C1204E64559FE8253a0e49E6548', 'ARB'],
  ],
  'evm:43114': [
    ['0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7', 'USDT'],
    ['0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E', 'USDC'],
    ['0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7', 'WAVAX'],
    ['0x49D5c2BdFfac6CE2BFdB6640F4F80f226bc10bAB', 'WETH'],
    ['0x152b9d0FdC40C096757F570A51E494bd4b943E50', 'BTC.b'],
    ['0xd586E7F844cEa2F87f50152665BCbc2C279D8d70', 'DAI'],
  ],
  tron: [
    ['TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', 'USDT'],
    ['TEkxiTehnzSmSe2XqrBj4w32RUN966rdz8', 'USDC'],
    ['TNUC9Qb1rRpS5CbWLmNMxXBjyFoydXjWFR', 'WTRX'],
    ['TXDk8mbtRbXeYuMNS83CfKPaYYT8XWv9Hz', 'USDD'],
    ['TSSMHYeV2uE9qYH95DqyoCuNCzEL1NvU3S', 'SUN'],
    ['TCFLL5dx5ZJdKnWuesXxi1VPwjLVmWZZy9', 'JST'],
    ['TLa2f6VPqDgRE67v1736s7bJ8Ray5wYjU7', 'WIN'],
  ],
  solana: [
    ['So11111111111111111111111111111111111111112', 'WSOL'],
    ['EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 'USDC'],
    ['Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', 'USDT'],
    ['JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN', 'JUP'],
    ['DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', 'BONK'],
    ['EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm', 'WIF'],
    ['J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn', 'JitoSOL'],
    ['mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So', 'mSOL'],
    ['HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3', 'PYTH'],
    ['4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R', 'RAY'],
  ],
  // Sui / TON 节点能直接列出持仓，这里只用于跨链合并
  sui: [
    ['0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC', 'USDC'],
    ['0x375f70cf2ae4c00bf37117d0c85a2c71545e6ee05c4a5c7d282cd66a4504b068::usdt::USDT', 'USDT'],
  ],
  ton: [['0:b113a994b5024a16719f69139328eb759596c38a25f59028b146fecdc3621dfe', 'USDT']],
}

/** 链的显示名 */
export const CHAIN_NAMES: Readonly<Record<string, string>> = {
  'evm:1': 'Ethereum',
  'evm:10': 'Optimism',
  'evm:56': 'BNB Chain',
  'evm:137': 'Polygon',
  'evm:8453': 'Base',
  'evm:42161': 'Arbitrum',
  'evm:43114': 'Avalanche',
  tron: 'Tron',
  solana: 'Solana',
  sui: 'Sui',
  ton: 'TON',
}

export const TRON_CHAIN_ID = 728126428

/** 比较用的规范形式：EVM 小写；Sui 补齐 64 位 hex 的包地址；TON 转成 `wc:hash` 的 raw 形式；其余（Solana、Tron base58）原样 */
export function normalizeToken(kind: ChainKind, token: string): string {
  if (kind === 'evm') return token.toLowerCase()
  if (kind === 'sui') {
    const m = /^0x([0-9a-fA-F]+)(::.*)$/.exec(token)
    return m ? `0x${(m[1] as string).toLowerCase().padStart(64, '0')}${m[2]}` : token
  }
  if (kind === 'ton') return tonRaw(token)
  return token
}

function tonRaw(address: string): string {
  if (/^-?\d+:[0-9a-fA-F]{64}$/.test(address)) return address.toLowerCase()
  try {
    const bytes = Uint8Array.from(atob(address.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))
    if (bytes.length !== 36) return address
    const hash = Array.from(bytes.slice(2, 34), (b) => b.toString(16).padStart(2, '0')).join('')
    return `${(bytes[1] as number) > 127 ? (bytes[1] as number) - 256 : bytes[1]}:${hash}`
  } catch {
    return address
  }
}

const kindOfKey = (key: string): ChainKind => (key.startsWith('evm:') ? 'evm' : (key as ChainKind))

/** 链键 → (规范化地址 → 资产 id) */
const REGISTRY = new Map<string, Map<string, string>>(
  Object.entries(DEFAULT_TOKENS).map(([key, list]) => [key, new Map(list.map(([address, asset]) => [normalizeToken(kindOfKey(key), address), asset]))]),
)

/** 内置表里这个代币的资产 id；不认识时为 undefined */
export function knownAsset(chain: string, token: string): string | undefined {
  return REGISTRY.get(chain)?.get(normalizeToken(kindOfKey(chain), token))
}
