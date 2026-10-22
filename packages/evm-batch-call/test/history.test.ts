import { Interface } from 'ethers'
import { describe, expect, it } from 'vitest'

import type { Provider } from '../src/index.js'
import { HistorySourceError, history, blockscoutSource, type HistoryAdapter, type RawPage } from '../src/subpaths/history.js'

const ME = '0x1111111111111111111111111111111111111111'
const OTHER = '0x2222222222222222222222222222222222222222'
const ROUTER = '0x7a250d5630b4cf539739df2c5dacb4c659f2488d' // Uniswap V2 Router02（以太坊）
const USDT = '0xdac17f958d2ee523a2206206994597c13d831ec7'
const NFT = '0x3333333333333333333333333333333333333333'
const ZERO = '0x0000000000000000000000000000000000000000'
const provider = { getChainId: async () => 1 } as unknown as Provider

const erc20 = new Interface(['function approve(address spender, uint256 amount)'])
const v2 = new Interface(['function swapExactETHForTokens(uint256 amountOutMin, address[] path, address to, uint256 deadline)'])

const tx = (hash: string, block: number, o: Record<string, string> = {}) => ({ hash, blockNumber: String(block), timeStamp: String(1_700_000_000 + block), from: ME, to: OTHER, value: '0', input: '0x', isError: '0', txreceipt_status: '1', gasUsed: '21000', gasPrice: '10', ...o })

/** 假的 Etherscan 兼容接口：按 action 返回预设的行，支持 endblock */
function fakeFetch(data: Record<string, Array<Record<string, string>>>, calls: string[] = []): typeof fetch {
  return (async (input: string) => {
    const url = new URL(String(input))
    calls.push(url.toString())
    const action = url.searchParams.get('action') as string
    const end = Number(url.searchParams.get('endblock') ?? Number.MAX_SAFE_INTEGER)
    const offset = Number(url.searchParams.get('offset'))
    const rows = (data[action] ?? []).filter((r) => Number(r.blockNumber) <= end).sort((a, b) => Number(b.blockNumber) - Number(a.blockNumber)).slice(0, offset)
    return new Response(JSON.stringify({ status: rows.length ? '1' : '0', message: rows.length ? 'OK' : 'No transactions found', result: rows }))
  }) as unknown as typeof fetch
}

