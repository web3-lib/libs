/**
 * 写操作的编码和签名：期望值由 @mysten/sui 2.36.0 生成（bcs.TransactionData.serialize、Ed25519Keypair.signTransaction、
 * TransactionDataBuilder.getDigestFromBytes），保证交易字节和签名与官方 SDK 一致
 */
import { hex } from '@scure/base'
import { describe, expect, it } from 'vitest'

import { decodeKindInputs, encodeTransactionData, encodeTransactionKind, pure as bcsPure, type TransactionData } from '../src/write/bcs.js'
import { PtbBuilder, ed25519Address, pure, resolveSigner, transactionDigest, type SuiWalletLike } from '../src/subpaths/write.js'

const SECRET = '0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20'
const SUIPRIVKEY = 'suiprivkey1qqqsyqcyq5rqwzqfpg9scrgwpugpzysnzs23v9ccrydpk8qarc0jqa4ffsr'
const SENDER = '0x7573c697fa68450f04fa0dee2d39dcdc8a5ccf5db547f3e47638a6f8eeeec110'
const PUBLIC_KEY = 'ebVWLo/mVPlAeLES6KmLp5AfhTrmlb7X4OORC60ElmQ='
const D1 = '11111111111111111111111111111111'
const D2 = '4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi'

const TX1 =
  '0000060008e8030000000000000020000000000000000000000000000000000000000000000000000000000000000201000000000000000000000000000000000000000000000000000000000000000abc07000000000000002001010101010101010101010101010101010101010101010101010101010101010101000000000000000000000000000000000000000000000000000000000000000601000000000000000001020000000000000000000000000000000000000000000000000000000000000def09000000000000002000000000000000000000000000000000000000000000000000000000000000000200881300000000000000070000000000000000000000000000000000000000000000000000000000000002037375690353554900000702000201000001000003030000000002030000010001020000000000000000000000000000000000000000000000000000000000000000000204636f696e0c72656465656d5f66756e6473010700000000000000000000000000000000000000000000000000000000000000020373756903535549000101050005010607000000000000000000000000000000000000000000000000000000000000000204636f696e04436f696e0107000000000000000000000000000000000000000000000000000000000000000203737569035355490001020200050001010300000000000000000000000000000000000000000000000000000000000000001234016d016605010602070000000000000000000000000000000000000000000000000000000000000002057461626c65055461626c65020407000000000000000000000000000000000000000000000000000000000000000106737472696e6706537472696e67000a0002010400020300010103000000000101007573c697fa68450f04fa0dee2d39dcdc8a5ccf5db547f3e47638a6f8eeeec110007573c697fa68450f04fa0dee2d39dcdc8a5ccf5db547f3e47638a6f8eeeec110e803000000000000002d3101000000000201640000000000000001650000000000000000002001010101010101010101010101010101010101010101010101010101010101012a000000'
const SIG1 = 'AI2uRjhw4b+qKxj6KEeUlqB9FjKFE1ddO3y/a+eEDfT30bqOXpuBkFbNwFYunH0Mlm6GXtms/O6R4md9mQwlfwp5tVYuj+ZU+UB4sRLoqYunkB+FOuaVvtfg45ELrQSWZA=='
const DIGEST1 = 'BJHWoChNz427VXs7YNWxy3fpJVXjDayNGYQnwaWDjjgR'
/** TX1 的 gas 换成一个 gas 币、过期改成 Epoch(55) */
const TX2_TAIL = '010000000000000000000000000000000000000000000000000000000000000abc07000000000000002001010101010101010101010101010101010101010101010101010101010101017573c697fa68450f04fa0dee2d39dcdc8a5ccf5db547f3e47638a6f8eeeec110e803000000000000002d310100000000013700000000000000'
const DIGEST2 = 'DTsEfdiQ8NWzFcwNfeBskEvG5HPUsTcQaVcyf8Rxe4N6'
/** @mysten/sui 的 tx.build({ onlyTransactionKind: true })：splitCoins(gas, [0.01 SUI]) → transferObjects(0x5) */
const SDK_KIND = '000200088096980000000000002000000000000000000000000000000000000000000000000000000000000000050202000101000001010300000000010100'

