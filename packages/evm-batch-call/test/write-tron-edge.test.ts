import { Interface, Wallet, computeAddress } from 'ethers'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { resetMulticallCache } from '../src/aggregate.js'
import { resetDecimalsCache } from '../src/erc20.js'
import { NATIVE_TOKEN, Provider, TRON_CHAIN_ID, TronProvider, toTronAddress } from '../src/index.js'
import { batchCall, batchCollect, batchTransfer } from '../src/subpaths/write.js'
import { ACTIVATION_FEE, NEW_ACCOUNT_FEE, createFakeTron, type FakeTronOptions } from './fakeTron.js'

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
const NO_TOKEN = toTronAddress('0x1000000000000000000000000000000000000009')
const TRX = 1_000_000n
const fast = { pollInterval: 1, timeout: 5_000 }
const token = new Interface(['function faucet()', 'function transfer(address to, uint256 amount) returns (bool)'])

function setup(options: FakeTronOptions = {}) {
  const chain = createFakeTron(options)
  chain.setTrx(A, 1000n * TRX)
  chain.setTrx(GAS, 1000n * TRX)
  chain.setTrx(HOT, 1n)
  chain.setTrx(R1, 1n)
  chain.addToken(USDT, 6, { [A]: 1_000_000_000n })
  const multi = new Provider(TRON_CHAIN_ID.mainnet, new TronProvider({ request: chain.request }), { nativeBalance: 'rpc' })
  return { chain, multi }
}

/** 用 KEY_A 签名、但返回值可以改写的自定义签名器 */
function signer(rewrite: (signature: string) => string, key = KEY_A) {
  const wallet = new Wallet(key)
  return { address: tron(key), signDigest: async (digest: string) => rewrite(wallet.signingKey.sign(digest).serialized) }
}

beforeEach(() => {
  resetMulticallCache()
  resetDecimalsCache()
})
afterEach(() => vi.restoreAllMocks())

describe('签名器', () => {
  it('自定义签名器返回的签名不对：长度、v、s 为 0、r 为 0', async () => {
    const { chain, multi } = setup()
    const cases: Array<[string, (s: string) => string, string]> = [
      ['长度', () => '0xabc', 'did not return a 65-byte signature'],
      ['v', (s) => `${s.slice(0, -2)}05`, 'returned an invalid signature'],
      ['s 为 0', (s) => `${s.slice(0, 66)}${'00'.repeat(32)}1b`, 'returned an invalid signature'],
      ['r 为 0', (s) => `0x${'00'.repeat(32)}${s.slice(66)}`, 'returned an invalid signature'],
    ]
    for (const [, rewrite, message] of cases) {
      const [result] = await batchCall(multi, [{ from: signer(rewrite), to: R1, value: TRX }], fast)
      expect(result?.status).toBe('failed')
      expect(result?.error).toContain(message)
    }
    expect(chain.broadcasts).toHaveLength(0)
  })

  it('签名器出错、私钥 / 签名器格式不对、adapter 没连接', async () => {
    const { multi } = setup()
    const broken = {
      address: A,
      signDigest: async () => {
        throw new Error('device disconnected')
      },
    }
    const [result] = await batchCall(multi, [{ from: broken, to: R1, value: TRX }], fast)
    expect(result).toMatchObject({ status: 'failed', error: 'device disconnected' })
    await expect(batchCall(multi, [{ from: 'not a key', to: R1, value: 1n }], fast)).rejects.toThrow('Invalid private key')
    await expect(batchCall(multi, [{ from: {} as never, to: R1, value: 1n }], fast)).rejects.toThrow('Invalid Tron signer')
    const adapter = { address: null, signTransaction: async () => ({}) }
    await expect(batchCall(multi, [{ from: adapter, to: R1, value: 1n }], fast)).rejects.toThrow('Wallet is not connected')
  })
})

