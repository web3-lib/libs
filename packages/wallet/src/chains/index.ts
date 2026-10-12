import type { EvmChain } from '../evm/index.js'

/**
 * 常用 EVM 链的信息，直接传给 evm({ chains })：钱包没有这条链时用它请求添加；WalletConnect 用 rpcUrls。
 * 每条链单独导出，只打包用到的。rpcUrls 是各链官方 / 常用的公共节点，生产环境可以换成自己的：
 *
 * ```ts
 * import { bsc, ethereum } from '@w3lib/wallet/chains'
 * evm({ chains: [bsc, { ...ethereum, rpcUrls: ['https://my-node.example'] }] })
 * ```
 */

const ETH = { name: 'Ether', symbol: 'ETH', decimals: 18 } as const

export const ethereum: EvmChain = {
  id: 1,
  name: 'Ethereum',
  rpcUrls: ['https://ethereum-rpc.publicnode.com'],
  nativeCurrency: ETH,
  blockExplorerUrls: ['https://etherscan.io'],
}

export const bsc: EvmChain = {
  id: 56,
  name: 'BNB Smart Chain',
  rpcUrls: ['https://bsc-dataseed.bnbchain.org'],
  nativeCurrency: { name: 'BNB', symbol: 'BNB', decimals: 18 },
  blockExplorerUrls: ['https://bscscan.com'],
}

export const polygon: EvmChain = {
  id: 137,
  name: 'Polygon',
  rpcUrls: ['https://polygon-rpc.com'],
  nativeCurrency: { name: 'POL', symbol: 'POL', decimals: 18 },
  blockExplorerUrls: ['https://polygonscan.com'],
}

export const arbitrum: EvmChain = {
  id: 42161,
  name: 'Arbitrum One',
  rpcUrls: ['https://arb1.arbitrum.io/rpc'],
  nativeCurrency: ETH,
  blockExplorerUrls: ['https://arbiscan.io'],
}

export const optimism: EvmChain = {
  id: 10,
  name: 'OP Mainnet',
  rpcUrls: ['https://mainnet.optimism.io'],
  nativeCurrency: ETH,
  blockExplorerUrls: ['https://optimistic.etherscan.io'],
}

export const base: EvmChain = {
  id: 8453,
  name: 'Base',
  rpcUrls: ['https://mainnet.base.org'],
  nativeCurrency: ETH,
  blockExplorerUrls: ['https://basescan.org'],
}

export const avalanche: EvmChain = {
  id: 43114,
  name: 'Avalanche C-Chain',
  rpcUrls: ['https://api.avax.network/ext/bc/C/rpc'],
  nativeCurrency: { name: 'Avalanche', symbol: 'AVAX', decimals: 18 },
  blockExplorerUrls: ['https://snowtrace.io'],
}

export const linea: EvmChain = {
  id: 59144,
  name: 'Linea',
  rpcUrls: ['https://rpc.linea.build'],
  nativeCurrency: ETH,
  blockExplorerUrls: ['https://lineascan.build'],
}

export const zksync: EvmChain = {
  id: 324,
  name: 'ZKsync Era',
  rpcUrls: ['https://mainnet.era.zksync.io'],
  nativeCurrency: ETH,
  blockExplorerUrls: ['https://explorer.zksync.io'],
}

export const opbnb: EvmChain = {
  id: 204,
  name: 'opBNB',
  rpcUrls: ['https://opbnb-mainnet-rpc.bnbchain.org'],
  nativeCurrency: { name: 'BNB', symbol: 'BNB', decimals: 18 },
  blockExplorerUrls: ['https://opbnb.bscscan.com'],
}

// ---- 测试网 ----

export const sepolia: EvmChain = {
  id: 11155111,
  name: 'Sepolia',
  rpcUrls: ['https://ethereum-sepolia-rpc.publicnode.com'],
  nativeCurrency: { name: 'Sepolia Ether', symbol: 'ETH', decimals: 18 },
  blockExplorerUrls: ['https://sepolia.etherscan.io'],
}

export const bscTestnet: EvmChain = {
  id: 97,
  name: 'BNB Smart Chain Testnet',
  rpcUrls: ['https://bsc-testnet-dataseed.bnbchain.org'],
  nativeCurrency: { name: 'BNB', symbol: 'tBNB', decimals: 18 },
  blockExplorerUrls: ['https://testnet.bscscan.com'],
}