/** 覆盖各种输入（pure / owned / shared / receiving / 地址余额取款）、命令和 TypeTag */
function sample(): PtbBuilder {
  const ptb = new PtbBuilder()
  const amount = ptb.pure(pure.u64(1000n))
  const split = ptb.command({ kind: 'splitCoins', coin: ptb.gas, amounts: [amount, ptb.pure(pure.u64(1000n))] })
  const recipient = ptb.pure(pure.address('0x2'))
  const owned = ptb.owned({ objectId: '0xabc', version: 7n, digest: D2 })
  const clock = ptb.object({ kind: 'shared', objectId: '0x6', initialSharedVersion: 1n, mutable: false })
  const receiving = ptb.object({ kind: 'receiving', ref: { objectId: '0xdef', version: 9n, digest: D1 } })
  const withdrawal = ptb.withdrawal(5000n, '0x2::sui::SUI')
  ptb.command({ kind: 'mergeCoins', destination: ptb.nested(split, 0), sources: [ptb.nested(split, 1), owned] })
  const redeemed = ptb.moveCall('0x2::coin::redeem_funds', ['0x2::sui::SUI'], [withdrawal])
  const vec = ptb.command({ kind: 'makeMoveVec', type: 'vector<0x2::coin::Coin<0x2::sui::SUI>>', elements: [redeemed] })
  ptb.command({ kind: 'makeMoveVec', type: null, elements: [clock] })
  ptb.moveCall('0x1234::m::f', ['u8', 'vector<u64>', '0x2::table::Table<address, 0x1::string::String>', 'u256', 'bool'], [receiving, vec])
  ptb.command({ kind: 'transferObjects', objects: [ptb.nested(split, 0)], address: recipient })
  return ptb
}

const data = (overrides: Partial<TransactionData> = {}): TransactionData => ({
  kind: sample().build(),
  sender: SENDER,
  gas: { payment: [], owner: SENDER, price: 1000n, budget: 20_000_000n },
  expiration: { kind: 'validDuring', minEpoch: 100n, maxEpoch: 101n, chain: D2, nonce: 42 },
  ...overrides,
})

describe('BCS 编码（与 @mysten/sui 一致）', () => {
  it('TransactionData：地址余额付 gas（payment 为空 + ValidDuring）', () => {
    expect(hex.encode(encodeTransactionData(data()))).toBe(TX1)
    expect(transactionDigest(hex.decode(TX1))).toBe(DIGEST1)
  })

  it('TransactionData：gas 币 + Epoch 过期', () => {
    const bytes = encodeTransactionData(data({ gas: { payment: [{ objectId: '0xabc', version: 7n, digest: D2 }], owner: SENDER, price: 1000n, budget: 20_000_000n }, expiration: { kind: 'epoch', epoch: 55n } }))
    const kindLength = TX1.indexOf('7573c697') // 发送者之前是 TransactionKind
    expect(hex.encode(bytes)).toBe(TX1.slice(0, kindLength + 64) + TX2_TAIL)
    expect(transactionDigest(bytes)).toBe(DIGEST2)
  })

  it('PtbBuilder 输入去重：相同的 pure 值共用一个输入', () => {
    const ptb = sample()
    expect(ptb.inputs.length).toBe(6)
    expect(ptb.pure(pure.u64(1000n))).toEqual({ kind: 'input', index: 0 })
    expect(ptb.owned({ objectId: '0x0abc', version: 7n, digest: D2 })).toEqual({ kind: 'input', index: 2 })
  })

  it('别处编码好的 TransactionKind 字节原样放进交易', () => {
    const sdkKind = hex.decode(SDK_KIND)
    const ptb = new PtbBuilder()
    const [coin] = [ptb.command({ kind: 'splitCoins', coin: ptb.gas, amounts: [ptb.pure(pure.u64(10_000_000n))] })]
    ptb.command({ kind: 'transferObjects', objects: [ptb.nested(coin as never, 0)], address: ptb.pure(pure.address('0x5')) })
    expect(hex.encode(encodeTransactionKind(ptb.build()))).toBe(SDK_KIND)
    const a = encodeTransactionData(data({ kind: sdkKind }))
    const b = encodeTransactionData(data({ kind: ptb.build() }))
    expect(hex.encode(a)).toBe(hex.encode(b))
  })

  it('读出 TransactionKind 字节里的自有对象和地址余额取款', () => {
    const SUI = '0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI'
    expect(decodeKindInputs(hex.decode(TX1).subarray(1))).toEqual({
      owned: [`0x${'0'.repeat(61)}abc`, `0x${'0'.repeat(61)}def`],
      withdrawals: [{ amount: 5000n, coinType: SUI, from: 'sender' }],
    })
    expect(decodeKindInputs(hex.decode(SDK_KIND))).toEqual({ owned: [], withdrawals: [] })
    expect(() => decodeKindInputs(hex.decode(SDK_KIND).subarray(0, 10))).toThrow()
  })

  it('类型和数值越界报错', () => {
    expect(() => encodeTransactionData(data({ gas: { payment: [], owner: SENDER, price: -1n, budget: 1n } }))).toThrow()
    const ptb = new PtbBuilder()
    ptb.moveCall('0x2::m::f', ['0x2::m::T<'], [])
    expect(() => encodeTransactionKind(ptb.build())).toThrow()
    expect(() => bcsPure.u8(300)).toThrow(RangeError)
    const vec = (type: string) => {
      const p = new PtbBuilder()
      p.command({ kind: 'makeMoveVec', type, elements: [] })
      return hex.encode(encodeTransactionKind(p.build()))
    }
    expect(vec('vector <u8>')).toBe(vec('vector<u8>'))
    const bad = new PtbBuilder()
    bad.command({ kind: 'makeMoveVec', type: 'constructor', elements: [] })
    expect(() => encodeTransactionKind(bad.build())).toThrow()
  })
})