describe('history（Etherscan 兼容数据）', () => {
  const data = {
    txlist: [
      tx('0xswap', 100, { to: ROUTER, value: '1000000000000000000', input: v2.encodeFunctionData('swapExactETHForTokens', [0n, [ROUTER, USDT], ME, 1n]) }),
      tx('0xapprove', 90, { to: USDT, input: erc20.encodeFunctionData('approve', [ROUTER, 2n ** 256n - 1n]) }),
      tx('0xfailed', 80, { to: ROUTER, isError: '1', txreceipt_status: '0', input: v2.encodeFunctionData('swapExactETHForTokens', [0n, [ROUTER, USDT], ME, 1n]) }),
      tx('0xsend', 70, { to: OTHER, value: '5000' }),
    ],
    txlistinternal: [],
    tokentx: [
      { hash: '0xswap', blockNumber: '100', timeStamp: '1700000100', from: ROUTER, to: ME, value: '2500000000', contractAddress: USDT, tokenSymbol: 'USDT', tokenDecimal: '6' },
      { hash: '0xairdrop', blockNumber: '60', timeStamp: '1700000060', from: OTHER, to: ME, value: '7000000', contractAddress: USDT, tokenSymbol: 'USDT', tokenDecimal: '6' },
    ],
    tokennfttx: [{ hash: '0xmint', blockNumber: '50', timeStamp: '1700000050', from: ZERO, to: ME, contractAddress: NFT, tokenID: '7', tokenSymbol: 'APE' }],
  }
  const adapter = blockscoutSource({ 1: 'https://explorer.test/api' })
  const opts = { source: [adapter], fetch: fakeFetch(data), limit: 100 }

  it('分类：兑换 / 授权 / 失败 / 转账 / 空投 / 铸造', async () => {
    const { items, nextCursor } = await history(provider, ME, opts)
    const by = Object.fromEntries(items.map((a) => [a.hash, a]))
    expect(nextCursor).toBeUndefined()
    expect(by['0xswap']).toMatchObject({ type: 'swap', status: 'success', protocol: 'Uniswap V2 Router', method: 'swapExactETHForTokens', fee: '210000' })
    expect(by['0xswap']?.changes.map((c) => [c.symbol, c.formatted])).toEqual([['ETH', '-1'], ['USDT', '2500']])
    expect(by['0xswap']?.label).toBe('Swapped 1 ETH for 2500 USDT on Uniswap V2 Router')
    expect(by['0xapprove']).toMatchObject({ type: 'approve', changes: [] })
    expect(by['0xfailed']).toMatchObject({ type: 'swap', status: 'failed', changes: [] })
    expect(by['0xsend']).toMatchObject({ type: 'transfer', direction: 'out', counterparty: '0x2222222222222222222222222222222222222222' })
    expect(by['0xairdrop']).toMatchObject({ type: 'transfer', direction: 'in' })
    expect(by['0xairdrop']?.fee).toBeUndefined() // 不是发送者，没有手续费
    expect(by['0xmint']).toMatchObject({ type: 'mint', direction: 'in', changes: [{ asset: '0x3333333333333333333333333333333333333333', decimals: 0, delta: '1', tokenId: '7' }] })
    // 最新的在前
    expect(items.map((a) => a.block)).toEqual([100, 90, 80, 70, 60, 50])
  })

  it('types 过滤；before / after', async () => {
    expect((await history(provider, ME, { ...opts, types: ['approve', 'mint'] })).items.map((a) => a.hash)).toEqual(['0xapprove', '0xmint'])
    expect((await history(provider, ME, { ...opts, after: 1_700_000_080 })).items.map((a) => a.hash)).toEqual(['0xswap', '0xapprove', '0xfailed'])
  })

  it('分页：列表被截断的区块留到下一页，不丢不重', async () => {
    const seen: string[] = []
    let cursor: string | undefined
    for (let i = 0; i < 10; i++) {
      const page = await history(provider, ME, { ...opts, limit: 2, maxPages: 1, cursor })
      seen.push(...page.items.map((a) => a.hash))
      cursor = page.nextCursor
      if (!cursor) break
    }
    expect(new Set(seen).size).toBe(seen.length)
    expect(seen.sort()).toEqual(['0xairdrop', '0xapprove', '0xfailed', '0xmint', '0xsend', '0xswap'])
  })

  it('故障切换；全部失败给出每个来源的错误', async () => {
    const broken: HistoryAdapter = { name: 'broken', fetch: () => Promise.reject(new Error('boom')) }
    const page = await history(provider, ME, { ...opts, source: [broken, adapter] })
    expect(page.source).toBe('blockscout')
    const err = await history(provider, ME, { ...opts, source: [broken] }).catch((e) => e)
    expect(err).toBeInstanceOf(HistorySourceError)
    expect(err.message).toContain('broken: boom')
  })

  it('适配器返回自定义原始记录也能用；非法地址 / cursor 报错', async () => {
    const custom: HistoryAdapter = {
      name: 'custom',
      fetch: async (): Promise<RawPage> => ({ txs: [{ hash: '0xa', pos: 5, block: 5, time: 5, from: ME, to: OTHER, value: 1n, input: '0x', ok: true }], moves: [], completeFrom: 0 }),
    }
    const page = await history(provider, ME, { source: custom })
    expect(page.items[0]).toMatchObject({ type: 'transfer', direction: 'out', changes: [{ asset: 'native', delta: '-1' }] })
    await expect(history(provider, '0x123', { source: custom })).rejects.toThrow('Invalid address')
    await expect(history(provider, ME, { source: custom, cursor: 'x' })).rejects.toThrow('Invalid cursor')
  })
})
