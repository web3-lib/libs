import type { NativeBalanceMode } from './aggregate.js'

/**
 * 内置链的主币信息（balances() / tokens() 里主币的 name / symbol / 精度）。
 * 来源：https://chainid.network/chains.json 的 nativeCurrency；999 在该表里与 Wanchain 测试网撞号，
 * 这里按 HyperEVM 手动填写；Tron 手动填写。表里没有的链可通过 nativeSymbol / nativeDecimals 配置。
 */
export interface NativeCurrency {
  name: string
  symbol: string
  decimals: number
}

export const NATIVE_CURRENCIES: Readonly<Record<number, NativeCurrency>> = {
  1: { name: 'Ether', symbol: 'ETH', decimals: 18 }, // Ethereum Mainnet
  10: { name: 'Ether', symbol: 'ETH', decimals: 18 }, // OP Mainnet
  56: { name: 'BNB Chain Native Token', symbol: 'BNB', decimals: 18 }, // BNB Smart Chain Mainnet
  130: { name: 'Ether', symbol: 'ETH', decimals: 18 }, // Unichain
  137: { name: 'POL', symbol: 'POL', decimals: 18 }, // Polygon Mainnet
  143: { name: 'Monad', symbol: 'MON', decimals: 18 }, // Monad
  173: { name: 'EGAS', symbol: 'EGAS', decimals: 18 }, // ENI Mainnet
  196: { name: 'X Layer Global Utility Token', symbol: 'OKB', decimals: 18 }, // X Layer Mainnet
  204: { name: 'BNB Chain Native Token', symbol: 'BNB', decimals: 18 }, // opBNB Mainnet
  324: { name: 'Ether', symbol: 'ETH', decimals: 18 }, // zkSync Mainnet
  988: { name: 'USDT0', symbol: 'USDT0', decimals: 18 }, // Stable Mainnet
  999: { name: 'HYPE', symbol: 'HYPE', decimals: 18 }, // HyperEVM
  1116: { name: 'Core Blockchain Native Token', symbol: 'CORE', decimals: 18 }, // Core Blockchain Mainnet
  2818: { name: 'Ether', symbol: 'ETH', decimals: 18 }, // Morph
  4663: { name: 'Ether', symbol: 'ETH', decimals: 18 }, // Robinhood Chain
  5000: { name: 'Mantle', symbol: 'MNT', decimals: 18 }, // Mantle
  8453: { name: 'Ether', symbol: 'ETH', decimals: 18 }, // Base
  9745: { name: 'Plasma', symbol: 'XPL', decimals: 18 }, // Plasma Mainnet
  34443: { name: 'Ether', symbol: 'ETH', decimals: 18 }, // Mode
  42161: { name: 'Ether', symbol: 'ETH', decimals: 18 }, // Arbitrum One
  43114: { name: 'Avalanche', symbol: 'AVAX', decimals: 18 }, // Avalanche C-Chain
  57073: { name: 'Ether', symbol: 'ETH', decimals: 18 }, // Ink
  59144: { name: 'Linea Ether', symbol: 'ETH', decimals: 18 }, // Linea
  80094: { name: 'BERA Token', symbol: 'BERA', decimals: 18 }, // Berachain
  81457: { name: 'Ether', symbol: 'ETH', decimals: 18 }, // Blast
  534352: { name: 'Ether', symbol: 'ETH', decimals: 18 }, // Scroll
  6666665: { name: 'SAFE(AnWang)', symbol: 'SAFE', decimals: 18 }, // Safe(AnWang) Mainnet
  20260131: { name: 'MetaAssets', symbol: 'MA', decimals: 18 }, // Meta Assets Chain
  728126428: { name: 'TRON', symbol: 'TRX', decimals: 6 }, // Tron
}

export function getNativeCurrency(chainId: number): NativeCurrency | undefined {
  return NATIVE_CURRENCIES[chainId]
}

/**
 * 合约里读主币余额不可靠的链，以及应改用的读取方式（ProviderConfig.nativeBalance 的默认值）。
 * 新链可用 `pnpm check:rpc` 比对“合约里读到的主币余额”和 eth_getBalance 来发现。
 */
export const NATIVE_BALANCE_MODES: Readonly<Record<number, NativeBalanceMode>> = {
  // Anubis：Multicall3.getEthBalance 和 deployless 里的 BALANCE 对任何地址都返回 0，eth_getBalance 正常
  6714: 'rpc',
}

export function getNativeBalanceMode(chainId: number): NativeBalanceMode {
  return NATIVE_BALANCE_MODES[chainId] ?? 'contract'
}
