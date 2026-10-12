import { Wallet, computeAddress, sha256 } from 'ethers'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { resetMulticallCache } from '../src/aggregate.js'
import { resetDecimalsCache } from '../src/erc20.js'
import { Contract, ERC20_ABI, NATIVE_TOKEN, Provider, TRON_CHAIN_ID, TronProvider, toTronAddress } from '../src/index.js'
import { batchCall, batchCollect, batchTransfer, revokeDelegation } from '../src/subpaths/write.js'
import { encodeRawData } from '../src/write/tron.js'
import { ACTIVATION_FEE, ENERGY_FEE, TRANSFER_ENERGY, TRANSFER_ENERGY_NEW_HOLDER, createFakeTron, type FakeTronOptions } from './fakeTron.js'

const KEY_A = `0x${'11'.repeat(32)}`
const KEY_B = `0x${'22'.repeat(32)}`
const KEY_C = `0x${'33'.repeat(32)}`
const KEY_GAS = `0x${'44'.repeat(32)}`
const tron = (key: string) => toTronAddress(computeAddress(key))
const A = tron(KEY_A)
const B = tron(KEY_B)
const C = tron(KEY_C)
const GAS = tron(KEY_GAS)
const R1 = toTronAddress('0x5000000000000000000000000000000000000001')
const R2 = toTronAddress('0x5000000000000000000000000000000000000002')
const HOT = toTronAddress('0x6000000000000000000000000000000000000006')
const USDT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'
const TRX = 1_000_000n
const fast = { pollInterval: 1, timeout: 5_000 }

function setup(options: FakeTronOptions = {}) {
  const chain = createFakeTron(options)
  chain.setTrx(A, 1000n * TRX)
  chain.setTrx(GAS, 1000n * TRX)
  chain.setTrx(HOT, 1n)
  chain.addToken(USDT, 6, { [A]: 1_000_000_000n })
  const multi = new Provider(TRON_CHAIN_ID.mainnet, new TronProvider({ request: chain.request }), { nativeBalance: 'rpc' })
  return { chain, multi }
}

beforeEach(() => {
  resetMulticallCache()
  resetDecimalsCache()
})

describe('Tron 交易编码', () => {
  it('raw_data 与 TronWeb 6.5.1（txJsonToPb → txPbToRawDataHex）生成的逐字节一致', () => {
    const owner = toTronAddress('0x5cbdd86a2fa8dc4bddd8a8f69dba48572eec07fb')
    const ref = { number: 0xe2a1, hash: `${'00'.repeat(8)}d1ccdc3b7e1b5d7c${'00'.repeat(16)}`, timestamp: 0 }
    const transfer = encodeRawData({ type: 'transfer', owner, to: toTronAddress('0x928c9af0651632157ef27a2cf17ca72c575a4d21'), amount: 1_000_000n }, ref, 1700000060000, 1700000000000, 0n)
    expect(Buffer.from(transfer).toString('hex')).toBe(
      '0a02e2a12208d1ccdc3b7e1b5d7c40e0a499ffbc315a67080112630a2d747970652e676f6f676c65617069732e636f6d2f70726f746f636f6c2e5472616e73666572436f6e747261637412320a15415cbdd86a2fa8dc4bddd8a8f69dba48572eec07fb121541928c9af0651632157ef27a2cf17ca72c575a4d2118c0843d7080d095ffbc31',
    )
    const data = '0xa9059cbb000000000000000000000000928c9af0651632157ef27a2cf17ca72c575a4d2100000000000000000000000000000000000000000000000000000000000f4240'
    const trigger = encodeRawData({ type: 'trigger', owner, contract: USDT, data, callValue: 0n }, ref, 1700000060000, 1700000000000, 15_000_000n)
    expect(Buffer.from(trigger).toString('hex')).toBe(
      '0a02e2a12208d1ccdc3b7e1b5d7c40e0a499ffbc315aae01081f12a9010a31747970652e676f6f676c65617069732e636f6d2f70726f746f636f6c2e54726967676572536d617274436f6e747261637412740a15415cbdd86a2fa8dc4bddd8a8f69dba48572eec07fb121541a614f803b6fd780986a42c78ec9c7f77e6ded13c2244a9059cbb000000000000000000000000928c9af0651632157ef27a2cf17ca72c575a4d2100000000000000000000000000000000000000000000000000000000000f42407080d095ffbc319001c0c39307',
    )
  })
})

