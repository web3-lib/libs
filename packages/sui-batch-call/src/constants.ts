export type SuiNetwork = 'mainnet' | 'testnet' | 'devnet'

/** Sui Foundation 的公共全节点（gRPC-web）。限频严，正式环境请用自己的节点或服务商 */
export const DEFAULT_GRPC_URLS: Readonly<Record<SuiNetwork, readonly string[]>> = {
  mainnet: ['https://fullnode.mainnet.sui.io'],
  testnet: ['https://fullnode.testnet.sui.io'],
  devnet: ['https://fullnode.devnet.sui.io'],
}

/** SUI 的精度（1 SUI = 10^9 MIST） */
export const SUI_DECIMALS = 9
