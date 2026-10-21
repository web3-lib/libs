/**
 * SuiNS 连主网 / 测试网，默认跳过：`LIVE=1 NODE_USE_ENV_PROXY=1 npx vitest run test/names-live.test.ts`
 * 名字是 2026-10 时的真实名字，结果和 Sui GraphQL（address(name:) / defaultNameRecord）核对过
 */
import { describe, expect, it } from 'vitest'

import { SuiClient } from '../src/index.js'
import { json } from '../src/dex/util.js'
import { dynamicFieldId } from '../src/dynamicField.js'
import { SUINS, lookupAddresses, resolveNames, type SuinsConfig } from '../src/subpaths/names.js'

const live = process.env.LIVE ? describe : describe.skip

const EXAMPLE = '0x214a4199264348df2364acd683a3971a9927a5252747f4e0776f0506922f9db0'
const ADENIYI = '0x1eb7c57e3f2bd0fc6cb9dcffd143ea957e4d98f805c358733f76dee0667fe0b1'
const MANOS = '0x690e41a0796073ea1dfd65ca2fe48d826ac0b2030ecd77dc062bc63355086bee'
const CNY = '0xc3e9ab28843910fe4368002393f90fed4cee68c83a1448e1efbfb25b01bd85e8'
/** goodsoul.sui 2025-01 过期了，反查记录还在 */
const GOODSOUL = '0xcc4655e5ec29a07af203a84c48b9a6b388b2d3c52b9f274738351e39c3a247cb'

live('SuiNS（主网）', { timeout: 60_000 }, () => {
  const sui = new SuiClient(process.env.SUI_GRPC)

  it('正查：@ 格式、大小写、叶子 / 节点子域名；过期、父域名重新注册过的叶子、不存在的为 null', async () => {
    const list = await resolveNames(sui, ['example.sui', '@adeniyi', 'Manos.SUI', 'cny@stashed', 'shafiq.talise.sui', '2349013927723.kns.sui', 'goodsoul.sui', 'suins.sui', `w3lib-${Date.now()}.sui`, 'not a name'])
    expect(list.map((r) => [r.normalized, r.address])).toEqual([
      ['example.sui', EXAMPLE],
      ['adeniyi.sui', ADENIYI],
      ['manos.sui', MANOS],
      ['cny.stashed.sui', CNY], // 叶子：跟随 stashed.sui
      ['shafiq.talise.sui', '0x9a7cfed73929737b3fe88d9855bbf8608f3a3aad9fd156a6c83607844f318a11'], // 节点子域名
      ['2349013927723.kns.sui', null], // 叶子的 NFT 和 kns.sui 现在的对不上
      ['goodsoul.sui', null], // 过期
      ['suins.sui', null], // 没设地址
      [list[8]?.name, null],
      [null, null],
    ])
    expect(list[0]?.expiresAt).toBeGreaterThan(Date.now())
    expect(list[3]?.expiresAt).toBe((await resolveNames(sui, ['stashed.sui']))[0]?.expiresAt)
    expect(list[6]?.expiresAt).toBe(1738117854099)
  })

  it('反查（正查核对）：过期名字的反查记录不算；没有反查记录的为 null', async () => {
    expect(await lookupAddresses(sui, [EXAMPLE, ADENIYI, CNY, MANOS, GOODSOUL])).toEqual([
      { address: EXAMPLE, name: '0x2.sui' },
      { address: ADENIYI, name: 'adeniyi.sui' },
      { address: CNY, name: 'cny.stashed.sui' },
      { address: MANOS, name: null },
      { address: GOODSOUL, name: null },
    ])
  })
})

for (const network of ['mainnet', 'testnet'] as const) {
  live(`SuiNS 部署（${network}）`, { timeout: 60_000 }, () => {
    it('内置的表 ID 就是 SuiNS 对象里 RegistryKey<Registry> 的两个表', async () => {
      const sui = new SuiClient(undefined, { network })
      const config = SUINS[network] as SuinsConfig
      const suins = network === 'mainnet' ? '0x6e0ddefc0ad98889c04bab9639e512c21766c5e6366f89e696956d9be6952871' : '0x300369e8909b9a6464da265b9a5a9ab6fe2158a040e84e808628cde7a07ee5a3'
      const P = config.package
      const [field] = await sui.objects([dynamicFieldId(suins, `${P}::suins::RegistryKey<${P}::registry::Registry>`, new Uint8Array([0]))], { fields: ['json'] })
      const value = field ? json(field).value : null
      expect([value?.registry?.id, value?.reverse_registry?.id]).toEqual([config.registry, config.reverseRegistry])
    })
  })
}