describe('Tron batchTransfer', () => {
  it('TRX 和 TRC20 混合：每个收款人一笔交易', async () => {
    const { chain, multi } = setup()
    const results = await batchTransfer(
      multi,
      KEY_A,
      [
        { to: R1, formatted: '1.5' },
        { to: R2, token: USDT, formatted: '20' },
      ],
      fast,
    )
    expect(results.map((r) => [r.status, r.via, r.from, r.to])).toEqual([
      ['confirmed', 'tx', A, R1],
      ['confirmed', 'tx', A, R2],
    ])
    expect(results[0]).toMatchObject({ native: true, amount: '1500000', formatted: '1.5' })
    expect(results[0]?.hash).toMatch(/^[0-9a-f]{64}$/)
    expect(chain.trx(R1)).toBe(1_500_000n)
    expect(chain.token(USDT, R2)).toBe(20_000_000n)
    // 第一笔：激活 R1 的费用（免费带宽够用）；第二笔：烧的能量 + 免费带宽用完后按字节烧的带宽
    expect(results[0]?.fee).toBe(ACTIVATION_FEE.toString())
    expect(results[1]?.gasUsed).toBe(String(TRANSFER_ENERGY_NEW_HOLDER))
    expect(BigInt(results[1]!.fee!)).toBeGreaterThan(BigInt(TRANSFER_ENERGY_NEW_HOLDER) * ENERGY_FEE)
  })

  it('模拟 revert 的收款项单独失败，不花手续费；余额不够时抛错', async () => {
    const { chain, multi } = setup()
    chain.block(USDT, R1)
    const results = await batchTransfer(
      multi,
      KEY_A,
      [
        { to: R1, amount: 1n },
        { to: R2, amount: 2n },
      ],
      { ...fast, token: USDT },
    )
    expect(results.map((r) => r.status)).toEqual(['failed', 'confirmed'])
    expect(results[0]?.error).toContain('blocked')
    expect(chain.broadcasts).toHaveLength(1)
    await expect(batchTransfer(multi, KEY_A, [{ to: R1, amount: 10n ** 12n, token: USDT }], fast)).rejects.toThrow('Insufficient balance')
  })

  it('交易过期没上链：换新的参考区块重发', async () => {
    const { chain, multi } = setup({ drop: 1 })
    let offset = 0
    const now = Date.now.bind(Date)
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => now() + offset)
    try {
      const results = await batchTransfer(multi, KEY_A, [{ to: R1, amount: TRX }], {
        ...fast,
        timeout: 600_000,
        onUpdate: (r) => {
          if (r.status === 'sent' && offset === 0) offset = 200_000 // 第一笔发出后时间过去 200 秒：固化区块也超过了过期时间 + 60 秒（节点和库用同一个时钟）
        },
      })
      expect(results[0]?.status).toBe('confirmed')
      expect(new Set(chain.broadcasts).size).toBe(2)
      expect(chain.trx(R1)).toBe(TRX)
    } finally {
      spy.mockRestore()
    }
  })
})

describe('Tron 过期判断', () => {
  it('本地时钟比链上快：不会误判过期而重发（按链上区块时间判断）', async () => {
    const real = Date.now.bind(Date)
    const { chain, multi } = setup({ landAfterPolls: 5, clock: real })
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => real() + 200_000)
    try {
      const results = await batchTransfer(multi, KEY_A, [{ to: R1, amount: TRX }], { ...fast, timeout: 600_000 })
      expect(results[0]?.status).toBe('confirmed')
      expect(new Set(chain.broadcasts).size).toBe(1) // 只有一笔（等待期间的重发是同一笔）
      expect(chain.trx(R1)).toBe(TRX)
    } finally {
      spy.mockRestore()
    }
  })
})

