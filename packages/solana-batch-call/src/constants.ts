export const SYSTEM_PROGRAM_ID = '11111111111111111111111111111111'
export const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
export const TOKEN_2022_PROGRAM_ID = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'
export const ASSOCIATED_TOKEN_PROGRAM_ID = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'
export const METADATA_PROGRAM_ID = 'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s'

/** Wrapped SOL 的 mint，按惯例也用来表示原生 SOL */
export const NATIVE_MINT = 'So11111111111111111111111111111111111111112'

/** 原生 SOL 的精度（lamports） */
export const SOL_DECIMALS = 9

export type Cluster = 'mainnet' | 'devnet' | 'testnet'

/** 各网络的创世区块哈希（getGenesisHash），用于识别节点所在网络 */
export const GENESIS_HASHES: Readonly<Record<Cluster, string>> = {
  mainnet: '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
  devnet: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
  testnet: '4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY',
}

export function clusterOfGenesis(hash: string): Cluster | null {
  for (const [cluster, genesis] of Object.entries(GENESIS_HASHES)) {
    if (genesis === hash) {
      return cluster as Cluster
    }
  }
  return null
}

/**
 * 内置公共节点（按优先级排序，2026-10 实测）：
 * - publicnode：放行跨域、支持批量请求，但不支持 getTokenAccountsByOwner 等需要索引的方法
 * - 官方节点：对带浏览器 Origin 的请求返回 403，只能在服务端使用
 * 公共节点限频严，生产环境建议传入自己的节点（Helius / QuickNode / Triton 等）。
 */
export const DEFAULT_RPC_URLS: Readonly<Record<Cluster, readonly string[]>> = {
  mainnet: ['https://solana-rpc.publicnode.com', 'https://api.mainnet-beta.solana.com'],
  devnet: ['https://api.devnet.solana.com'],
  testnet: ['https://api.testnet.solana.com'],
}
