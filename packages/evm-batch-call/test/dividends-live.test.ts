/** Flap 分红连 BSC 主网：读取有分红的真实持有人（含美元价值），再用 discover 从最近收到的 Transfer 里发现代币。默认跳过：`LIVE=1 NODE_USE_ENV_PROXY=1 npx vitest run test/dividends-live.test.ts` */
import { describe, expect, it } from 'vitest'

import { Provider } from '../src/index.js'
import { dividends } from '../src/subpaths/dividends.js'

const live = process.env.LIVE ? describe : describe.skip
const TOKEN = '0x78dE1541Dc85b0c89035ed8Bb3F0e25685A87777' // 分红资产是 BNB
const HOLDERS = ['0x7Ce5EC73d78a3988f06898286048EFa106D5B555', '0x1caE4e55478b3a07aC9A3FF5854095aF4eFF49Ff', '0xBa1d7BeFE69f4ea09D82eD30f56d8948C9bFb6D9']
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'

live('Flap 分红（BSC 主网）', { timeout: 120_000 }, () => {
  // 内置公共节点（不带地址的 Transfer 查询只有部分节点支持，且区块范围很小，如 25 / 50 个区块，靠自动缩小范围和节点切换）
  const provider = new Provider(56)

  it('读取真实持有人：可领取 > 0、分红资产 BNB、有美元价值', async () => {
    let found = false
    for (const h of HOLDERS) {
      const { items, priceError } = await dividends(provider, h, { tokens: [TOKEN] })
      if (!items[0]) continue
      found = true
      expect(items[0]).toMatchObject({ asset: 'native', assetSymbol: 'BNB' })
      expect(priceError).toBeUndefined()
      expect(items[0].usd).toBeGreaterThan(0)
      break
    }
    expect(found).toBe(true)
  })

  it('discover：最近收到过这个代币的地址能发现它', async () => {
    const head = (await provider.getBlockNumber()) - 20
    const logs = await provider.getLogs({ address: TOKEN, topics: [TRANSFER], fromBlock: head - 80, toBlock: head })
    const receiver = logs.map((l) => `0x${(l.topics[2] ?? '').slice(26)}`).find((a) => /^0x[0-9a-f]{40}$/.test(a))
    if (!receiver) return // 这段时间没有人交易
    const r = await dividends(provider, receiver, { discover: { lookbackBlocks: 100, blockRange: 100, maxRequests: 12 }, prices: false, includeZero: true })
    expect(r.scan?.tokens.map((t) => t.toLowerCase())).toContain(TOKEN.toLowerCase())
    expect(r.items.some((i) => i.token === TOKEN)).toBe(true)
  })
})