describe('Tron batchCall', () => {
  it('Contract 生成的调用和 TRX 转账；7702 / revokeDelegation 报不支持', async () => {
    const { chain, multi } = setup()
    const usdt = new Contract(USDT, ERC20_ABI)
    const results = await batchCall(
      multi,
      [
        { from: KEY_A, call: usdt.transfer(R1, 5n) },
        { from: KEY_A, to: R2, value: 3n * TRX },
      ],
      fast,
    )
    expect(results.map((r) => r.status)).toEqual(['confirmed', 'confirmed'])
    expect(chain.token(USDT, R1)).toBe(5n)
    expect(chain.trx(R2)).toBe(3n * TRX)
    await expect(batchCall(multi, [{ from: KEY_A, to: R1, value: 1n }], { mode: '7702' })).rejects.toThrow('not supported on Tron')
    await expect(revokeDelegation(multi, KEY_A)).rejects.toThrow('not supported on Tron')
  })

  it('ethers Wallet 和自定义签名器都可以', async () => {
    const { chain, multi } = setup()
    const wallet = new Wallet(KEY_A)
    const custom = { address: A, signDigest: async (digest: string) => wallet.signingKey.sign(digest).serialized }
    const results = await batchCall(
      multi,
      [
        { from: wallet, to: R1, value: TRX },
        { from: custom, to: R1, value: TRX },
      ],
      fast,
    )
    expect(results.map((r) => r.status)).toEqual(['confirmed', 'confirmed'])
    expect(chain.trx(R1)).toBe(2n * TRX)
  })
})

describe('Tron batchCollect', () => {
  it('没激活的钱包由补 gas 激活 → 归集代币 → 扫空 TRX', async () => {
    const { chain, multi } = setup()
    chain.addToken(USDT, 6, { [B]: 5_000_000n, [C]: 7_000_000n, [HOT]: 1n })
    chain.setTrx(C, 100n * TRX) // C 自己的 TRX 够付手续费
    const { results, topUps } = await batchCollect(multi, [KEY_B, KEY_C], HOT, { ...fast, tokens: [USDT, NATIVE_TOKEN], gasWallet: KEY_GAS })
    // B 没激活：补的 gas = 能量（× 1.2）+ 带宽（没激活时按没有免费带宽算）
    expect(topUps.map((t) => [t.to, t.status])).toEqual([[B, 'confirmed']])
    expect(BigInt(topUps[0]!.amount)).toBeGreaterThan(BigInt(TRANSFER_ENERGY) * ENERGY_FEE)
    expect(results.map((r) => [r.from, r.token, r.status])).toEqual([
      [B, USDT, 'confirmed'],
      [B, NATIVE_TOKEN, 'confirmed'],
      [C, USDT, 'confirmed'],
      [C, NATIVE_TOKEN, 'confirmed'],
    ])
    expect(chain.token(USDT, HOT)).toBe(12_000_001n)
    // 扫空：免费带宽够用时不收手续费，余额归零
    expect(chain.trx(B)).toBe(0n)
    expect(chain.trx(C)).toBe(0n)
    expect(chain.trx(GAS)).toBe(1000n * TRX - BigInt(topUps[0]!.amount) - ACTIVATION_FEE)
  })

  it('没有 gasWallet 时 TRX 不够的钱包失败；dryRun 不发交易', async () => {
    const { chain, multi } = setup()
    chain.addToken(USDT, 6, { [B]: 5_000_000n })
    const { results } = await batchCollect(multi, [KEY_B], HOT, { ...fast, tokens: [USDT] })
    expect(results[0]?.status).toBe('failed')
    expect(results[0]?.error).toContain('gasWallet')
    const dry = await batchCollect(multi, [KEY_B], HOT, { ...fast, tokens: [USDT], gasWallet: KEY_GAS, dryRun: true })
    expect(dry.results[0]?.status).toBe('simulated')
    expect(dry.topUps[0]?.status).toBe('simulated')
    expect(chain.broadcasts).toHaveLength(0)
  })
})

