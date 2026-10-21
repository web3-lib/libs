/** SNS 域名解析：账户推导、解析顺序（NFT / V2 / V1 记录 / owner）、主域名反查和核对（模拟节点，不连网络） */
import { ed25519 } from '@noble/curves/ed25519.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { beforeEach, describe, expect, it } from 'vitest'

import { SolanaClient, TOKEN_PROGRAM_ID, decodeAddress, findProgramAddress, getAssociatedTokenAddress } from '../src/index.js'
import { resetNodeHealth } from '../src/rpc.js'
import { resetClientCache } from '../src/shortcuts.js'
import { NAME_PROGRAM_ID, SNS_ROOT_DOMAIN, getAddressNames, getNameAddresses, lookupAddresses, resolveNames, snsDomainKey } from '../src/subpaths/names.js'
import { keypair } from './fakeSolana.js'
import { createMockNode, mintData, tokenAccountData, type MockAccount, type MockNodeOptions } from './mock.js'

const REVERSE_CLASS = '33m47vH6Eav6jr5Ry86XjhRft2jRBLDnDgPSHoquXi2Z'
const RECORDS_CLASS = '2pMnqHvei2N5oDcVGCRdZx48gqti199wr5CsyTTafsbo'
const PRIMARY = '85iDfUvr3HJyLM2zcq5BXSiDvUWfw6cSE1FfNBo8Ap29'
const TOKENIZER = 'nftD3vbNkNqfj2Sd3HZwbpw4BxxKWr4AjGb9X38JeZk'
const enc = new TextEncoder()
const ZERO = new Uint8Array(32)

// 按官方 SDK 的规则独立推导（和库里的实现互相核对）
const nameKey = (name: string, cls?: string, parent?: string) =>
  findProgramAddress([sha256(enc.encode(`SPL Name Service${name}`)), cls ? decodeAddress(cls) : ZERO, parent ? decodeAddress(parent) : ZERO], NAME_PROGRAM_ID)
const domainKey = (name: string) => nameKey(name, undefined, SNS_ROOT_DOMAIN)
const v1Key = (domain: string) => nameKey('\x01SOL', undefined, domain)
const v2Key = (domain: string) => nameKey('\x02SOL', RECORDS_CLASS, domain)
const reverseKey = (domain: string, parent?: string) => nameKey(domain, REVERSE_CLASS, parent)
const nftRecord = (domain: string) => findProgramAddress([enc.encode('nft_record'), decodeAddress(domain)], TOKENIZER)
const nftMint = (domain: string) => findProgramAddress([enc.encode('tokenized_name'), decodeAddress(domain)], TOKENIZER)
const favourite = (wallet: string) => findProgramAddress([enc.encode('favourite_domain'), decodeAddress(wallet)], PRIMARY)

const registry = (parent: string, owner: string, cls = '11111111111111111111111111111111', data: number[] = []): MockAccount => ({
  owner: NAME_PROGRAM_ID,
  data: new Uint8Array([...decodeAddress(parent), ...decodeAddress(owner), ...decodeAddress(cls), ...data]),
})
const u16 = (v: number) => [v & 0xff, v >> 8]
const u32 = (v: number) => [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, v >>> 24]
const str = (s: string) => [...u32(enc.encode(s).length), ...enc.encode(s)]
/** V2 记录的数据：u16 过期验证 + u16 关联验证 + u32 长度 + 两个 id + 内容 */
const recordV2 = (staleness: number, roa: number, ids: string[], content: string) => [
  ...u16(staleness),
  ...u16(roa),
  ...u32(32),
  ...ids.flatMap((id) => [...decodeAddress(id)]),
  ...decodeAddress(content),
]

const A = keypair(1) // alice / pay.alice 的 owner
const B = keypair(2)
const T = keypair(3).address // SOL 记录指向的地址
const H = keypair(4).address // NFT 持有人
const S = keypair(5).address
const OLD = keypair(6).address
const PDA = findProgramAddress([enc.encode('vault')], TOKENIZER)

const alice = domainKey('alice')
const bob = domainKey('bob')
const carol = domainKey('carol')
const dave = domainKey('dave')
const erin = domainKey('erin')
const frank = domainKey('frank')
const zed = domainKey('zed')
const payAlice = nameKey('\0pay', undefined, alice)

