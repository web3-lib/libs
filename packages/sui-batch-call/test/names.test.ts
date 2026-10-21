/**
 * SuiNS 名字的规范化、正查（过期、叶子 / 节点子域名）、反查（正查核对），假节点，不连网络
 */
import { describe, expect, it } from 'vitest'

import { SuiClient, normalizeSuiAddress } from '../src/index.js'
import { dynamicFieldId } from '../src/dynamicField.js'
import { BcsWriter } from '../src/write/bcs.js'
import { SUINS, formatSuiName, getNameAddresses, lookupAddresses, normalizeSuiName, resolveNames, type SuinsConfig } from '../src/subpaths/names.js'
import { createFakeNode, type FakeObject } from './fakeNode.js'

const CONFIG = SUINS.mainnet as SuinsConfig
const NOW = Date.UTC(2030, 0, 1)
const LATER = NOW + 86_400_000
const EARLIER = NOW - 1
const A = normalizeSuiAddress('0xa1')
const B = normalizeSuiAddress('0xb2')
const C = normalizeSuiAddress('0xc3')
const NFT = normalizeSuiAddress('0x1f7')

const domainKey = (domain: string) =>
  new BcsWriter()
    .vector(domain.split('.').reverse(), (w, l) => w.string(l))
    .finish()

function record(domain: string, expiration: number, target: string | null, nft = normalizeSuiAddress('0x99'), config = CONFIG): FakeObject {
  return {
    id: dynamicFieldId(config.registry, `${config.package}::domain::Domain`, domainKey(domain)),
    type: `0x2::dynamic_field::Field<${config.package}::domain::Domain,${config.package}::name_record::NameRecord>`,
    json: { name: { labels: domain.split('.').reverse() }, value: { data: { contents: [] }, expiration_timestamp_ms: String(expiration), nft_id: nft, target_address: target } },
  }
}

const reverse = (address: string, domain: string): FakeObject => ({
  id: dynamicFieldId(CONFIG.reverseRegistry, 'address', new BcsWriter().address(address).finish()),
  type: `0x2::dynamic_field::Field<address,${CONFIG.package}::domain::Domain>`,
  json: { name: address, value: { labels: domain.split('.').reverse() } },
})

// 时钟按链上的（2030 年），不是本机时间：2026 年的测试机上 EARLIER 也算过期
const clock: FakeObject = { id: '0x6', type: '0x2::clock::Clock', json: { id: '0x6', timestamp_ms: String(NOW) } }

const OBJECTS: FakeObject[] = [
  clock,
  record('alice.sui', LATER, A),
  record('old.sui', EARLIER, B),
  record('noaddr.sui', LATER, null),
  // 叶子子域名：跟随父域名，NFT 要和父域名的相同
  record('parent.sui', LATER, C, NFT),
  record('leaf.parent.sui', 0, B, NFT),
  record('stale.parent.sui', 0, B, normalizeSuiAddress('0x1234')),
  record('expiredparent.sui', EARLIER, C, NFT),
  record('leaf.expiredparent.sui', 0, B, NFT),
  // 节点子域名：有自己的到期时间
  record('node.old.sui', LATER, C),
  reverse(A, 'alice.sui'),
  reverse(B, 'old.sui'),
  reverse(C, 'alice.sui'),
]

const setup = () => {
  const node = createFakeNode({ chain: 'mainnet', checkpoint: 1, balances: {}, coins: {}, objects: OBJECTS })
  return { node, sui: new SuiClient('https://node.test', { fetch: node.fetch }) }
}

describe('normalizeSuiName / formatSuiName', () => {
  it('小写、@ 格式换成点分；只认 .sui，标签不合法时为 null', () => {
    expect(['Example.SUI', '@example', ' sub@Example ', 'a.b@example', 'sub.example.sui'].map(normalizeSuiName)).toEqual([
      'example.sui',
      'example.sui',
      'sub.example.sui',
      'a.b.example.sui',
      'sub.example.sui',
    ])
    expect(['example', 'example.eth', '@example.sui', 'a@b@c', '-bad.sui', 'bad-.sui', 'a..sui', 'é.sui', '', '@', `${'a'.repeat(64)}.sui`, `${'a'.repeat(60)}.`.repeat(4) + 'sui'].map(normalizeSuiName)).toEqual(
      Array(12).fill(null),
    )
    expect(formatSuiName('example.sui', 'at')).toBe('@example')
    expect(formatSuiName('a.b.example.sui', 'at')).toBe('a.b@example')
    expect(formatSuiName('sub@Example', 'dot')).toBe('sub.example.sui')
    expect(formatSuiName('nope', 'at')).toBe(null)
  })
})

describe('resolveNames', () => {
  it('一轮 BatchGetObjects：过期、没设地址、叶子子域名（父域名 NFT 相同且没过期）、节点子域名', async () => {
    const { node, sui } = setup()
    const list = await resolveNames(sui, ['@Alice', 'old.sui', 'noaddr.sui', 'leaf@parent', 'stale.parent.sui', 'leaf.expiredparent.sui', 'node.old.sui', 'nobody.sui', 'not a name'])
    expect(list).toEqual([
      { name: '@Alice', normalized: 'alice.sui', address: A, expiresAt: LATER },
      { name: 'old.sui', normalized: 'old.sui', address: null, expiresAt: EARLIER },
      { name: 'noaddr.sui', normalized: 'noaddr.sui', address: null, expiresAt: LATER },
      { name: 'leaf@parent', normalized: 'leaf.parent.sui', address: B, expiresAt: LATER },
      { name: 'stale.parent.sui', normalized: 'stale.parent.sui', address: null, expiresAt: null },
      { name: 'leaf.expiredparent.sui', normalized: 'leaf.expiredparent.sui', address: null, expiresAt: EARLIER },
      { name: 'node.old.sui', normalized: 'node.old.sui', address: C, expiresAt: LATER },
      { name: 'nobody.sui', normalized: 'nobody.sui', address: null, expiresAt: null },
      { name: 'not a name', normalized: null, address: null, expiresAt: null },
    ])
    expect(node.calls.filter((c) => c.endsWith('BatchGetObjects')).length).toBe(1)
  })

  it('没有内置部署的网络要传 suins；快捷函数用同样的节点参数', async () => {
    const devnet = new SuiClient('https://node.test', { network: 'devnet', fetch: setup().node.fetch })
    await expect(resolveNames(devnet, ['alice.sui'])).rejects.toThrow(/pass options.suins/)
    const { node } = setup()
    const [r] = await getNameAddresses(['alice.sui'], { provider: 'https://node.test', fetch: node.fetch })
    expect(r?.address).toBe(A)
  })
})

describe('lookupAddresses', () => {
  it('反查后正查核对：名字过期、指向别的地址、没有反查记录、地址不合法时为 null', async () => {
    const { node, sui } = setup()
    const list = await lookupAddresses(sui, [A, B, C, '0xd4', 'bad', '0xA1'])
    expect(list).toEqual([
      { address: A, name: 'alice.sui' },
      { address: B, name: null }, // old.sui 过期了
      { address: C, name: null }, // alice.sui 指向 A
      { address: '0xd4', name: null },
      { address: 'bad', name: null },
      { address: '0xA1', name: 'alice.sui' },
    ])
    expect(node.calls.filter((c) => c.endsWith('BatchGetObjects')).length).toBe(2)
  })
})