/** 假的浏览器钱包：注入的 tronWeb 或 tronwallet-adapter；signWith 用来模拟切换了账户 */
function fakeTronWallet(key: string, options: { reject?: boolean; signWith?: string; adapter?: boolean; connected?: boolean } = {}) {
  const prompts: Array<Record<string, any>> = []
  const signer = new Wallet(options.signWith ?? key)
  const sign = async (tx: Record<string, any>) => {
    prompts.push(tx)
    // 与 TronWeb 的 trx.sign 相同的检查：txID = sha256(raw_data_hex)
    if (sha256(`0x${tx.raw_data_hex}`).slice(2) !== tx.txID) throw new Error('Invalid transaction')
    if (options.reject) throw new Error('Confirmation declined by user')
    return { ...tx, signature: [signer.signingKey.sign(`0x${tx.txID}`).serialized.slice(2)] }
  }
  const address = options.connected === false ? null : tron(key)
  const wallet = options.adapter ? { address, signTransaction: sign } : { defaultAddress: { base58: address ?? false }, trx: { sign } }
  return { wallet, prompts }
}

describe('Tron 浏览器钱包', () => {
  it('tronWeb（TronLink）签名：每笔交易一次确认，交易 JSON 与 raw_data_hex 一致，过期时间放宽到 3 分钟', async () => {
    const { chain, multi } = setup()
    const { wallet, prompts } = fakeTronWallet(KEY_A)
    const results = await batchTransfer(
      multi,
      wallet,
      [
        { to: R1, amount: TRX },
        { to: R2, token: USDT, amount: 7n },
      ],
      fast,
    )
    expect(results.map((r) => r.status)).toEqual(['confirmed', 'confirmed'])
    expect(prompts).toHaveLength(2)
    expect(prompts[0]?.raw_data.contract[0].type).toBe('TransferContract')
    expect(prompts[1]?.raw_data.contract[0].type).toBe('TriggerSmartContract')
    expect(prompts[1]?.raw_data.fee_limit).toBeGreaterThan(0)
    expect(prompts[0]?.raw_data.expiration - prompts[0]?.raw_data.timestamp).toBeGreaterThan(170_000)
    expect(chain.trx(R1)).toBe(TRX)
    expect(chain.token(USDT, R2)).toBe(7n)
  })

  it('tronwallet-adapter；钱包当 gasWallet 给子钱包补 gas', async () => {
    const { chain, multi } = setup()
    chain.addToken(USDT, 6, { [B]: 5_000_000n })
    const { wallet, prompts } = fakeTronWallet(KEY_GAS, { adapter: true })
    const { results, topUps } = await batchCollect(multi, [KEY_B], HOT, { ...fast, tokens: [USDT], gasWallet: wallet })
    expect(topUps[0]?.status).toBe('confirmed')
    expect(results[0]?.status).toBe('confirmed')
    expect(prompts).toHaveLength(1)
  })

  it('用户拒绝、钱包切换了账户、没连接', async () => {
    const { chain, multi } = setup()
    const rejected = await batchTransfer(multi, fakeTronWallet(KEY_A, { reject: true }).wallet, [{ to: R1, amount: TRX }], fast)
    expect(rejected[0]).toMatchObject({ status: 'failed', error: 'rejected by user' })
    const switched = await batchTransfer(multi, fakeTronWallet(KEY_A, { signWith: KEY_B }).wallet, [{ to: R1, amount: TRX }], fast)
    expect(switched[0]?.status).toBe('failed')
    expect(switched[0]?.error).toContain('switched account')
    expect(chain.broadcasts).toHaveLength(0)
    await expect(batchTransfer(multi, fakeTronWallet(KEY_A, { connected: false }).wallet, [{ to: R1, amount: TRX }], fast)).rejects.toThrow('not connected')
  })
})

