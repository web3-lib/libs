/** 第二阶段：API 一致性、主币信息、写层按需加载 */
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { TransactionRequest } from 'ethers'
import { describe, expect, it } from 'vitest'

import { MULTICALL3_ADDRESS, NATIVE_TOKEN, Provider } from '../src/index.js'
import { nftBalances, nftOwners } from '../src/subpaths/nft.js'
import { tokenPrices, type PriceSource } from '../src/subpaths/price.js'
import { createMockProvider, fakeToken } from './mockProvider.js'

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '../src')
const USER = '0x4000000000000000000000000000000000000004'
const NFT = '0x1000000000000000000000000000000000000001'

describe('nftOwners / nftBalances 的 options', () => {
  it('第三个参数既可以是 options 对象，也兼容原来直接传的 overrides（blockTag 照常生效）', async () => {
    const mock = createMockProvider({ multicallAddresses: [MULTICALL3_ADDRESS], contracts: { [NFT]: fakeToken('N', 0, { [USER]: 3n }) } })
    const multi = new Provider(56, mock)
    expect(await nftBalances(multi, USER, [NFT], { blockTag: 123 })).toEqual([{ contract: NFT, balance: '3', success: true }])
    expect((mock.calls[0] as TransactionRequest).blockTag).toBe(123)
    await nftOwners(multi, [{ contract: NFT, tokenId: 1 }], { blockTag: 456 })
    expect((mock.calls[1] as TransactionRequest).blockTag).toBe(456)
    await nftOwners(multi, [{ contract: NFT, tokenId: 1 }])
    expect((mock.calls[2] as TransactionRequest).blockTag).toBeUndefined()
  })
})

describe('tokenPrices 的主币 symbol', () => {
  it('取 Provider 的主币信息：nativeSymbol 配置优先于内置链信息表', async () => {
    const seen: Array<string | null> = []
    const source: PriceSource = { name: 'spy', prices: async (ctx) => (seen.push(ctx.nativeSymbol), new Map([['native', 1]])) }
    await tokenPrices(new Provider(56, createMockProvider(), { nativeSymbol: 'XBNB' }), [NATIVE_TOKEN], { sources: [source] })
    await tokenPrices(new Provider(56, createMockProvider()), [NATIVE_TOKEN], { sources: [source] })
    expect(seen).toEqual(['XBNB', 'BNB'])
  })
})

/** 从入口出发，沿静态（非 type-only）import 收集依赖到的源文件 */
function staticGraph(entry: string): Set<string> {
  const seen = new Set<string>()
  const walk = (file: string) => {
    if (seen.has(file)) return
    seen.add(file)
    const text = readFileSync(file, 'utf8')
    for (const m of text.matchAll(/^(?:import|export)\s+(?!type\b)[^;]*?from\s+'(\.[^']+)'/gm)) {
      walk(resolve(dirname(file), (m[1] as string).replace(/\.js$/, '.ts')))
    }
  }
  walk(entry)
  return new Set([...seen].map((f) => f.slice(SRC.length + 1)))
}

describe('写层按需加载', () => {
  it('/rewards、/liquidity 的首屏不静态依赖签名 / 发送 / 智能账户代码（只经过 write/lazy.ts 动态加载）', () => {
    for (const entry of ['subpaths/rewards.ts', 'subpaths/liquidity.ts']) {
      const files = [...staticGraph(join(SRC, entry))]
      expect(files.filter((f) => (f.startsWith('write/') && f !== 'write/lazy.ts') || f.startsWith('smartAccount/'))).toEqual([])
    }
  })
})
