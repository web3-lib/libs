import { getEventListeners } from 'node:events'

import { describe, expect, it } from 'vitest'

import { getOverview, knownAsset, type ChainOverview } from '../src/index.js'
import { combineChains } from '../src/overview.js'
import { USDC_BSC, USDC_ETH, USDC_SOL, fakeLoaders, portfolioOf } from './fakeChains.js'

const ETH = { token: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE', native: true, symbol: 'ETH', formatted: '2', price: 2000, decimals: 18 }
const evmAddr = '0x0000000000000000000000000000000000000001'

const evmByChain = (owner: string, o: Record<string, any>) =>
  o.chainId === 1
    ? portfolioOf([ETH, { token: USDC_ETH, symbol: 'USDC', formatted: '100', price: 1 }])
    : o.chainId === 56
      ? portfolioOf([{ token: USDC_BSC, symbol: 'USDC', formatted: '50', price: 1, decimals: 18 }])
      : portfolioOf([])

describe('getOverview', () => {
  it('聚合多条链：合计、跨链合并同一资产', async () => {
    const { loaders } = fakeLoaders({
      evm: evmByChain,
      solana: () => portfolioOf([{ token: 'So11111111111111111111111111111111111111112', native: true, symbol: 'SOL', formatted: '3', price: 100, decimals: 9 }, { token: USDC_SOL, symbol: 'USDC', formatted: '25', price: 1 }]),
    })
    const o = await getOverview({ evm: { address: evmAddr, chains: [1, 56] }, solana: { address: 'sol' } }, { loaders })
    expect(o.totalUsd).toBe(4000 + 100 + 50 + 300 + 25)
    expect(o.byChain.map((c) => c.chain)).toEqual(['evm:1', 'solana', 'evm:56'])
    expect(o.byChain.every((c) => c.status === 'ok')).toBe(true)
    const usdc = o.tokens.find((t) => t.key === 'USDC')
    expect(usdc?.amount).toBe(175)
    expect(usdc?.usd).toBe(175)
    expect(usdc?.chains.map((c) => c.chain).sort()).toEqual(['evm:1', 'evm:56', 'solana'])
    expect(o.tokens[0]?.key).toBe('ETH')
    expect(o.errors).toEqual([])
    expect(Object.keys(o.timings.chains).sort()).toEqual(['evm:1', 'evm:56', 'solana'])
  })

  it('一条链失败不影响其他链，错误按链返回', async () => {
    const { loaders } = fakeLoaders({
      evm: (_o, opts) => {
        if (opts.chainId === 56) throw new Error('rpc down')
        return evmByChain(_o, opts)
      },
    })
    const seen: ChainOverview[] = []
    const o = await getOverview({ evm: { address: evmAddr, chains: [1, 56] } }, { loaders, onChain: (r) => seen.push(r) })
    expect(o.totalUsd).toBe(4100)
    expect(o.errors).toEqual([{ chain: 'evm:56', address: evmAddr, message: 'rpc down' }])
    expect(o.byChain.find((c) => c.chain === 'evm:56')).toMatchObject({ status: 'error', error: 'rpc down', tokens: [] })
    expect(seen.map((r) => r.chain).sort()).toEqual(['evm:1', 'evm:56'])
  })

  it('加载器失败只影响那条链', async () => {
    const { loaders } = fakeLoaders({ solana: () => portfolioOf([]) })
    loaders.evm = () => Promise.reject(new Error('not installed'))
    const o = await getOverview({ evm: { address: evmAddr, chains: [1] }, solana: { address: 'sol' } }, { loaders })
    expect(o.errors[0]?.message).toContain('not installed')
    expect(o.errors[0]?.message).toContain('@w3lib/evm-batch-call/price')
    expect(o.byChain.find((c) => c.chain === 'solana')?.status).toBe('ok')
  })

  it('LP 读取失败时降级：保留代币，状态 partial，原因在 warnings', async () => {
    const lpPos = { version: 'v3', protocol: 'uniswap-v3', protocolName: 'Uniswap V3', pool: '0xpool', token0: { address: USDC_ETH, symbol: 'USDC' }, token1: { address: '0x1', symbol: 'WETH' }, amount0Formatted: '1', amount1Formatted: '2', valueUsd: 10, feesUsd: 1, inRange: true }
    const { loaders, calls } = fakeLoaders({
      evm: (_o, opts) => {
        if (opts.chainId === 1 && opts.lp) throw new Error('lp scan failed')
        return opts.chainId === 56 ? portfolioOf([], [lpPos]) : evmByChain(_o, opts)
      },
    })
    const o = await getOverview({ evm: { address: evmAddr, chains: [1, 56] } }, { loaders, lp: true })
    const eth = o.byChain.find((c) => c.chain === 'evm:1') as ChainOverview
    expect(eth.status).toBe('partial')
    expect(eth.warnings).toEqual(['LP positions skipped: lp scan failed'])
    expect(eth.totalUsd).toBe(4100)
    expect(calls.filter((c) => c.options.chainId === 1).map((c) => Boolean(c.options.lp))).toEqual([true, false])
    expect(o.lp).toHaveLength(1)
    expect(o.lp[0]).toMatchObject({ chain: 'evm:56', kind: 'v3', valueUsd: 10, feesUsd: 1, inRange: true })
    expect(o.lp[0]?.tokens.map((t) => t.symbol)).toEqual(['USDC', 'WETH'])
    expect(o.lpUsd).toBe(10)
  })

  it('Solana 不传 tokens：先列出全部持仓，节点不支持时退回内置列表', async () => {
    const { loaders, calls } = fakeLoaders({
      solana: (_o, opts) => {
        if (!opts.tokens) throw new Error('getTokenAccountsByOwner is not supported')
        return portfolioOf([{ token: USDC_SOL, symbol: 'USDC', formatted: '5', price: 1 }])
      },
    })
    const o = await getOverview({ solana: { address: 'sol' } }, { loaders })
    expect(calls).toHaveLength(2)
    expect(calls[1]?.options.tokens).toContain(USDC_SOL)
    expect(o.byChain[0]?.status).toBe('partial')
    expect(o.byChain[0]?.warnings[0]).toContain('built-in token list: getTokenAccountsByOwner is not supported')
    expect(o.totalUsd).toBe(5)
  })

  it('链上的 portfolio.lp 优先：对象与全局合并、不被 lp: true 覆盖；只在链上设了 LP 时失败也降级为 partial', async () => {
    const { loaders, calls } = fakeLoaders({ solana: () => portfolioOf([]) })
    await getOverview({ solana: { address: 'sol', tokens: 'default', portfolio: { lp: { mints: ['m'] } } } }, { loaders, lp: true })
    expect(calls[0]?.options.lp).toEqual({ mints: ['m'] })
    await getOverview({ solana: { address: 'sol', tokens: 'default', portfolio: { lp: { mints: ['m'] } } } }, { loaders, lp: { pools: ['p'] } })
    expect(calls[1]?.options.lp).toEqual({ pools: ['p'], mints: ['m'] })
    await getOverview({ solana: { address: 'sol', tokens: 'default', portfolio: { lp: false } } }, { loaders, lp: true })
    expect(calls[2]?.options.lp).toBeUndefined()

    const failing = fakeLoaders({
      evm: (_o, opts) => {
        if (opts.lp) throw new Error('lp scan failed')
        return evmByChain(_o, opts)
      },
    })
    const o = await getOverview({ evm: { address: evmAddr, chains: [{ chainId: 1, portfolio: { lp: true } }] } }, { loaders: failing.loaders })
    expect(o.byChain[0]?.status).toBe('partial')
    expect(o.byChain[0]?.warnings).toEqual(['LP positions skipped: lp scan failed'])
    expect(o.totalUsd).toBe(4100)
  })

  it('Solana 列出全部 + LP：只有 LP 失败时保留全部持仓；列出失败才退回内置列表，warning 说明真正的原因', async () => {
    const sol = (listing: boolean) =>
      fakeLoaders({
        solana: (_o, opts) => {
          if (opts.lp) throw new Error(listing ? 'listing not supported' : 'lp scan failed')
          if (!opts.tokens && listing) throw new Error('listing not supported')
          return portfolioOf([{ token: USDC_SOL, symbol: 'USDC', formatted: '5', price: 1 }])
        },
      })
    const lpOnly = sol(false)
    const a = await getOverview({ solana: { address: 'sol' } }, { loaders: lpOnly.loaders, lp: true })
    expect(lpOnly.calls.map((c) => [!!c.options.tokens, !!c.options.lp])).toEqual([
      [false, true],
      [false, false],
    ])
    expect(a.byChain[0]?.warnings).toEqual(['LP positions skipped: lp scan failed'])

    const listing = sol(true)
    const b = await getOverview({ solana: { address: 'sol' } }, { loaders: listing.loaders, lp: true })
    expect(listing.calls.map((c) => [!!c.options.tokens, !!c.options.lp])).toEqual([
      [false, true],
      [false, false],
      [true, false],
    ])
    expect(b.byChain[0]?.warnings).toEqual(['holdings listing failed, using the built-in token list: listing not supported', 'LP positions skipped (holdings listing failed)'])
    expect(b.totalUsd).toBe(5)
  })

  it('调用方的 signal 上不残留 abort 监听', async () => {
    const { loaders } = fakeLoaders({ sui: () => portfolioOf([]) })
    const ctl = new AbortController()
    for (let i = 0; i < 3; i++) await getOverview({ sui: { address: '0x1' } }, { loaders, signal: ctl.signal })
    expect(getEventListeners(ctl.signal, 'abort')).toHaveLength(0)
  })

  it('combineChains：同一条链出现多次时 errors 带地址和账户、timings 不互相覆盖', () => {
    const chain = (address: string, ms: number): ChainOverview => ({ chain: 'evm:1', kind: 'evm', chainId: 1, name: 'Ethereum', address, status: 'error', error: 'boom', warnings: [], totalUsd: 0, tokensUsd: 0, lpUsd: 0, tokens: [], lp: [], unpriced: 0, ms })
    const a = chain('0xa', 1)
    const b = chain('0xb', 2)
    const o = combineChains([a, b], 3, false, (c) => (c === a ? 0 : 1))
    expect(o.errors).toEqual([
      { chain: 'evm:1', address: '0xa', account: 0, message: 'boom' },
      { chain: 'evm:1', address: '0xb', account: 1, message: 'boom' },
    ])
    expect(o.timings.chains).toEqual({ 'evm:1@0xa': 1, 'evm:1@0xb': 2 })
    expect(combineChains([a], 1, false).timings.chains).toEqual({ 'evm:1': 1 })
  })

  it('没有价格的代币：不计入价值，标记 unpriced', async () => {
    const { loaders } = fakeLoaders({ sui: () => portfolioOf([{ token: '0x2::foo::FOO', symbol: 'FOO', formatted: '10', price: null }]) })
    const o = await getOverview({ sui: { address: '0x1' } }, { loaders })
    expect(o.totalUsd).toBe(0)
    expect(o.unpriced).toBe(1)
    expect(o.tokens[0]).toMatchObject({ unpriced: true, price: null, usd: 0, known: false })
  })

  it('不认识的代币价值离谱时当价格不可信：不计入合计，认识的资产不受影响', async () => {
    const { loaders } = fakeLoaders({
      evm: () => portfolioOf([ETH, { token: '0x00000000000000000000000000000000000000aa', symbol: 'JUNK', formatted: '1000', price: 5_000_000 }]),
    })
    const o = await getOverview({ evm: { address: evmAddr, chains: [1] } }, { loaders })
    expect(o.totalUsd).toBe(4000)
    expect(o.unpriced).toBe(1)
    expect(o.byChain[0]?.warnings[0]).toContain('JUNK')
    expect(o.byChain[0]?.status).toBe('partial')
    const all = await getOverview({ evm: { address: evmAddr, chains: [1] } }, { loaders, maxUnknownTokenUsd: Infinity })
    expect(all.totalUsd).toBe(5_000_004_000)
  })

  it('同名假币不和真币合并，mergeBySymbol 时才合并', async () => {
    const fake = '0x00000000000000000000000000000000000000f1'
    const { loaders } = fakeLoaders({ evm: () => portfolioOf([{ token: USDC_ETH, symbol: 'USDC', formatted: '1', price: 1 }, { token: fake, symbol: 'USDC', formatted: '9', price: 1 }]) })
    const a = await getOverview({ evm: { address: evmAddr, chains: [1] } }, { loaders })
    expect(a.tokens.map((t) => t.key).sort()).toEqual(['USDC', `evm:1:${fake}`])
    const b = await getOverview({ evm: { address: evmAddr, chains: [1] } }, { loaders, mergeBySymbol: true })
    expect(b.tokens).toHaveLength(1)
    expect(b.tokens[0]?.amount).toBe(10)
  })

  it('代币列表：内置 + 应用 + discover 钩子，去重；defaults: false 只用应用的', async () => {
    const extra = '0x00000000000000000000000000000000000000a1'
    const { loaders, calls } = fakeLoaders({ evm: () => portfolioOf([]) })
    await getOverview(
      { evm: { address: evmAddr, chains: [1, { chainId: 56, defaults: false, tokens: [extra, extra.toUpperCase().replace('0X', '0x')] }], tokens: { 1: [extra] }, discover: ({ chainId }) => (chainId === 1 ? [extra, USDC_ETH] : []) } },
      { loaders },
    )
    const eth = calls.find((c) => c.options.chainId === 1)?.options.tokens as string[]
    expect(eth).toContain(USDC_ETH)
    expect(eth.filter((t) => t.toLowerCase() === extra)).toHaveLength(1)
    expect(eth.filter((t) => t.toLowerCase() === USDC_ETH.toLowerCase())).toHaveLength(1)
    // 主币总是查、排在第一个；应用传的 0xeeee / 零地址不重复
    expect(eth[0]).toBe(ETH.token)
    expect(calls.find((c) => c.options.chainId === 56)?.options.tokens).toEqual([ETH.token, extra])
  })

  it('EVM / Tron 总是查主币：应用传了主币或零地址时不重复', async () => {
    const { loaders, calls } = fakeLoaders({ evm: () => portfolioOf([]) })
    const zero = '0x0000000000000000000000000000000000000000'
    await getOverview(
      { evm: { address: evmAddr, chains: [{ chainId: 250, tokens: [ETH.token.toLowerCase(), zero] }] }, tron: { address: 'T' + 'x'.repeat(33), defaults: false } },
      { loaders },
    )
    expect(calls.find((c) => c.options.chainId === 250)?.options.tokens).toEqual([ETH.token])
    expect(calls.find((c) => c.options.chainId === 728126428)?.options.tokens).toEqual([ETH.token])
  })

  it('主币没有 symbol（不在链信息表里的链）时按链区分，不合并成一项', async () => {
    const native = (formatted: string) => ({ token: ETH.token, native: true, symbol: null as unknown as string, formatted, price: 1, decimals: 18 })
    const { loaders } = fakeLoaders({ evm: (_o, o) => portfolioOf([native(o.chainId === 250 ? '1' : '2')]) })
    const o = await getOverview({ evm: { address: evmAddr, chains: [250, 42220] } }, { loaders })
    expect(o.tokens.map((t) => [t.key, t.known, t.amount]).sort()).toEqual([
      ['evm:250:native', false, 1],
      ['evm:42220:native', false, 2],
    ])
  })

  it('discover: true 用 /owner，失败只产生 warning', async () => {
    const { loaders, calls } = fakeLoaders({
      evm: () => portfolioOf([]),
      evmOwner: () => {
        throw new Error('token list unavailable')
      },
    })
    const o = await getOverview({ evm: { address: evmAddr, chains: [1], discover: true } }, { loaders })
    expect(o.byChain[0]).toMatchObject({ status: 'partial', warnings: ['token discovery failed: token list unavailable'] })
    expect(calls.map((c) => c.module)).toEqual(['evmOwner', 'evm'])
  })

  it('授权风险：无限授权、未知被授权方；Sui / TON 不查', async () => {
    const { loaders } = fakeLoaders({
      evm: () => portfolioOf([{ token: USDC_ETH, symbol: 'USDC', formatted: '100', price: 1 }]),
      evmApprovals: () => [
        { type: 'erc20', token: USDC_ETH, symbol: 'USDC', spender: '0xa', spenderName: '1inch Router v6', unlimited: true },
        { type: 'erc20', token: USDC_ETH, symbol: 'USDC', spender: '0xb', spenderName: null, unlimited: false },
        { type: 'permit2', token: USDC_ETH, symbol: 'USDC', spender: '0xc', spenderName: 'Uniswap', unlimited: true, expired: true },
        { type: 'nft', collection: '0xnft', spender: '0xd', spenderName: null, approved: false },
        { type: 'nft', collection: '0xnft', spender: '0xe', spenderName: 'OpenSea', approved: true },
      ],
      solana: () => portfolioOf([{ token: USDC_SOL, symbol: 'USDC', formatted: '5', price: 1 }]),
      solanaApprovals: () => [
        { mint: USDC_SOL, symbol: 'USDC', delegate: 'D1', delegatedAmount: '18446744073709551615' },
        { mint: USDC_SOL, symbol: 'USDC', delegate: null, delegatedAmount: '0' },
      ],
      sui: () => portfolioOf([]),
    })
    const o = await getOverview({ evm: { address: evmAddr, chains: [1] }, solana: { address: 's' }, sui: { address: '0x1' } }, { loaders, approvals: true })
    expect(o.byChain.find((c) => c.chain === 'evm:1')?.approvals).toMatchObject({ total: 3, unlimited: 2, unknownSpender: 1 })
    expect(o.byChain.find((c) => c.chain === 'solana')?.approvals).toMatchObject({ total: 1, unlimited: 1, unknownSpender: 1 })
    expect(o.byChain.find((c) => c.chain === 'sui')?.approvals).toBeUndefined()
    expect(o.approvals).toMatchObject({ total: 4, unlimited: 3, unknownSpender: 2 })
  })

  it('授权检查出错不影响资产结果', async () => {
    const { loaders } = fakeLoaders({
      evm: () => portfolioOf([{ token: USDC_ETH, symbol: 'USDC', formatted: '100', price: 1 }]),
      evmApprovals: () => {
        throw new Error('boom')
      },
    })
    const o = await getOverview({ evm: { address: evmAddr, chains: [1] } }, { loaders, approvals: true })
    expect(o.totalUsd).toBe(100)
    expect(o.byChain[0]).toMatchObject({ status: 'partial', warnings: ['approvals check failed: boom'] })
  })

  it('并发限制', async () => {
    let active = 0
    let max = 0
    const { loaders } = fakeLoaders({
      evm: async () => {
        active++
        max = Math.max(max, active)
        await new Promise((r) => setTimeout(r, 10))
        active--
        return portfolioOf([])
      },
    })
    await getOverview({ evm: { address: evmAddr, chains: [1, 10, 56, 137, 8453, 42161] } }, { loaders, concurrency: 2 })
    expect(max).toBe(2)
  })

  it('取消：已取消的 signal 直接抛出；中途取消抛出 reason，不再启动新的链', async () => {
    const { loaders, calls } = fakeLoaders({ evm: () => new Promise(() => {}) })
    const pre = AbortSignal.abort(new Error('stop'))
    await expect(getOverview({ evm: { address: evmAddr, chains: [1] } }, { loaders, signal: pre })).rejects.toThrow('stop')
    expect(calls).toHaveLength(0)
    const ctl = new AbortController()
    const p = getOverview({ evm: { address: evmAddr, chains: [1, 56, 10] } }, { loaders, signal: ctl.signal, concurrency: 1 })
    setTimeout(() => ctl.abort(new Error('user cancelled')), 20)
    await expect(p).rejects.toThrow('user cancelled')
    await new Promise((r) => setTimeout(r, 20))
    expect(calls).toHaveLength(1)
  })

  it('单条链超时按出错处理', async () => {
    const { loaders } = fakeLoaders({ ton: () => new Promise(() => {}), sui: () => portfolioOf([]) })
    const o = await getOverview({ ton: { address: 'UQ' }, sui: { address: '0x1' } }, { loaders, chainTimeoutMs: 30 })
    expect(o.errors).toEqual([{ chain: 'ton', address: 'UQ', message: 'timed out after 30ms' }])
    expect(o.byChain.find((c) => c.chain === 'sui')?.status).toBe('ok')
  })

  it('参数传递：节点参数、价格源和 chainId；minUsd 不交给链包，只过滤列出的代币（链上的优先）', async () => {
    const list = portfolioOf([{ token: USDC_BSC, symbol: 'USDC', formatted: '3', price: 1 }, { token: '0x00000000000000000000000000000000000000b2', symbol: 'X', formatted: '9', price: null }])
    const { loaders, calls } = fakeLoaders({ evm: () => list, ton: () => list })
    const sources = [{ name: 's' }]
    const o = await getOverview(
      { evm: { address: evmAddr, chains: [{ chainId: 56, node: { provider: 'https://rpc' }, portfolio: { minUsd: 5 } }] }, ton: { address: 'UQ', node: { apiKey: 'k' } } },
      { loaders, sources: { evm: sources }, minUsd: 1 },
    )
    expect(calls[0]?.options).toMatchObject({ chainId: 56, provider: 'https://rpc', sources })
    expect(calls[1]?.options).toMatchObject({ apiKey: 'k' })
    expect(calls.every((c) => c.options.minUsd === undefined)).toBe(true)
    expect(calls[1]?.options.chainId).toBeUndefined()
    expect(o.byChain.find((c) => c.chain === 'evm:56')?.tokens).toEqual([])
    expect(o.byChain.find((c) => c.chain === 'ton')?.tokens.map((t) => t.symbol)).toEqual(['USDC'])
    expect(o.totalUsd).toBe(6)
  })

  it('授权检查用 minUsd 过滤前的持仓：零头、没有价格的代币也查', async () => {
    const dust = '0x00000000000000000000000000000000000000d1'
    const { loaders, calls } = fakeLoaders({
      evm: () => portfolioOf([{ token: USDC_ETH, symbol: 'USDC', formatted: '0.01', price: 1 }, { token: dust, symbol: 'D', formatted: '5', price: null }]),
      evmApprovals: () => [{ type: 'erc20', token: dust, symbol: 'D', spender: '0xbad', spenderName: null, unlimited: true }],
    })
    const o = await getOverview({ evm: { address: evmAddr, chains: [1] } }, { loaders, approvals: true, minUsd: 1 })
    expect(calls.find((c) => c.module === 'evmApprovals')?.options.tokens.sort()).toEqual([USDC_ETH, dust].sort())
    expect(o.byChain[0]?.tokens).toEqual([])
    expect(o.approvals).toMatchObject({ total: 1, unlimited: 1, unknownSpender: 1 })
  })

  it('不带 LP 也失败时报这一次的错误，不再重试；Solana 内置列表也失败时两个原因都给出', async () => {
    const { loaders, calls } = fakeLoaders({
      evm: (_o, o) => {
        throw new Error(o.lp ? 'lp: rpc down' : 'rpc down')
      },
    })
    const o = await getOverview({ evm: { address: evmAddr, chains: [1] } }, { loaders, lp: true })
    expect(o.errors[0]?.message).toBe('rpc down')
    expect(calls).toHaveLength(2)

    const sol = fakeLoaders({
      solana: (_o, o) => {
        throw new Error(o.tokens ? 'fetch failed' : 'listing not supported')
      },
    })
    const s = await getOverview({ solana: { address: 'sol' } }, { loaders: sol.loaders })
    expect(s.errors[0]?.message).toBe('listing not supported; built-in token list also failed: fetch failed')
    expect(sol.calls).toHaveLength(2)
  })

  it('Tron 走 EVM 模块，用 evm 价格源作为默认', async () => {
    const { loaders, calls } = fakeLoaders({ evm: () => portfolioOf([{ token: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', symbol: 'USDT', formatted: '7', price: 1 }]) })
    const sources = [{ name: 's' }]
    const o = await getOverview({ tron: { address: 'T' + 'x'.repeat(33) } }, { loaders, sources: { evm: sources } })
    expect(calls[0]?.options).toMatchObject({ chainId: 728126428, sources })
    expect(o.tokens[0]?.key).toBe('USDT')
  })

  it('输入校验', async () => {
    await expect(getOverview({})).rejects.toThrow('at least one')
    await expect(getOverview({ evm: { address: evmAddr, chains: [] } })).rejects.toThrow('at least one chain')
    await expect(getOverview({ evm: { address: evmAddr, chains: [-1] } })).rejects.toThrow('invalid EVM chain id')
    await expect(getOverview({ ton: { address: '' } })).rejects.toThrow('address')
  })
})

describe('内置资产表', () => {
  it('跨链认出同一个资产', () => {
    expect(knownAsset('evm:1', USDC_ETH.toLowerCase())).toBe('USDC')
    expect(knownAsset('solana', USDC_SOL)).toBe('USDC')
    expect(knownAsset('sui', '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC')).toBe('USDC')
    expect(knownAsset('ton', 'EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs')).toBe('USDT')
    expect(knownAsset('ton', '0:B113A994B5024A16719F69139328EB759596C38A25F59028B146FECDC3621DFE')).toBe('USDT')
    expect(knownAsset('evm:1', '0x00000000000000000000000000000000000000f1')).toBeUndefined()
  })
})
