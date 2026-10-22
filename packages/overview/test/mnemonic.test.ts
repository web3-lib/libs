/**
 * 助记词推导：用公开的测试向量核对（来源写在每个用例旁边）
 */
import { fileURLToPath } from 'node:url'

import { ed25519 } from '@noble/curves/ed25519.js'
import { HDNodeWallet } from 'ethers'
import { describe, expect, it } from 'vitest'

import { slip10Ed25519, tonMnemonicSeed, tonWalletAddresses, type TonModules } from '../src/mnemonic.js'
import { deriveAddresses, getDerivedOverview, getOverviewFromMnemonic } from '../src/subpaths/mnemonic.js'
import { fakeLoaders, portfolioOf } from './fakeChains.js'

const tonSrc = (path: string) => fileURLToPath(new URL(`../../ton-batch-call/src/${path}.ts`, import.meta.url))
const tonLoaders = {
  tonWrite: () => import(/* @vite-ignore */ tonSrc('subpaths/write')),
  tonCore: () => import(/* @vite-ignore */ tonSrc('index')),
}
const tonModules = async (): Promise<TonModules> => ({ write: await tonLoaders.tonWrite(), core: await tonLoaders.tonCore() })

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex')
const fromHex = (h: string) => Uint8Array.from(Buffer.from(h, 'hex'))

const ABANDON = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'

