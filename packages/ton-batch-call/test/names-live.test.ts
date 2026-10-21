/**
 * 域名解析连主网，默认跳过：`LIVE=1 NODE_USE_ENV_PROXY=1 npx vitest run test/names-live.test.ts`（TONCENTER_API_KEY 可选）
 * 名字和地址是 2026-10 时的真实记录（之后持有人可能修改）
 */
import { describe, expect, it } from 'vitest'

import { TonClient, sameTonAddress, toRawAddress, type TonAddress } from '../src/index.js'
import { runGetMethod } from '../src/getters.js'
import { NAME_SERVICES, TON_DNS_ROOT, lookupAddresses, resolveNames } from '../src/subpaths/names.js'
import { beginCell } from '../src/write/cell.js'

const live = process.env.LIVE ? describe : describe.skip
const ton = new TonClient(process.env.TONCENTER_URL, process.env.TONCENTER_API_KEY ? { apiKey: process.env.TONCENTER_API_KEY } : {})

const FOUNDATION_WALLET = 'UQCD39VS5jcptHL8vMjEXrzGaRcCVYto7HUn4bpAOg8xqEBI'
/** tolya.ton 的持有人，wallet 记录指向自己 */
const TOLYA = 'UQCdqXGvONLwOr3zCNX5FjapflorB6ZsOdcdfLrjsDLt3AF4'
/** stud.t.me 的持有人，wallet 记录指向自己 */
const STUD = '0:7AC99F3334F8F1A09A70733F4BA90BE556EC4B8480FB6F3459A69F7CA2E0667E'

live('TON DNS（主网）', { timeout: 120_000 }, () => {
  it('根 DNS 对 .ton / .t.me 返回的就是内置的解析合约', async () => {
    for (const s of NAME_SERVICES.filter((x) => x.network === 'mainnet')) {
      const bytes = new TextEncoder().encode(`${['w3lib', ...s.suffix.split('.')].reverse().join('\0')}\0`)
      const stack = await runGetMethod(ton.transport, TON_DNS_ROOT.mainnet, 'dnsresolve', [
        { type: 'slice', cell: beginCell().storeBytes(bytes).endCell() },
        { type: 'num', value: 0n },
      ])
      // 解析掉后缀（不含后面的 \0），下一个 resolver 是集合
      expect(Number(stack.num())).toBe(s.suffix.length * 8)
      const record = stack.cell().beginParse()
      expect(record.loadUintNumber(16)).toBe(0xba93)
      expect(toRawAddress(record.loadAddress() as TonAddress)).toBe(toRawAddress(s.resolver))
    }
  })

  it('正查：.ton、.t.me；注册了没设置钱包、没注册的为 null；与索引器的 dns/records 一致', async () => {
    const missing = `w3lib-${Date.now()}-nobody.ton`
    const resolved = await resolveNames(ton, ['foundation.ton', 'Tolya.ton', 'stud.t.me', 'wallet.ton', missing])
    expect(resolved).toEqual([
      { name: 'foundation.ton', normalized: 'foundation.ton', address: FOUNDATION_WALLET, service: 'ton' },
      { name: 'Tolya.ton', normalized: 'tolya.ton', address: TOLYA, service: 'ton' },
      { name: 'stud.t.me', normalized: 'stud.t.me', address: 'UQB6yZ8zNPjxoJpwcz9LqQvlVuxLhID7bzRZpp98ouBmfoEJ', service: 't.me' },
      { name: 'wallet.ton', normalized: 'wallet.ton', address: null, service: 'ton' },
      { name: missing, normalized: missing, address: null, service: 'ton' },
    ])
    const indexed = await ton.transport.get<{ records: Array<{ domain: string; dns_wallet: string | null }> }>('dns/records', { domain: 'foundation.ton' })
    expect(sameTonAddress(indexed.records[0]?.dns_wallet as string, FOUNDATION_WALLET)).toBe(true)
  })

  it('反查：地址簿的名字正查核对；只被别人的名字指向的地址为 null', async () => {
    const names = await lookupAddresses(ton, [TOLYA, STUD, FOUNDATION_WALLET])
    expect(names).toEqual([
      { address: TOLYA, name: 'tolya.ton', service: 'ton' },
      { address: STUD, name: 'stud.t.me', service: 't.me' },
      // foundation.ton 指向它，但 NFT 在 tolya.ton 的持有人手里
      { address: FOUNDATION_WALLET, name: null, service: null },
    ])
  })
})
