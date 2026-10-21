/**
 * 域名解析连主网，默认跳过：`LIVE=1 NODE_USE_ENV_PROXY=1 npx vitest run test/names-live.test.ts`
 * 名字是 2026-10 时各服务的真实名字
 */
import { describe, expect, it } from 'vitest'

import { Provider, TRON_CHAIN_ID } from '../src/index.js'
import { lookupAddresses, resolveNames } from '../src/subpaths/names.js'

const live = process.env.LIVE ? describe : describe.skip

const CASES = [
  { chainId: 1, service: 'ens', name: 'Vitalik.eth', normalized: 'vitalik.eth', address: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045' },
  { chainId: 56, service: 'spaceid', name: 'spaceid.bnb', normalized: 'spaceid.bnb', address: '0xb5932a6B7d50A966AEC6C74C97385412Fb497540' },
  { chainId: 8453, service: 'basenames', name: 'jesse.base.eth', normalized: 'jesse.base.eth', address: '0x2211d1D0020DAEA8039E46Cf1367962070d77DA9' },
]

for (const c of CASES) {
  live(`${c.service}（${c.chainId}）`, { timeout: 60_000 }, () => {
    it('正查、反查（正查核对），不存在 / 不合法的名字为 null', async () => {
      const provider = new Provider(c.chainId)
      const missing = `w3lib-${Date.now()}-nobody.${c.normalized.split('.').slice(1).join('.')}`
      const resolved = await resolveNames(provider, [c.name, missing, 'not a name'])
      expect(resolved).toEqual([
        { name: c.name, normalized: c.normalized, address: c.address, service: c.service },
        { name: missing, normalized: missing, address: null, service: c.service },
        { name: 'not a name', normalized: null, address: null, service: null },
      ])
      const names = await lookupAddresses(provider, [c.address, '0x0000000000000000000000000000000000000001'])
      expect(names).toEqual([
        { address: c.address, name: c.normalized, service: c.service },
        { address: '0x0000000000000000000000000000000000000001', name: null, service: null },
      ])
    })
  })
}

live('Tron', () => {
  it('没有域名服务：都为 null', async () => {
    const provider = new Provider(TRON_CHAIN_ID.mainnet)
    expect((await resolveNames(provider, ['vitalik.eth']))[0]?.address).toBe(null)
    expect((await lookupAddresses(provider, ['TW7igRFaUUFWNuwsuVw1xiMQcDf4pf7SWe']))[0]?.name).toBe(null)
  })
})
