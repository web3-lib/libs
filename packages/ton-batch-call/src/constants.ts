export type TonNetwork = 'mainnet' | 'testnet'

/** toncenter 的 v3 接口（没有 API Key 时约每秒 1 次请求；Key 在 @tonapibot 申请） */
export const DEFAULT_URLS: Readonly<Record<TonNetwork, readonly string[]>> = {
  mainnet: ['https://toncenter.com/api/v3'],
  testnet: ['https://testnet.toncenter.com/api/v3'],
}

/** 表示 TON 本身（不是 Jetton）的代币标识 */
export const NATIVE_TON = 'TON'

/** TON 的精度（1 TON = 10^9 nanoTON）；也是 Jetton 元数据没写 decimals 时的默认值（TEP-64） */
export const TON_DECIMALS = 9