describe('签名', () => {
  it('suiprivkey / hex / 32 字节 / 64 字节（种子 + 公钥）私钥得到同一个地址和签名', async () => {
    const seed = hex.decode(SECRET)
    const inputs = [SUIPRIVKEY, SECRET, `0x${SECRET}`, seed, new Uint8Array([...seed, ...Uint8Array.from(atob(PUBLIC_KEY), (c) => c.charCodeAt(0))])]
    for (const input of inputs) {
      const signer = await resolveSigner(input)
      expect(signer.address).toBe(SENDER)
      expect(signer.kind).toBe('local')
      // Ed25519 签名是确定性的
      expect((await signer.sign(hex.decode(TX1), 'mainnet')).signature).toBe(SIG1)
    }
  })

  it('公钥 → 地址', () => {
    expect(ed25519Address(Uint8Array.from(atob(PUBLIC_KEY), (c) => c.charCodeAt(0)))).toBe(SENDER)
  })

  it('无效私钥报错', async () => {
    await expect(resolveSigner('suiprivkey1qqqsyqcyq5rqwzqfpg9scrgwpugpzysnzs23v9ccrydpk8qarc0jqa4ffsx')).rejects.toThrow()
    await expect(resolveSigner('0x1234')).rejects.toThrow()
    await expect(resolveSigner(new Uint8Array(31))).rejects.toThrow()
    await expect(resolveSigner({} as never)).rejects.toThrow(/Invalid signer/)
  })

  it('自定义 SuiSigner 和 @mysten/sui Keypair 形状', async () => {
    const local = await resolveSigner(SECRET)
    const custom = await resolveSigner({ address: SENDER.toUpperCase().replace('0X', '0x'), signTransaction: async (tx: Uint8Array) => (await local.sign(tx, 'mainnet')).signature })
    expect(custom.address).toBe(SENDER)
    expect((await custom.sign(hex.decode(TX1), 'mainnet')).signature).toBe(SIG1)
    const keypair = await resolveSigner({ toSuiAddress: () => SENDER, signTransaction: async (tx: Uint8Array) => ({ signature: (await local.sign(tx, 'mainnet')).signature }) })
    expect(keypair.address).toBe(SENDER)
  })

  it('Wallet Standard：按链签名，账户不在钱包里时报错', async () => {
    const local = await resolveSigner(SECRET)
    const chains: string[] = []
    const wallet: SuiWalletLike = {
      accounts: [{ address: SENDER, chains: ['sui:mainnet', 'sui:testnet'] }],
      features: {
        'sui:signTransaction': {
          signTransaction: async (input: { transaction: { toJSON(): Promise<string> }; chain: string }) => {
            chains.push(input.chain)
            const bytes = Uint8Array.from(atob(await input.transaction.toJSON()), (c) => c.charCodeAt(0))
            return { bytes: await input.transaction.toJSON(), signature: (await local.sign(bytes, input.chain)).signature }
          },
        },
      },
    }
    const signer = await resolveSigner(wallet)
    expect(signer.kind).toBe('wallet')
    expect(signer.address).toBe(SENDER)
    expect((await signer.sign(hex.decode(TX1), 'testnet')).signature).toBe(SIG1)
    expect(chains).toEqual(['sui:testnet'])
    await expect(resolveSigner({ wallet, account: '0x5' })).rejects.toThrow()
  })
})