function setup(extra: Record<string, MockAccount> = {}, errors?: MockNodeOptions['errors']) {
  // carol 的 V1 记录：owner 对 hex(目标 ‖ 记录账户) 的签名
  const carolSig = ed25519.sign(enc.encode(Buffer.concat([decodeAddress(T), decodeAddress(v1Key(carol))]).toString('hex')), A.seed)
  const holderAccount = keypair(60).address
  const holderData = tokenAccountData(nftMint(erin), H, 1n)
  holderData[108] = 1
  const accounts: Record<string, MockAccount> = {
    [alice]: registry(SNS_ROOT_DOMAIN, A.address),
    [payAlice]: registry(alice, S),
    [bob]: registry(SNS_ROOT_DOMAIN, A.address),
    [v2Key(bob)]: registry(bob, A.address, RECORDS_CLASS, recordV2(1, 1, [A.address, T], T)),
    [carol]: registry(SNS_ROOT_DOMAIN, A.address),
    [v2Key(carol)]: registry(carol, A.address, RECORDS_CLASS, recordV2(1, 1, [OLD, OLD], OLD)), // 过期：owner 换过
    [v1Key(carol)]: registry(carol, A.address, undefined, [...decodeAddress(T), ...carolSig]),
    [dave]: registry(SNS_ROOT_DOMAIN, A.address),
    [v2Key(dave)]: registry(dave, A.address, RECORDS_CLASS, recordV2(0, 0, [], T)), // 没有验证过：不解析
    [erin]: registry(SNS_ROOT_DOMAIN, nftRecord(erin)),
    [nftRecord(erin)]: { owner: TOKENIZER, data: new Uint8Array([2, 255, ...decodeAddress(erin), ...decodeAddress(A.address), ...decodeAddress(nftMint(erin))]) },
    [nftMint(erin)]: { owner: TOKEN_PROGRAM_ID, data: mintData({ decimals: 0, supply: 1n }) },
    [holderAccount]: { owner: TOKEN_PROGRAM_ID, data: holderData },
    [frank]: registry(SNS_ROOT_DOMAIN, PDA),
    [zed]: registry(SNS_ROOT_DOMAIN, B.address),
    // 反查记录
    [reverseKey(alice)]: registry('11111111111111111111111111111111', REVERSE_CLASS, REVERSE_CLASS, str('alice')),
    [reverseKey(erin)]: registry('11111111111111111111111111111111', REVERSE_CLASS, REVERSE_CLASS, str('erin')),
    [reverseKey(zed)]: registry('11111111111111111111111111111111', REVERSE_CLASS, REVERSE_CLASS, str('alice')), // 内容和账户对不上
    [reverseKey(payAlice, alice)]: registry(alice, REVERSE_CLASS, REVERSE_CLASS, str('\0pay')),
    // 主域名
    [favourite(A.address)]: { owner: PRIMARY, data: new Uint8Array([4, ...decodeAddress(alice)]) },
    [favourite(B.address)]: { owner: PRIMARY, data: new Uint8Array([4, ...decodeAddress(alice)]) }, // 过期：alice 不是 B 的
    [favourite(H)]: { owner: PRIMARY, data: new Uint8Array([4, ...decodeAddress(erin)]) },
    [favourite(S)]: { owner: PRIMARY, data: new Uint8Array([4, ...decodeAddress(payAlice)]) },
    [favourite(keypair(7).address)]: { owner: PRIMARY, data: new Uint8Array([4, ...decodeAddress(zed)]) },
    ...extra,
  }
  // 代币化的域名：H 的 ATA 里有 NFT
  const ata = getAssociatedTokenAddress(H, nftMint(erin), TOKEN_PROGRAM_ID)
  accounts[ata] = { owner: TOKEN_PROGRAM_ID, data: holderData }
  const node = createMockNode({ accounts, errors })
  return { node, client: new SolanaClient(node) }
}

beforeEach(() => {
  resetNodeHealth()
  resetClientCache()
})

describe('snsDomainKey', () => {
  it('顶级域名：sha256("SPL Name Service" + 名字)，parent 是根域；子域名的种子带 \\0，parent 是父域名', () => {
    expect(snsDomainKey('alice')).toEqual({ key: alice, parent: null })
    expect(snsDomainKey('pay.alice')).toEqual({ key: payAlice, parent: alice })
    expect(() => snsDomainKey('a.b.c')).toThrow()
    // 主网上的真实账户（bonfida.sns）
    expect(snsDomainKey('bonfida').key).toBe('Crf8hzfthWGbGbLTVCiqRqV5MVnbpHB1L9KQMd6gsinb')
  })
})

