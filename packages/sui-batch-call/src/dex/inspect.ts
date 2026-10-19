import type { SuiClient } from '../client.js'
import { inspectTransaction } from '../services.js'
import { encodeTransactionData } from '../write/bcs.js'
import { PtbBuilder } from '../write/ptb.js'
import { createEnv } from './env.js'
import type { DexEnv } from './types.js'

/**
 * 只读调用（不检查交易、不需要 gas）：build 往交易里加命令并返回解析函数；执行失败时返回 null。
 * 领取到的币留给 owner（只读调用里也要处理掉，否则交易不合法）
 */
export async function inspect<T>(client: SuiClient, owner: string, packages: Map<string, string>, build: (env: DexEnv) => (outputs: unknown[][]) => T, signal?: AbortSignal): Promise<{ value: T | null; error: string | null }> {
  const ptb = new PtbBuilder()
  const env = createEnv(ptb, owner, packages)
  const decode = build(env)
  env.finish()
  const bytes = encodeTransactionData({ kind: ptb.build(), sender: owner, gas: { payment: [], owner, price: 1000n, budget: 50_000_000_000n }, expiration: { kind: 'none' } })
  const { result, outputs } = await inspectTransaction(client.transport, bytes, { signal })
  return result.success ? { value: decode(outputs), error: null } : { value: null, error: result.error }
}
