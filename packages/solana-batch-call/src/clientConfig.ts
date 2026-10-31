import type { Cluster } from './constants.js'
import type { SourceOptions } from './source.js'

/** SolanaClient 的节点配置（网络、节点选项、期望的创世哈希），按客户端登记：写操作的 sendRpc 按同样的配置解析、校验网络 */
export interface ClientSourceConfig {
  cluster: Cluster | undefined
  options: SourceOptions
  genesis: () => Promise<string>
}

/** 单独成模块：/write 只需查表，不用静态带上 source.ts（sendRpc 解析时才按需加载） */
export const clientSourceConfigs = new WeakMap<object, ClientSourceConfig>()