describe('Tron review 回归', () => {
  it('查交易信息出错、本地时钟又快：不会当成没上链而重发', async () => {
    const real = Date.now.bind(Date)
    const { chain, multi } = setup({ landAfterPolls: 3, infoErrors: 4, clock: real })
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => real() + 300_000)
    try {
      const [result] = await batchTransfer(multi, KEY_A, [{ to: R1, amount: TRX }], { ...fast, timeout: 600_000 })
      expect(result?.status).toBe('confirmed')
      expect(new Set(chain.broadcasts).size).toBe(1)
      expect(chain.trx(R1)).toBe(TRX)
    } finally {
      spy.mockRestore()
    }
  })

  it('广播返回 TAPOS_ERROR 等节点层面的错误但交易已被收下：继续跟踪，不报 failed', async () => {
    const { chain, multi } = setup({ broadcastCode: { code: 'TAPOS_ERROR', times: 1 } })
    const [result] = await batchTransfer(multi, KEY_A, [{ to: R1, amount: TRX }], fast)
    expect(result?.status).toBe('confirmed')
    expect(chain.trx(R1)).toBe(TRX)
  })

  it('TRX 不够付能量：发送前就失败，不会上链后 OUT_OF_ENERGY 烧掉 TRX', async () => {
    const { chain, multi } = setup()
    chain.setTrx(A, 3n * TRX)
    const results = await batchTransfer(
      multi,
      KEY_A,
      [
        { to: R1, amount: 1n },
        { to: R2, amount: 1n },
      ],
      { ...fast, token: USDT },
    )
    expect(results.map((r) => r.status)).toEqual(['failed', 'failed'])
    expect(results[0]?.error).toContain('insufficient TRX')
    expect(chain.broadcasts).toHaveLength(0)
    expect(chain.trx(A)).toBe(3n * TRX)
  })

  it('自定义签名器返回 high-s 签名（旧版 TronWeb 等）：规范化后照常发送', async () => {
    const { chain, multi } = setup()
    const wallet = new Wallet(KEY_A)
    const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n
    const highS = {
      address: A,
      signDigest: async (digest: string) => {
        const sig = wallet.signingKey.sign(digest)
        const s = N - BigInt(sig.s)
        return `${sig.r}${s.toString(16).padStart(64, '0')}${(sig.v === 27 ? 28 : 27).toString(16)}`
      },
    }
    const [result] = await batchCall(multi, [{ from: highS, to: R1, value: TRX }], fast)
    expect(result?.status).toBe('confirmed')
    expect(chain.trx(R1)).toBe(TRX)
    // 签名不是这个地址的：发送前就报错
    chain.setTrx(B, 100n * TRX)
    const wrong = { address: B, signDigest: highS.signDigest }
    const [bad] = await batchCall(multi, [{ from: wrong, to: R1, value: TRX }], fast)
    expect(bad?.status).toBe('failed')
    expect(bad?.error).toContain('expected')
  })

  it('TRX 转给合约地址：用合约调用（主网禁止 TransferContract 转给合约）；归集地址是合约时扫 TRX 也一样', async () => {
    const { chain, multi } = setup()
    const VAULT = toTronAddress('0x7000000000000000000000000000000000000007')
    chain.addVault(VAULT)
    const [result] = await batchTransfer(multi, KEY_A, [{ to: VAULT, amount: 2n * TRX }], fast)
    expect(result?.status).toBe('confirmed')
    expect(chain.trx(VAULT)).toBe(2n * TRX)

    chain.setTrx(C, 50n * TRX)
    const { results } = await batchCollect(multi, [KEY_C], VAULT, { ...fast, tokens: [NATIVE_TOKEN] })
    expect(results[0]?.status).toBe('confirmed')
    // 合约调用要预留能量（按预估 × 1.2），实际用得少，剩下一点零头
    expect(chain.trx(C)).toBeLessThan(BigInt(500 * 0.2 + 1) * ENERGY_FEE)
  })

  it('gasWallet 的 TRX 不够补 gas（含激活费）：什么都不发，直接报错', async () => {
    const { chain, multi } = setup()
    chain.addToken(USDT, 6, { [B]: 5_000_000n, [C]: 5_000_000n })
    chain.setTrx(GAS, 2n * TRX)
    await expect(batchCollect(multi, [KEY_B, KEY_C], HOT, { ...fast, tokens: [USDT], gasWallet: KEY_GAS })).rejects.toThrow('Insufficient TRX in gasWallet')
    expect(chain.broadcasts).toHaveLength(0)
  })
})