describe('deriveAddresses', () => {
  it('EVM / Tron / Solana：abandon … about 的公开向量（账户 0）', async () => {
    // 广泛发布的 BIP-39 测试助记词的地址：EVM m/44'/60'/0'/0/0、Solana m/44'/501'/0'/0'（Phantom）、Tron m/44'/195'/0'/0/0（TronLink）
    const a = await deriveAddresses(ABANDON, { loaders: tonLoaders })
    expect(a.evm).toEqual(['0x9858EfFD232B4033E47d90003D41EC34EcaEda94'])
    expect(a.solana).toEqual(['HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk'])
    expect(a.tron).toEqual(['TUEZSdKsoDHQMeZwihtdoBiN46zxhGWYdH'])
    expect(a.paths).toEqual({ evm: ["m/44'/60'/0'/0/0"], tron: ["m/44'/195'/0'/0/0"], solana: ["m/44'/501'/0'/0'"], sui: ["m/44'/784'/0'/0'/0'"] })
    expect(a.kind).toEqual({ bip39: true, ton: false })
    expect(a.ton[0]).toMatchObject({ index: 0, scheme: 'bip39', path: "m/44'/607'/0'" })
    expect(a.ton[0]?.v4r2).toMatch(/^UQ/)
    expect(a.ton[0]?.v5r1).toMatch(/^UQ/)
    expect(a.warnings).toEqual([])
  })

  it('EVM 多个账户与 ethers 的 HDNodeWallet 一致；大小写、空白不影响', async () => {
    const a = await deriveAddresses(`  ${ABANDON.toUpperCase().replace(/ /g, '  \n')} `, { accounts: 3, chains: ['evm', 'solana'] })
    for (let i = 0; i < 3; i++) expect(a.evm[i]).toBe(HDNodeWallet.fromPhrase(ABANDON, undefined, `m/44'/60'/0'/0/${i}`).address)
    expect(a.solana).toHaveLength(3)
    expect(new Set(a.solana).size).toBe(3)
    expect(a.tron).toEqual([])
    expect(a.ton).toEqual([])
  })

  it('密码（第 25 个词）改变所有地址，与 ethers 一致', async () => {
    const a = await deriveAddresses(ABANDON, { passphrase: 'TREZOR', chains: ['evm'] })
    expect(a.evm[0]).toBe(HDNodeWallet.fromPhrase(ABANDON, 'TREZOR', "m/44'/60'/0'/0/0").address)
    expect(a.evm[0]).not.toBe('0x9858EfFD232B4033E47d90003D41EC34EcaEda94')
  })

  it('Sui：MystenLabs SDK 的测试向量（与 Rust keytool 生成的一致）', async () => {
    // https://github.com/MystenLabs/ts-sdks/blob/main/packages/sui/test/unit/cryptography/ed25519-keypair.test.ts（TEST_CASES，m/44'/784'/0'/0'/0'）
    const cases = [
      ['film crazy soon outside stand loop subway crumble thrive popular green nuclear struggle pistol arm wife phrase warfare march wheat nephew ask sunny firm', '0xa2d14fad60c56049ecf75246a481934691214ce413e6a8ae2fe6834c173a6133'],
      ['require decline left thought grid priority false tiny gasp angle royal system attack beef setup reward aunt skill wasp tray vital bounce inflict level', '0x1ada6e6f3f3e4055096f606c746690f1108fcc2ca479055cc434a3e1d3f758aa'],
      ['organ crash swim stick traffic remember army arctic mesh slice swear summer police vast chaos cradle squirrel hood useless evidence pet hub soap lake', '0xe69e896ca10f5a77732769803cc2b5707f0ab9d4407afb5e4b4464b89769af14'],
    ] as const
    for (const [mnemonic, address] of cases) expect((await deriveAddresses(mnemonic, { chains: ['sui'] })).sui).toEqual([address])
  })

  it('SLIP-0010 ed25519 测试向量 1', () => {
    // https://github.com/satoshilabs/slips/blob/master/slip-0010.md "Test vector 1 for ed25519"
    const seed = fromHex('000102030405060708090a0b0c0d0e0f')
    expect(hex(slip10Ed25519(seed, []))).toBe('2b4be7f19ee27bbf30c667b642d5f4aa69fd169872f8fc3059c08ebae2eb19e7')
    expect(hex(slip10Ed25519(seed, [0]))).toBe('68e0fe46dfb67e368c75379acec591dad19df3cde26e63b93a8e704f1dade7a3')
    expect(hex(slip10Ed25519(seed, [0, 1, 2, 2]))).toBe('30d1dc7e5fc04c31219ab25a27ae00b50f6fd66622f6e9c913253d6511d1e662')
  })

  it('TON BIP-39 助记词：Trust Wallet wallet-core 的向量（m/44\'/607\'/0\'，v4r2）', async () => {
    // https://github.com/trustwallet/wallet-core/blob/master/tests/chains/TheOpenNetwork/TWAnyAddressTests.cpp（TWTheOpenNetwork.Address）
    const a = await deriveAddresses('stuff diamond cycle federal scan spread pigeon people engage teach snack grain', { chains: ['ton'], loaders: tonLoaders })
    expect(a.ton).toHaveLength(1)
    expect(a.ton[0]?.v4r2).toBe('UQDYW_1eScJVxtitoBRksvoV9cCYo4uKGWLVNIHB1JqRRyQx')
  })

  it('TON 钱包地址：wallet-core 的公钥 / 私钥 → 地址向量（v4r2、v5r1 主网）', async () => {
    const ton = await tonModules()
    // https://github.com/trustwallet/wallet-core/blob/master/swift/Tests/Blockchains/TheOpenNetworkTests.swift（testAddressFromPublicKey，v4r2 主网）
    expect(tonWalletAddresses(fromHex('f42c77f931bea20ec5d0150731276bbb2e2860947661245b2319ef8133ee8d41'), ton).v4r2).toBe('UQBm--PFwDv1yCeS-QTJ-L8oiUpqo9IT1BwgVptlSq3ts4DV')
    // https://github.com/trustwallet/wallet-core/blob/master/rust/tw_tests/tests/chains/ton/ton_sign_wallet_v5r1.rs：
    // 私钥 3570e35f… 的 W5 钱包是期望 BOC 里外部消息的目标地址，也是同一文件里另一个用例转账的 dest（UQAU3o5-…）；私钥 502d60b0… 同理
    const pub = (key: string) => ed25519.getPublicKey(fromHex(key))
    expect(tonWalletAddresses(pub('3570e35f54cfb843f2cfaf2b8cae7ceeb7b32225d7dbbd86f611056d74d9073e'), ton).v5r1).toBe('UQAU3o5-Sp1MYRpw3U7b_wmARxqI49LxiFhEoVCxpUKjTYXk')
    expect(tonWalletAddresses(pub('502d60b0f3327382e7d0585b789f1db9aa04907fe5cddc5c28818ec163ebf4ba'), ton).v5r1).toBe('UQCh41gQP1A4I0lnAn6yAfitDAIYpXG6UFIXqeSz1TVxNOJ_')
  })

  it('TON 格式的助记词：@ton/crypto 的向量；只推导 TON', async () => {
    // https://github.com/ton-org/ton-crypto/blob/master/src/mnemonic/mnemonic.spec.ts（testVectors：key 是 64 字节的 secretKey = 种子 + 公钥）
    const words = 'hospital stove relief fringe tongue always charge angry urge sentence again match nerve inquiry senior coconut label tumble carry category beauty bean road solution'
    const key = '9d659a6c2234db7f6e4f977e6e8653b9f5946d557163f31034011375d8f3f97df6c450a16bb1c514e22f1977e390a3025599aa1e7b00068a6aacf2119484c1bd'
    const seed = (await tonMnemonicSeed(words.split(' '))) as Uint8Array
    expect(hex(seed)).toBe(key.slice(0, 64))
    expect(hex(ed25519.getPublicKey(seed))).toBe(key.slice(64))

    const a = await deriveAddresses(words, { accounts: 2, loaders: tonLoaders })
    expect(a.kind).toEqual({ bip39: false, ton: true })
    expect(a.evm).toEqual([])
    const ton = await tonModules()
    expect(a.ton).toEqual([{ index: 0, ...tonWalletAddresses(fromHex(key.slice(64)), ton), scheme: 'ton', path: 'ton-mnemonic' }])
    expect(a.warnings).toHaveLength(2)
    // BIP-39 助记词不是 TON 格式
    expect(await tonMnemonicSeed(ABANDON.split(' '))).toBeNull()
  })

  it('校验失败时报错，错误信息不含助记词', async () => {
    const bad = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon'
    const err = (await deriveAddresses(bad).catch((e: Error) => e)) as Error
    expect(err.message).toMatch(/checksum/)
    expect(err.message).not.toMatch(/abandon/)
    const unknown = (await deriveAddresses(ABANDON.replace('about', 'secretword')).catch((e: Error) => e)) as Error
    expect(unknown.message).toMatch(/#12/)
    expect(unknown.message).not.toMatch(/secretword/)
    await expect(deriveAddresses('abandon about')).rejects.toThrow(/got 2/)
    await expect(deriveAddresses(ABANDON, { accounts: 21 })).rejects.toThrow(RangeError)
    await expect(deriveAddresses(ABANDON, { accounts: 0 })).rejects.toThrow(RangeError)
    await expect(deriveAddresses(ABANDON, { chains: ['btc' as never] })).rejects.toThrow(/unknown chain/)
  })

  it('同时符合 BIP-39 和 TON 格式的 24 词助记词：TON 两种 scheme 都推导', async () => {
    const both = 'picture abuse feel item glory casino negative explain meadow cancel trim east outer lock derive sign narrow include ability fat wrong tooth crouch fit'
    const a = await deriveAddresses(both, { chains: ['ton'], loaders: tonLoaders })
    expect(a.kind).toEqual({ bip39: true, ton: true })
    expect(a.ton.map((t) => [t.index, t.scheme])).toEqual([
      [0, 'bip39'],
      [0, 'ton'],
    ])
    expect(a.ton[0]?.v5r1).not.toBe(a.ton[1]?.v5r1)
    expect(a.warnings).toHaveLength(1)
  })

  it('TON 链包加载不了时其他链照常，warnings 说明', async () => {
    const a = await deriveAddresses(ABANDON, { loaders: { tonWrite: () => Promise.reject(new Error('nope')) } })
    expect(a.evm).toHaveLength(1)
    expect(a.ton).toEqual([])
    expect(a.warnings[0]).toMatch(/tonWrite/)
  })
})

describe('getOverviewFromMnemonic', () => {
  it('每个账户一次总览，合计所有账户；TON 查在用的钱包版本', async () => {
    const { loaders, calls } = fakeLoaders({
      evm: (owner, o) => portfolioOf(o.chainId === 1 ? [{ token: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE', native: true, symbol: 'ETH', formatted: '1', price: 2000, decimals: 18 }] : []),
      solana: () => portfolioOf([{ token: 'So11111111111111111111111111111111111111112', native: true, symbol: 'SOL', formatted: '1', price: 100, decimals: 9 }]),
      ton: () => portfolioOf([{ token: 'native', native: true, symbol: 'TON', formatted: '10', price: 3, decimals: 9 }]),
    })
    const core = await tonLoaders.tonCore()
    const stateCalls: string[][] = []
    // 账户 0：只有 v4r2 部署了；账户 1：两个都没有 → 查 v5r1
    const tonCore = async () => ({
      ...core,
      getWalletStates: async (addrs: string[]) => {
        stateCalls.push(addrs)
        return addrs.map((_, k) => (k === 0 ? { status: 'active', balance: '5' } : { status: 'nonexist', balance: '0' }))
      },
    })
    const seen: number[] = []
    const r = await getOverviewFromMnemonic(ABANDON, {
      accounts: 2,
      chains: ['evm', 'solana', 'ton'],
      evm: { chains: [1, 56] },
      loaders: { ...loaders, tonWrite: tonLoaders.tonWrite, tonCore },
      onAccount: (a) => seen.push(a.index),
    })
    expect(seen).toEqual([0, 1])
    expect(stateCalls).toHaveLength(1)
    expect(stateCalls[0]).toHaveLength(4)
    expect(r.accounts[0]?.ton).toEqual([{ version: 'v4r2', scheme: 'bip39', address: r.addresses.ton[0]?.v4r2, status: 'active' }])
    expect(r.accounts[1]?.ton).toEqual([{ version: 'v5r1', scheme: 'bip39', address: r.addresses.ton[1]?.v5r1, status: 'nonexist' }])
    expect(r.accounts[0]?.addresses).toEqual({ evm: '0x9858EfFD232B4033E47d90003D41EC34EcaEda94', solana: 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk' })
    expect(r.accounts[0]?.overview.totalUsd).toBe(2000 + 100 + 30)
    expect(r.total.totalUsd).toBe(2 * (2000 + 100 + 30))
    expect(r.total.tokens.find((t) => t.key === 'ETH')?.amount).toBe(2)
    expect(r.total.byChain).toHaveLength(2 * 4)
    // 只有地址发给了链包
    expect(calls.filter((c) => c.module === 'ton').map((c) => c.owner)).toEqual([r.addresses.ton[0]?.v4r2, r.addresses.ton[1]?.v5r1])
    expect(JSON.stringify(calls)).not.toMatch(/abandon/)
  })

  it('两个 TON 版本都在用时都查、合并进同一个账户；读不到状态时也都查', async () => {
    const { loaders } = fakeLoaders({ ton: () => portfolioOf([{ token: 'native', native: true, symbol: 'TON', formatted: '1', price: 3, decimals: 9 }]) })
    const core = await tonLoaders.tonCore()
    const run = (getWalletStates: (a: string[]) => Promise<unknown>) =>
      getOverviewFromMnemonic(ABANDON, { chains: ['ton'], loaders: { ...loaders, tonWrite: tonLoaders.tonWrite, tonCore: async () => ({ ...core, getWalletStates }) } })
    const both = await run(async (a) => a.map(() => ({ status: 'active', balance: '1' })))
    expect(both.accounts[0]?.ton.map((t) => t.version)).toEqual(['v4r2', 'v5r1'])
    expect(both.accounts[0]?.overview.byChain).toHaveLength(2)
    expect(both.total.totalUsd).toBe(6)
    const failed = await run(async () => {
      throw new Error('429')
    })
    expect(failed.accounts[0]?.ton.map((t) => [t.version, t.status])).toEqual([
      ['v4r2', null],
      ['v5r1', null],
    ])
    expect(failed.warnings[0]).toMatch(/429/)
    expect(failed.addresses.warnings).toEqual([])
  })

  it('只加载 tonCore；加载失败时写 warning、两个版本都查，不中断', async () => {
    const { loaders, calls } = fakeLoaders({ ton: () => portfolioOf([]) })
    const a = await deriveAddresses(ABANDON, { chains: ['ton'], loaders: tonLoaders })
    const r = await getDerivedOverview(a, { loaders: { ...loaders, tonWrite: () => Promise.reject(new Error('tonWrite must not load')), tonCore: () => Promise.reject(new Error('no core')) } })
    expect(r.warnings[0]).toMatch(/no core/)
    expect(r.accounts[0]?.ton.map((t) => t.version)).toEqual(['v4r2', 'v5r1'])
    expect(calls).toHaveLength(2)
  })

  it('evm.chains 为空数组时不查 EVM，warnings 说明', async () => {
    const { loaders, calls } = fakeLoaders({ evm: () => portfolioOf([]), solana: () => portfolioOf([]) })
    const a = await deriveAddresses(ABANDON, { chains: ['evm', 'solana'] })
    const r = await getDerivedOverview(a, { evm: { chains: [] }, loaders })
    expect(calls.map((c) => c.module)).toEqual(['solana'])
    expect(r.accounts[0]?.addresses.evm).toBeUndefined()
    expect(r.warnings).toEqual([expect.stringMatching(/evm\.chains/)])
    const onlyEvm = await getDerivedOverview(await deriveAddresses(ABANDON, { chains: ['evm'] }), { evm: { chains: [] }, loaders })
    expect(onlyEvm.accounts).toEqual([])
    expect(onlyEvm.total.totalUsd).toBe(0)
  })
})
