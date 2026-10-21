/**
 * SNS 域名解析连主网，默认跳过：`LIVE=1 NODE_USE_ENV_PROXY=1 npx vitest run test/names-live.test.ts`
 * - SOLANA_RPC：自己的节点；默认官方节点（关闭批量合并：官方节点对批量请求限频更严）
 * 名字和地址是 2026-10 时主网的真实数据
 */
import { describe, expect, it } from 'vitest'

import { HttpRpc, SolanaClient } from '../src/index.js'
import { lookupAddresses, resolveNames, snsDomainKey } from '../src/subpaths/names.js'

const live = process.env.LIVE ? describe : describe.skip
const client = new SolanaClient(new HttpRpc(process.env.SOLANA_RPC ?? 'https://api.mainnet-beta.solana.com', { batch: false }), { cluster: 'mainnet' })

const BONFIDA_OWNER = 'Fw1ETanDZafof7xEULsnq9UY6o71Tpds89tNwPkWLb1v'
const TOLY = '86xCnPeV69n6t3DnyGvkKobf9FdN2H9oiVDdaMpo2MMY'

live('SNS（Solana 主网）', { timeout: 60_000 }, () => {
  it('正查：owner、规范化；不存在 / 不合法的为 null；.sol 默认不解析，legacySol 时按同名 .sns', async () => {
    expect(snsDomainKey('bonfida').key).toBe('Crf8hzfthWGbGbLTVCiqRqV5MVnbpHB1L9KQMd6gsinb')
    const missing = `w3lib-${Date.now()}-nobody.sns`
    const list = await resolveNames(client, ['bonfida.sns', 'Toly.SNS', missing, 'toly.sol', 'not a name'])
    expect(list).toEqual([
      { name: 'bonfida.sns', normalized: 'bonfida.sns', address: BONFIDA_OWNER, owner: BONFIDA_OWNER, source: 'owner', service: 'sns' },
      { name: 'Toly.SNS', normalized: 'toly.sns', address: TOLY, owner: TOLY, source: 'owner', service: 'sns' },
      { name: missing, normalized: missing, address: null, owner: null, source: null, service: 'sns' },
      { name: 'toly.sol', normalized: null, address: null, owner: null, source: null, service: null },
      { name: 'not a name', normalized: null, address: null, owner: null, source: null, service: null },
    ])
    const [legacy] = await resolveNames(client, ['toly.sol'], { legacySol: true })
    expect(legacy).toMatchObject({ normalized: 'toly.sns', address: TOLY })
  })

  it('代币化的域名（crypto.sns）：来源是 NFT；免费节点不支持 getTokenLargestAccounts 时 address 为 null', async () => {
    const [crypto] = await resolveNames(client, ['crypto.sns'])
    expect(crypto?.source).toBe('nft')
    expect(crypto?.address === null || typeof crypto?.address === 'string').toBe(true)
  })

  it('反查主域名并正查核对；主域名已经转给别人的为 null', async () => {
    // HKKp…（bonfida.sns 的旧 owner）的主域名还指向 bonfida.sns，但它已经不是 owner
    const list = await lookupAddresses(client, [BONFIDA_OWNER, 'HKKp49qGWXd639QsuH7JiLijfVW5UtCVY4s1n2HANwEA', TOLY])
    expect(list[1]).toEqual({ address: 'HKKp49qGWXd639QsuH7JiLijfVW5UtCVY4s1n2HANwEA', name: null, service: null })
    expect(list[2]?.name).toBe(null) // toly 没有设置主域名
    const name = list[0]?.name
    expect(name).toMatch(/\.sns$/)
    const [forward] = await resolveNames(client, [name as string])
    expect(forward?.owner).toBe(BONFIDA_OWNER)
  })
})