describe('资源与节点', () => {
  it('免费带宽用完时：质押带宽够用就不收带宽费；都不够时按字节算进花费', async () => {
    const withStake = setup({ staked: { [A]: { NetLimit: 5000 } } })
    withStake.chain.setTrx(A, TRX)
    withStake.chain.exhaustFreeBandwidth(A)
    const [ok] = await batchTransfer(withStake.multi, KEY_A, [{ to: R1, amount: TRX }], fast)
    expect(ok?.status).toBe('confirmed')
    expect(withStake.chain.trx(A)).toBe(0n)

    const noStake = setup()
    noStake.chain.setTrx(A, TRX)
    noStake.chain.exhaustFreeBandwidth(A)
    const [short] = await batchTransfer(noStake.multi, KEY_A, [{ to: R1, amount: TRX }], fast)
    expect(short?.status).toBe('failed')
    expect(short?.error).toContain('insufficient TRX')
  })

  it('读不到参考区块：这笔失败，同一批里下一笔重新读（不用缓存里失败的结果）', async () => {
    const { chain, multi } = setup()
    let failures = 1
    chain.intercept((path) => {
      if (path === 'wallet/getblock' && failures-- > 0) return {} // 返回的区块缺字段
      return undefined
    })
    const results = await batchCall(
      multi,
      [
        { from: KEY_A, to: R1, value: TRX },
        { from: KEY_A, to: R1, value: TRX },
      ],
      { ...fast, continueOnError: true },
    )
    expect(results.map((r) => r.status)).toEqual(['failed', 'confirmed'])
    expect(results[0]?.error).toContain('Unable to read the latest Tron block')
  })

  it('给没激活的地址转 TRX：按激活费计费，不另收普通带宽费（免费带宽用完时也不会误判余额不足）', async () => {
    const { chain, multi } = setup()
    const amount = 5n * TRX
    chain.setTrx(B, amount + ACTIVATION_FEE)
    chain.exhaustFreeBandwidth(B)
    const [result] = await batchTransfer(multi, KEY_B, [{ to: R2, amount }], fast)
    expect(result).toMatchObject({ status: 'confirmed', fee: ACTIVATION_FEE.toString() })
    expect(chain.trx(B)).toBe(0n)
    expect(chain.trx(R2)).toBe(amount)
  })

  it('给没激活的地址转 TRX、质押带宽够用：创建账户的带宽用质押的，只收激活费 1 TRX', async () => {
    const { chain, multi } = setup({ staked: { [B]: { NetLimit: 5000 } } })
    const amount = 5n * TRX
    chain.setTrx(B, amount + NEW_ACCOUNT_FEE)
    const [result] = await batchTransfer(multi, KEY_B, [{ to: R2, amount }], fast)
    expect(result).toMatchObject({ status: 'confirmed', fee: NEW_ACCOUNT_FEE.toString() })
    expect(chain.trx(B)).toBe(0n)
  })

  it('质押的能量够用：合约调用不烧 TRX，TRX 很少也能发', async () => {
    const { chain, multi } = setup({ staked: { [B]: { EnergyLimit: 100_000 } } })
    chain.setTrx(B, TRX)
    chain.addToken(USDT, 6, { [B]: 10n })
    const [result] = await batchTransfer(multi, KEY_B, [{ to: R2, amount: 10n, token: USDT }], fast)
    expect(result).toMatchObject({ status: 'confirmed', fee: '0' })
    expect(chain.token(USDT, R2)).toBe(10n)
  })

  it('广播时连接出错：按 sent 跟踪；节点返回确定性错误码：失败（消息不是 UTF-8 十六进制时原样给出）', async () => {
    const { chain, multi } = setup()
    chain.intercept(async (path, _body, next) => {
      if (path !== 'wallet/broadcasthex') return undefined
      await next()
      throw new Error('socket hang up')
    })
    const updates: Array<string | null> = []
    const [uncertain] = await batchCall(multi, [{ from: KEY_A, to: R1, value: TRX }], { ...fast, onUpdate: (r) => updates.push(r.error) })
    expect(uncertain?.status).toBe('confirmed')
    expect(updates[0]).toContain('broadcast not acknowledged')
    expect(new Set(chain.broadcasts).size).toBe(1) // 只签了一笔（等待时重发的是同一笔）
    chain.intercept((path) => (path === 'wallet/broadcasthex' ? { code: 'SIGERROR', message: 'zz' } : undefined))
    const [rejected] = await batchCall(multi, [{ from: KEY_A, to: R1, value: TRX }], fast)
    expect(rejected).toMatchObject({ status: 'failed', error: 'SIGERROR: zz' })
  })

  it('配给 Tron 链的不是 Tron 节点：报错', async () => {
    const multi = new Provider(TRON_CHAIN_ID.mainnet, { call: async () => '0x', getBalance: async () => 0n } as never)
    await expect(batchCall(multi, [{ from: KEY_A, to: R1, value: 1n }], fast)).rejects.toThrow('Not a Tron node')
  })

  it('固化数据查询出错：不确定，不会重发，超时后 pending', async () => {
    const { chain, multi } = setup({ drop: 1 })
    chain.intercept((path) => {
      if (path.startsWith('walletsolidity/')) throw new Error('solidity node unavailable')
      return undefined
    })
    let offset = 0
    const now = Date.now.bind(Date)
    vi.spyOn(Date, 'now').mockImplementation(() => now() + offset)
    const [result] = await batchCall(multi, [{ from: KEY_A, to: R1, value: TRX }], {
      ...fast,
      timeout: 300,
      onUpdate: (r) => {
        if (r.status === 'sent' && offset === 0) offset = 200_000
      },
    })
    expect(result?.status).toBe('pending')
    expect(new Set(chain.broadcasts).size).toBe(1)
  })
})

