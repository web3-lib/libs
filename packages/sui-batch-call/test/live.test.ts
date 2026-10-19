/**
 * 连主网公共全节点（gRPC-web）的测试，默认跳过：`LIVE=1 NODE_USE_ENV_PROXY=1 npx vitest run test/live.test.ts`
 * 地址是 2026-10 时的活跃地址，之后余额可能变化；只检查结构和一致性
 */
import { describe, expect, it } from 'vitest'

import { SUI_COIN_TYPE, SuiClient, normalizeSuiAddress } from '../src/index.js'

const live = process.env.LIVE ? describe : describe.skip
const sui = new SuiClient(process.env.SUI_GRPC)
const OWNER = '0xffd4f043057226453aeba59732d41c6093516f54823ebc3a16d17f8a77d2f0ad'
const SUINS_HOLDER = '0xc5fcbe33baba979d09123a2b81dc2ad78fd1b3c28e26c5acf9ccbf095e2fb4a3'
/** 2026-10 时持有几个 USDC Coin 的地址（dryRun 用） */
const USDC_HOLDER = '0x9f63425709069336fec108bd4ba69a8f3d23e8ab237311f3ce58ae2bb0ed4d7f'
const USDC = '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC'

live('Sui 主网', { timeout: 60_000 }, () => {
  it('节点信息：主网', async () => {
    const info = await sui.serviceInfo()
    expect(info.chain).toBe('mainnet')
    expect(info.checkpointHeight).toBeGreaterThan(0n)
  })

  it('全部余额与按类型查询一致；短格式类型规范化', async () => {
    const all = await sui.balances(OWNER, undefined, { symbol: true })
    const sui0 = all.find((b) => b.native)
    expect(sui0).toMatchObject({ token: SUI_COIN_TYPE, decimals: 9, symbol: 'SUI', success: true })
    const [one] = await sui.balances(OWNER, ['0x2::sui::SUI'], { withCheckpoint: true })
    expect(one?.token).toBe(SUI_COIN_TYPE)
    expect(one?.checkpoint).toBeGreaterThan(0)
    // 两次读取之间余额可能变化：只要求都是非负整数
    expect(BigInt(one?.balance ?? '-1')).toBeGreaterThanOrEqual(0n)
  })

  it('代币信息：USDC', async () => {
    const [usdc] = await sui.coins([USDC])
    expect(usdc).toMatchObject({ decimals: 6, symbol: 'USDC', success: true })
    expect(BigInt(usdc?.totalSupply ?? '0')).toBeGreaterThan(0n)
  })

  it('对象：系统对象是共享对象；不存在的为 null', async () => {
    const [clock, missing] = await sui.objects(['0x6', '0x1234567890'], { fields: ['type', 'owner', 'json'] })
    expect(clock?.owner?.kind).toBe('shared')
    expect(clock?.type).toBe(`${normalizeSuiAddress('0x2')}::clock::Clock`)
    expect((clock?.json as { timestamp_ms?: string })?.timestamp_ms).toMatch(/^\d+$/)
    expect(missing).toBe(null)
  })

  it('拥有的对象：按 0x2::coin::Coin 前缀过滤只返回代币', async () => {
    const coins = await sui.ownedObjects(OWNER, { type: '0x2::coin::Coin', limit: 20 })
    expect(coins.length).toBeGreaterThan(0)
    expect(coins.every((o) => o.type?.startsWith(`${normalizeSuiAddress('0x2')}::coin::Coin<`))).toBe(true)
  })

  it('NFT：节点渲染的 Display（SuiNS）', async () => {
    const nfts = await sui.nfts(SUINS_HOLDER)
    const suins = nfts.find((n) => n.display && n.projectUrl === 'https://suins.io')
    expect(suins?.name).toMatch(/\.sui$/)
    expect(suins?.imageUrl).toMatch(/^https:\/\//)
  })
})

/** 只能模拟的签名器：主网 dryRun 用，模拟不需要签名 */
const watchOnly = (address: string) => ({ address, signTransaction: async (): Promise<string> => { throw new Error('watch-only') } })

live('Sui 主网写操作（dryRun，只模拟）', { timeout: 60_000 }, () => {
  it('SUI + USDC 混合一对多转账，同一笔交易', async () => {
    const { batchTransfer } = await import('../src/subpaths/write.js')
    const results = await batchTransfer(sui, watchOnly(USDC_HOLDER), [
      { to: SUINS_HOLDER, formatted: '0.001' },
      { to: SUINS_HOLDER, token: USDC, formatted: '0.01' },
      { to: USDC_HOLDER, token: USDC, amount: 1n },
    ], { dryRun: true, sponsor: watchOnly(OWNER) })
    expect(results.map((r) => [r.status, r.error])).toEqual([['simulated', null], ['simulated', null], ['simulated', null]])
    expect(results[1]?.formatted).toBe('0.01')
    expect(BigInt(results[0]?.fee ?? '0')).toBeGreaterThan(0n)
  })

  it('赞助归集 USDC + SUI：子钱包不付 gas', async () => {
    const { batchCollect } = await import('../src/subpaths/write.js')
    const [r] = await batchCollect(sui, [watchOnly(USDC_HOLDER)], SUINS_HOLDER, { tokens: [USDC, SUI_COIN_TYPE], sponsor: watchOnly(OWNER), dryRun: true })
    expect(r).toMatchObject({ status: 'simulated', error: null, tokens: [USDC, SUI_COIN_TYPE] })
  })

  it('余额不够时发送前就报错', async () => {
    const { batchTransfer } = await import('../src/subpaths/write.js')
    await expect(batchTransfer(sui, watchOnly(USDC_HOLDER), [{ to: SUINS_HOLDER, token: USDC, formatted: '1000000000' }], { dryRun: true })).rejects.toThrow(/Insufficient balance/)
  })
})
