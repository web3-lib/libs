/**
 * 内置链的主币信息（balances() 的主币 symbol / 精度）。
 * 来源：https://chainid.network/chains.json 的 nativeCurrency；999 在该表里与 Wanchain 测试网撞号，
 * 这里按 HyperEVM 手动填写；Tron 手动填写。表里没有的链可通过 nativeSymbol / nativeDecimals 配置。
 */
export interface NativeCurrency {
  symbol: string
  decimals: number
}

export const NATIVE_CURRENCIES: Readonly<Record<number, NativeCurrency>> = {
  1: { symbol: 'ETH', decimals: 18 }, // Ethereum Mainnet
  10: { symbol: 'ETH', decimals: 18 }, // OP Mainnet
  56: { symbol: 'BNB', decimals: 18 }, // BNB Smart Chain Mainnet
  130: { symbol: 'ETH', decimals: 18 }, // Unichain
  137: { symbol: 'POL', decimals: 18 }, // Polygon Mainnet
  143: { symbol: 'MON', decimals: 18 }, // Monad
  173: { symbol: 'EGAS', decimals: 18 }, // ENI Mainnet
  196: { symbol: 'OKB', decimals: 18 }, // X Layer Mainnet
  204: { symbol: 'BNB', decimals: 18 }, // opBNB Mainnet
  324: { symbol: 'ETH', decimals: 18 }, // zkSync Mainnet
  988: { symbol: 'USDT0', decimals: 18 }, // Stable Mainnet
  999: { symbol: 'HYPE', decimals: 18 }, // HyperEVM
  1116: { symbol: 'CORE', decimals: 18 }, // Core Blockchain Mainnet
  2818: { symbol: 'ETH', decimals: 18 }, // Morph
  4663: { symbol: 'ETH', decimals: 18 }, // Robinhood Chain
  5000: { symbol: 'MNT', decimals: 18 }, // Mantle
  8453: { symbol: 'ETH', decimals: 18 }, // Base
  9745: { symbol: 'XPL', decimals: 18 }, // Plasma Mainnet
  34443: { symbol: 'ETH', decimals: 18 }, // Mode
  42161: { symbol: 'ETH', decimals: 18 }, // Arbitrum One
  43114: { symbol: 'AVAX', decimals: 18 }, // Avalanche C-Chain
  57073: { symbol: 'ETH', decimals: 18 }, // Ink
  59144: { symbol: 'ETH', decimals: 18 }, // Linea
  80094: { symbol: 'BERA', decimals: 18 }, // Berachain
  81457: { symbol: 'ETH', decimals: 18 }, // Blast
  534352: { symbol: 'ETH', decimals: 18 }, // Scroll
  6666665: { symbol: 'SAFE', decimals: 18 }, // Safe(AnWang) Mainnet
  20260131: { symbol: 'MA', decimals: 18 }, // Meta Assets Chain
  728126428: { symbol: 'TRX', decimals: 6 }, // Tron
}

export function getNativeCurrency(chainId: number): NativeCurrency | undefined {
  return NATIVE_CURRENCIES[chainId]
}