describe('发送流程', () => {
  it('后一笔依赖前一笔：模拟失败时先等前一笔确认再模拟', async () => {
    const { chain, multi } = setup({ landAfterPolls: 2 })
    chain.setTrx(B, 1000n * TRX)
    const results = await batchCall(
      multi,
      [
        { from: KEY_B, to: USDT, data: token.encodeFunctionData('faucet') },
        { from: KEY_B, to: USDT, data: token.encodeFunctionData('transfer', ['0x5000000000000000000000000000000000000002', 500n]) }, // B 的代币来自上一笔
      ],
      fast,
    )
    expect(results.map((r) => r.status)).toEqual(['confirmed', 'confirmed'])
    expect(chain.token(USDT, R2)).toBe(500n)
  })

  it('等前一笔确认（依赖）时取消：后面的 skipped', async () => {
    const { chain, multi } = setup({ landAfterPolls: 10_000 })
    chain.setTrx(B, 1000n * TRX)
    const controller = new AbortController()
    const results = await batchCall(
      multi,
      [
        { from: KEY_B, to: USDT, data: token.encodeFunctionData('faucet') },
        { from: KEY_B, to: USDT, data: token.encodeFunctionData('transfer', ['0x5000000000000000000000000000000000000002', 500n]) },
      ],
      { ...fast, pollInterval: 20, signal: controller.signal, onUpdate: (r) => r.status === 'sent' && setTimeout(() => controller.abort(), 30) },
    )
    expect(results.map((r) => [r.status, r.error])).toEqual([
      ['sent', null],
      ['skipped', 'aborted'],
    ])
  })

  it('过期重发次数用完：failed', async () => {
    const { chain, multi } = setup({ drop: 10 })
    let offset = 0
    const now = Date.now.bind(Date)
    vi.spyOn(Date, 'now').mockImplementation(() => now() + offset)
    const [result] = await batchCall(multi, [{ from: KEY_A, to: R1, value: TRX }], {
      ...fast,
      timeout: 600_000,
      retries: 1,
      onUpdate: (r) => {
        if (r.status === 'sent') offset += 200_000
      },
    })
    expect(result).toMatchObject({ status: 'failed', error: 'transaction expired before it was confirmed' })
    expect(new Set(chain.broadcasts).size).toBe(2)
  })

  it('等到 timeout 还没确认：pending；等待时取消：保持 sent', async () => {
    const { multi } = setup({ landAfterPolls: 100_000 })
    const [pending] = await batchCall(multi, [{ from: KEY_A, to: R1, value: TRX }], { ...fast, timeout: 30 })
    expect(pending?.status).toBe('pending')
    const controller = new AbortController()
    const [sent] = await batchCall(multi, [{ from: KEY_A, to: R1, value: TRX }], {
      ...fast,
      pollInterval: 20,
      signal: controller.signal,
      onUpdate: (r) => r.status === 'sent' && setTimeout(() => controller.abort(), 30),
    })
    expect(sent?.status).toBe('sent')
  })

  it('continueOnError 为 false：失败之后同一钱包的调用跳过；onUpdate 抛错不影响', async () => {
    const { chain, multi } = setup()
    chain.block(USDT, R1)
    const results = await batchCall(
      multi,
      [
        { from: KEY_A, to: USDT, data: token.encodeFunctionData('transfer', ['0x5000000000000000000000000000000000000001', 1n]) }, // R1 被拉黑
        { from: KEY_A, to: R2, value: TRX },
      ],
      {
        ...fast,
        onUpdate: () => {
          throw new Error('ui bug')
        },
      },
    )
    expect(results.map((r) => r.status)).toEqual(['failed', 'skipped'])
    expect(chain.trx(R2)).toBeNull()
  })
})

describe('batchTransfer 参数', () => {
  it('地址、数量、精度、余额读取的校验；7702 不支持', async () => {
    const { multi } = setup()
    await expect(batchTransfer(multi, KEY_A, [{ to: 'bad', amount: 1n }], fast)).rejects.toThrow('invalid address')
    await expect(batchTransfer(multi, KEY_A, [{ to: R1, amount: 1n, formatted: '1' }], fast)).rejects.toThrow('exactly one')
    await expect(batchTransfer(multi, KEY_A, [{ to: R1, formatted: '1', token: NO_TOKEN }], fast)).rejects.toThrow('cannot read decimals')
    await expect(batchTransfer(multi, KEY_A, [{ to: R1, amount: 0n }], fast)).rejects.toThrow('must be positive')
    await expect(batchTransfer(multi, KEY_A, [{ to: R1, amount: 1n, token: NO_TOKEN }], fast)).rejects.toThrow('Cannot read the balance')
    await expect(batchTransfer(multi, KEY_A, [{ to: R1, amount: 1n }], { mode: '7702' })).rejects.toThrow('not supported on Tron')
  })
})