describe('resolveNames', () => {
  it('解析顺序：NFT 持有人 → V2 SOL 记录 → V1 SOL 记录 → owner；规范化名字', async () => {
    const { node, client } = setup()
    const names = ['Alice.SNS ', 'bob.sns', 'carol.sns', 'dave.sns', 'erin.sns', 'frank.sns', 'pay.alice.sns', 'nobody.sns', 'alice.sol', 'alice', 'a.b.c.sns']
    const list = await resolveNames(client, names)
    expect(list.map((r) => [r.normalized, r.address, r.owner, r.source, r.service])).toEqual([
      ['alice.sns', A.address, A.address, 'owner', 'sns'],
      ['bob.sns', T, A.address, 'record-v2', 'sns'],
      ['carol.sns', T, A.address, 'record-v1', 'sns'],
      ['dave.sns', null, A.address, 'record-v2', 'sns'],
      ['erin.sns', H, H, 'nft', 'sns'],
      ['frank.sns', null, PDA, 'owner', 'sns'],
      ['pay.alice.sns', S, S, 'owner', 'sns'],
      ['nobody.sns', null, null, null, 'sns'],
      [null, null, null, null, null], // .sol 默认不解析
      [null, null, null, null, null],
      [null, null, null, null, null],
    ])
    expect(list[0]?.name).toBe('Alice.SNS ')
    // 一次 getMultipleAccounts 读全部域名和记录；代币化的另外 getTokenLargestAccounts + 读持有账户
    expect(node.calls.map((c) => c.method)).toEqual(['getMultipleAccounts', 'getTokenLargestAccounts', 'getMultipleAccounts'])
  })

  it('legacySol：.sol 按同名 .sns 解析；allowPda：PDA owner 也返回', async () => {
    const { client } = setup()
    const [sol, pda] = await resolveNames(client, ['alice.sol', 'frank.sns'], { legacySol: true, allowPda: true })
    expect(sol).toMatchObject({ normalized: 'alice.sns', address: A.address, service: 'sns' })
    expect(pda).toMatchObject({ address: PDA, owner: PDA })
  })

  it('节点不支持 getTokenLargestAccounts：代币化的域名 address 为 null，其他照常', async () => {
    const { client } = setup({}, { getTokenLargestAccounts: { code: -32602, message: 'Indexed requests require a personal token' } })
    const [erinResult, aliceResult] = await resolveNames(client, ['erin.sns', 'alice.sns'])
    expect(erinResult).toMatchObject({ address: null, owner: null, source: 'nft' })
    expect(aliceResult?.address).toBe(A.address)
  })

  it('V1 记录签名不对时回到 owner', async () => {
    const { client } = setup({ [v1Key(carol)]: registry(carol, A.address, undefined, [...decodeAddress(T), ...new Uint8Array(64).fill(1)]) })
    const [carolResult] = await resolveNames(client, ['carol.sns'])
    expect(carolResult).toMatchObject({ address: A.address, source: 'owner' })
  })
})

describe('lookupAddresses', () => {
  it('主域名：核对 owner（或持有 NFT）和名字推导出的账户；子域名拼上父域名', async () => {
    const { node, client } = setup()
    const forged = keypair(7).address
    const list = await lookupAddresses(client, [A.address, B.address, H, S, forged, T, 'not-an-address', A.address])
    expect(list).toEqual([
      { address: A.address, name: 'alice.sns', service: 'sns' },
      { address: B.address, name: null, service: null }, // alice 已经不是 B 的
      { address: H, name: 'erin.sns', service: 'sns' },
      { address: S, name: 'pay.alice.sns', service: 'sns' },
      { address: forged, name: null, service: null }, // 反查记录和域名账户对不上
      { address: T, name: null, service: null },
      { address: 'not-an-address', name: null, service: null },
      { address: A.address, name: 'alice.sns', service: 'sns' },
    ])
    // 主域名 → 域名 + 反查 + NFT 的 ATA → 子域名的反查
    expect(node.calls.filter((c) => c.method === 'getMultipleAccounts')).toHaveLength(3)
  })

  it('getNameAddresses / getAddressNames：节点参数与 getBalances 相同', async () => {
    const { node } = setup()
    expect((await getNameAddresses(['alice.sns'], { provider: node }))[0]?.address).toBe(A.address)
    expect((await getAddressNames([A.address], { provider: node }))[0]?.name).toBe('alice.sns')
  })
})