describe('batchCollect 跳过与失败', () => {
  it('读不到代币、钱包就是归集地址、重复钱包、余额为 0、低于 minAmount', async () => {
    const { chain, multi } = setup()
    chain.addToken(USDT, 6, { [A]: 5n, [B]: 50n })
    chain.setTrx(B, 100n * TRX)
    const { results } = await batchCollect(multi, [KEY_A, KEY_B, KEY_B, KEY_C], A, { ...fast, tokens: [NO_TOKEN, USDT], minAmount: { [USDT]: 100n } })
    expect(results.map((r) => r.error)).toEqual([
      'cannot read balance: reverted',
      'skipped: wallet is the collect address',
      'cannot read balance: reverted',
      'skipped: below minAmount',
      'cannot read balance: reverted',
      'skipped: duplicate wallet',
      'cannot read balance: reverted',
      'skipped: zero balance',
    ])
  })

  it('TRX 余额读不到（success: false）：不补 gas', async () => {
    const { chain, multi } = setup()
    chain.addToken(USDT, 6, { [B]: 5n })
    const real = multi.multiBalances.bind(multi)
    vi.spyOn(multi, 'multiBalances').mockImplementation((async (queries: never, options: never) => {
      const result = await real(queries, options)
      result.forEach((list) => list.forEach((b) => b.native && Object.assign(b, { success: false, error: 'reverted', balance: '0' })))
      return result
    }) as never)
    const { results, topUps } = await batchCollect(multi, [KEY_B], HOT, { ...fast, tokens: [USDT], gasWallet: KEY_GAS })
    expect(topUps).toEqual([])
    expect(results[0]?.error).toBe('cannot read the TRX balance: reverted')
  })

  it('归集转账模拟失败：这一项失败；补 gas 失败：这些钱包的项失败', async () => {
    const { chain, multi } = setup()
    chain.addToken(USDT, 6, { [B]: 5n, [C]: 7n })
    chain.block(USDT, HOT)
    const blocked = await batchCollect(multi, [KEY_B], HOT, { ...fast, tokens: [USDT], gasWallet: KEY_GAS })
    expect(blocked.results[0]?.error).toContain('blocked')

    const rejecting = {
      defaultAddress: { base58: GAS },
      trx: {
        sign: async () => {
          throw new Error('Confirmation declined by user')
        },
      },
    }
    const declined = await batchCollect(multi, [KEY_C], R2, { ...fast, tokens: [USDT], gasWallet: rejecting })
    expect(declined.topUps[0]?.status).toBe('failed')
    expect(declined.results[0]?.error).toBe('gas top-up failed: rejected by user')
  })

  it('扫 TRX：低于 minAmount 跳过；读资源出错时这一项失败', async () => {
    const { chain, multi } = setup()
    chain.setTrx(B, 5n * TRX)
    chain.setTrx(C, 5n * TRX)
    const below = await batchCollect(multi, [KEY_B], HOT, { ...fast, tokens: [NATIVE_TOKEN], minAmount: { [NATIVE_TOKEN]: 100n * TRX } })
    expect(below.results[0]?.error).toBe('skipped: below minAmount')
    chain.intercept((path) => {
      if (path === 'wallet/getaccountresource') throw new Error('node down')
      return undefined
    })
    const failed = await batchCollect(multi, [KEY_C], HOT, { ...fast, tokens: [NATIVE_TOKEN] })
    expect(failed.results[0]).toMatchObject({ status: 'failed', error: 'node down' })
  })

  it('扫 TRX 前判断归集地址是不是合约时出错：扫 TRX 的项失败，代币的结果照常返回', async () => {
    const { chain, multi } = setup()
    chain.addToken(USDT, 6, { [C]: 7n })
    chain.setTrx(C, 100n * TRX)
    chain.intercept((path) => {
      if (path === 'wallet/getcontract') throw new Error('node down')
      return undefined
    })
    const { results } = await batchCollect(multi, [KEY_C], HOT, { ...fast, tokens: [USDT, NATIVE_TOKEN] })
    expect(results[0]?.status).toBe('confirmed')
    expect(results[1]).toMatchObject({ status: 'failed', error: 'cannot check the collect address: node down' })
  })
})
