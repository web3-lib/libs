import { Interface, Wallet, makeError } from 'ethers'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { resetMulticallCache } from '../src/aggregate.js'
import { resetNodeHealth } from '../src/fallback.js'
import { resetDecimalsCache } from '../src/erc20.js'
import { Contract, ERC20_ABI, NATIVE_TOKEN, Provider } from '../src/index.js'
import { DISPERSE_ADDRESS, SIMPLE_7702_ACCOUNT, batchCall, batchCollect, batchTransfer, revokeDelegation, type WriteResult } from '../src/subpaths/write.js'
import { resetL1OracleCache } from '../src/write/rpc.js'
import { resetDisperseCache } from '../src/write/transfer.js'
import { CHAIN_ID, GAS_PRICE, MAX_FEE, createFakeChain, type FakeChainOptions } from './fakeChain.js'

const KEY_A = `0x${'11'.repeat(32)}`
const KEY_B = `0x${'22'.repeat(32)}`
const KEY_C = `0x${'33'.repeat(32)}`
const KEY_GAS = `0x${'44'.repeat(32)}`
const A = new Wallet(KEY_A).address
const B = new Wallet(KEY_B).address
const C = new Wallet(KEY_C).address
const GAS = new Wallet(KEY_GAS).address
const TOKEN = '0x1000000000000000000000000000000000000001'
const R1 = '0x5000000000000000000000000000000000000001'
const R2 = '0x5000000000000000000000000000000000000002'
const R3 = '0x5000000000000000000000000000000000000003'
const HOT = '0x6000000000000000000000000000000000000006'
const ETH = 10n ** 18n
const fast = { pollInterval: 1, timeout: 5_000 }
const erc20 = new Interface(ERC20_ABI as unknown as string[])

function setup(options: FakeChainOptions = {}) {
  const chain = createFakeChain(options)
  chain.addToken(TOKEN, 'TKN', 6, { [A]: 1_000_000_000n, [B]: 5_000_000n, [C]: 7_000_000n })
  chain.setNative(A, 10n * ETH)
  chain.setNative(GAS, 10n * ETH)
  const multi = new Provider(CHAIN_ID, chain.node as never, { nativeBalance: 'rpc' })
  return { chain, multi }
}

beforeEach(() => {
  resetNodeHealth()
  resetMulticallCache()
  resetDecimalsCache()
  resetDisperseCache()
  resetL1OracleCache()
})

describe('batchCall', () => {
  it("'tx'：同一钱包按 nonce 顺序发送，不同钱包并发（跨钱包的依赖不保证顺序）", async () => {
    const { chain, multi } = setup({ mineAfterPolls: 2 })
    chain.setNative(B, ETH)
    const token = new Contract(TOKEN, ERC20_ABI)
    const updates: WriteResult[] = []
    const results = await batchCall(
      multi,
      [
        { from: KEY_A, call: token.approve(B, 300n) },
        { from: KEY_B, call: token.transferFrom(A, R1, 300n) }, // B 依赖 A 的 approve（不同钱包，不保证顺序：这里预估会失败）
        { from: KEY_A, call: token.transfer(R2, 100n) },
        { from: KEY_A, to: R3, value: 5n },
      ],
      { ...fast, continueOnError: true, onUpdate: (r) => updates.push(r) },
    )
    expect(results.map((r) => r.status)).toEqual(['confirmed', expect.stringMatching(/confirmed|failed/), 'confirmed', 'confirmed'])
    expect(results[0]).toMatchObject({ index: 0, from: A, to: TOKEN, nonce: 0 })
    expect(results[2]).toMatchObject({ nonce: 1 })
    expect(results[3]).toMatchObject({ nonce: 2, to: R3, gasLimit: '21000', gasUsed: '21000', fee: (21_000n * MAX_FEE).toString() })
    expect(chain.tokenBalance(TOKEN, R2)).toBe(100n)
    expect(chain.native(R3)).toBe(5n)
    expect(updates.some((u) => u.status === 'sent')).toBe(true)
  })

  it('同一钱包里依赖前一笔的调用：先等 approve 确认再预估', async () => {
    const { chain, multi } = setup({ mineAfterPolls: 3 })
    const token = new Contract(TOKEN, ERC20_ABI)
    const disperse = new Contract(DISPERSE_ADDRESS, ['function disperseToken(address token, address[] recipients, uint256[] values)'])
    const results = await batchCall(
      multi,
      [
        { from: KEY_A, call: token.approve(DISPERSE_ADDRESS, 30n) },
        { from: KEY_A, call: disperse.disperseToken(TOKEN, [R1, R2], [10n, 20n]) },
      ],
      fast,
    )
    expect(results.map((r) => r.status)).toEqual(['confirmed', 'confirmed'])
    expect(chain.tokenBalance(TOKEN, R2)).toBe(20n)
  })

  it('失败的调用不花手续费；continueOnError 为 false 时同一钱包后面的调用跳过，其他钱包不受影响', async () => {
    const { chain, multi } = setup()
    chain.setNative(B, ETH)
    const token = new Contract(TOKEN, ERC20_ABI)
    const results = await batchCall(
      multi,
      [
        { from: KEY_A, call: token.transfer(R1, 10n ** 30n) },
        { from: KEY_A, call: token.transfer(R1, 1n) },
        { from: KEY_B, call: token.transfer(R1, 2n) },
      ],
      fast,
    )
    expect(results[0]).toMatchObject({ status: 'failed', hash: null, error: expect.stringContaining('exceeds balance') })
    expect(results[1]).toMatchObject({ status: 'skipped' })
    expect(results[2]).toMatchObject({ status: 'confirmed' })
    expect(chain.native(A)).toBe(10n * ETH)
  })

  it('余额不够付 gas：广播被拒，status failed', async () => {
    const { multi } = setup()
    const results = await batchCall(multi, [{ from: KEY_C, to: R1, value: 1n }], fast)
    expect(results[0]).toMatchObject({ status: 'failed', hash: null, error: expect.stringMatching(/insufficient/) })
  })

  it('广播超时但交易已进交易池：按已发出处理，以回执为准，nonce 照常往后', async () => {
    const { chain, multi } = setup({ flakyBroadcasts: 1 })
    const results = await batchCall(
      multi,
      [
        { from: KEY_A, to: R1, value: 1n },
        { from: KEY_A, to: R2, value: 2n },
      ],
      fast,
    )
    expect(results.map((r) => [r.status, r.nonce, r.error])).toEqual([
      ['confirmed', 0, null],
      ['confirmed', 1, null],
    ])
    expect(chain.native(R1)).toBe(1n)
    expect(chain.native(R2)).toBe(2n)

    // 不等确认时 status 为 sent，error 说明广播没有得到确认
    const { chain: chain2, multi: multi2 } = setup({ flakyBroadcasts: 1, mineAfterPolls: 5 })
    const [sent] = await batchCall(multi2, [{ from: KEY_A, to: R1, value: 1n }], { ...fast, wait: false })
    expect(sent).toMatchObject({ status: 'sent', nonce: 0 })
    expect(sent?.error).toContain('broadcast not acknowledged')
    expect(chain2.broadcasts).toHaveLength(1)
  })

  it('wait: false 广播后立即返回', async () => {
    const { multi } = setup({ mineAfterPolls: 5 })
    const results = await batchCall(multi, [{ from: KEY_A, to: R1, value: 1n }], { ...fast, wait: false })
    expect(results[0]).toMatchObject({ status: 'sent', hash: expect.stringMatching(/^0x/), nonce: 0 })
  })

  it('dryRun 只预估、不广播', async () => {
    const { chain, multi } = setup()
    const results = await batchCall(multi, [{ from: KEY_A, to: R1, value: 1n }], { ...fast, dryRun: true })
    expect(results[0]).toMatchObject({ status: 'simulated', gasLimit: '21000', hash: null })
    expect(chain.broadcasts).toHaveLength(0)
  })

  it('私钥格式不对时报错，信息里不带私钥', async () => {
    const { multi } = setup()
    await expect(batchCall(multi, [{ from: '0x1234', to: R1 }])).rejects.toThrow('Invalid private key')
  })

  it("'7702'：委托后同一钱包的调用合成一笔交易，第二次不再带授权", async () => {
    const { chain, multi } = setup()
    const token = new Contract(TOKEN, ERC20_ABI)
    const results = await batchCall(
      multi,
      [
        { from: KEY_A, call: token.transfer(R1, 1n) },
        { from: KEY_A, call: token.transfer(R2, 2n) },
        { from: KEY_A, to: R3, value: 3n },
      ],
      { ...fast, mode: '7702' },
    )
    expect(results.map((r) => r.status)).toEqual(['confirmed', 'confirmed', 'confirmed'])
    expect(new Set(results.map((r) => r.hash)).size).toBe(1)
    expect(results.map((r) => r.to)).toEqual([TOKEN, TOKEN, R3])
    expect(chain.code(A)).toBe(`0xef0100${SIMPLE_7702_ACCOUNT.slice(2).toLowerCase()}`)
    expect(chain.broadcasts[0]?.type).toBe(4)
    expect(chain.tokenBalance(TOKEN, R2)).toBe(2n)
    expect(chain.native(R3)).toBe(3n)

    await batchCall(multi, [{ from: KEY_A, call: token.transfer(R1, 1n) }], { ...fast, mode: '7702' })
    expect(chain.broadcasts[1]?.authorizationList ?? []).toHaveLength(0)
    expect(chain.tokenBalance(TOKEN, R1)).toBe(2n)
  })

  it("'7702'：批次按 batchSize 拆分，只有第一笔带授权（确认后再发下一笔，nonce 按授权后的值）", async () => {
    const { chain, multi } = setup({ mineAfterPolls: 3 })
    const token = new Contract(TOKEN, ERC20_ABI)
    const results = await batchCall(
      multi,
      [1n, 2n, 3n].map((n) => ({ from: KEY_A, call: token.transfer(R1, n) })),
      { ...fast, mode: '7702', batchSize: 2 },
    )
    expect(results.map((r) => r.status)).toEqual(['confirmed', 'confirmed', 'confirmed'])
    expect(results[0]?.hash).toBe(results[1]?.hash)
    expect(results[2]?.hash).not.toBe(results[0]?.hash)
    // 第二笔等第一笔（带授权）确认后再发，已经委托好了，不再带授权
    expect(chain.broadcasts.map((tx) => tx.authorizationList?.length ?? 0)).toEqual([1, 0])
    expect(chain.broadcasts.map((tx) => tx.nonce)).toEqual([0, 2])
    expect(chain.tokenBalance(TOKEN, R1)).toBe(6n)
  })

  it("'7702'：预估时找出失败的那个调用，其他标记 skipped", async () => {
    const { chain, multi } = setup()
    const token = new Contract(TOKEN, ERC20_ABI)
    const results = await batchCall(
      multi,
      [
        { from: KEY_A, call: token.transfer(R1, 1n) },
        { from: KEY_A, call: token.transfer(R2, 10n ** 30n) },
      ],
      { ...fast, mode: '7702' },
    )
    expect(results[0]).toMatchObject({ status: 'skipped' })
    expect(results[1]).toMatchObject({ status: 'failed', error: expect.stringContaining('exceeds balance') })
    expect(chain.broadcasts).toHaveLength(0)
  })

  it("'7702'：已委托给其他合约时默认报错；revokeDelegation 撤销委托", async () => {
    const { chain, multi } = setup()
    const other = '0x7000000000000000000000000000000000000007'
    chain.state.code.set(other, '0x6080')
    await batchCall(multi, [{ from: KEY_A, to: R1, value: 1n }], { ...fast, mode: '7702', delegate: other })
    expect(chain.code(A)).toContain(other.slice(2))
    const [refused] = await batchCall(multi, [{ from: KEY_A, to: R1, value: 1n }], { ...fast, mode: '7702' })
    expect(refused).toMatchObject({ status: 'failed', error: expect.stringContaining('redelegate') })

    const revoked = await revokeDelegation(multi, KEY_A, fast)
    expect(revoked).toMatchObject({ status: 'confirmed' })
    expect(chain.code(A)).toBe('0x')
    expect(await revokeDelegation(multi, KEY_A, fast)).toBeNull()
  })
})

describe('batchTransfer', () => {
  it('默认走 Disperse：主币一笔、代币 approve 精确总额后一笔', async () => {
    const { chain, multi } = setup()
    const results = await batchTransfer(
      multi,
      KEY_A,
      [
        { to: R1, formatted: '1.5' },
        { to: R2, amount: ETH },
        { to: R1, token: TOKEN, formatted: '2.5' },
        { to: R2, token: TOKEN, amount: 1n },
      ],
      fast,
    )
    expect(results.map((r) => [r.status, r.via])).toEqual(Array(4).fill(['confirmed', 'disperse']))
    expect(results[0]).toMatchObject({ to: R1, native: true, amount: '1500000000000000000', formatted: '1.5' })
    expect(results[2]).toMatchObject({ token: TOKEN, amount: '2500000', formatted: '2.5' })
    expect(results[0]?.hash).toBe(results[1]?.hash)
    expect(results[2]?.hash).toBe(results[3]?.hash)
    expect(chain.native(R1)).toBe(1_500_000_000_000_000_000n)
    expect(chain.tokenBalance(TOKEN, R1)).toBe(2_500_000n)
    // 主币 disperse + approve + 代币 disperse
    expect(chain.broadcasts).toHaveLength(3)
    expect(chain.allowance(TOKEN, A, DISPERSE_ADDRESS)).toBe(0n)
  })

  it('已有部分额度时先归零再 approve（USDT 规则）', async () => {
    const { chain, multi } = setup()
    chain.state.tokens.get(TOKEN.toLowerCase())?.allowances.set(`${A.toLowerCase()}:${DISPERSE_ADDRESS.toLowerCase()}`, 1n)
    const results = await batchTransfer(multi, KEY_A, [{ to: R1, amount: 5n }, { to: R2, amount: 6n }], { ...fast, token: TOKEN })
    expect(results.map((r) => r.status)).toEqual(['confirmed', 'confirmed'])
    const approvals = chain.broadcasts.filter((tx) => tx.data.startsWith(erc20.getFunction('approve')!.selector))
    expect(approvals.map((tx) => erc20.decodeFunctionData('approve', tx.data)[1])).toEqual([0n, 11n])
  })

  it('链上没有 Disperse / 只有一个收款人时逐笔发送', async () => {
    const { chain, multi } = setup({ disperse: false })
    const results = await batchTransfer(multi, KEY_A, [{ to: R1, amount: 1n }, { to: R2, amount: 2n }], fast)
    expect(results.map((r) => r.via)).toEqual(['tx', 'tx'])
    expect(chain.native(R2)).toBe(2n)

    const single = setup()
    const [one] = await batchTransfer(single.multi, KEY_A, [{ to: R1, amount: 1n }], fast)
    expect(one).toMatchObject({ via: 'tx', status: 'confirmed' })
  })

  it('某一批预估 revert 时逐笔重发，只有出问题的收款项失败', async () => {
    const { chain, multi } = setup()
    chain.block(TOKEN, R2)
    const results = await batchTransfer(multi, KEY_A, [{ to: R1, amount: 1n }, { to: R2, amount: 2n }, { to: R3, amount: 3n }], { ...fast, token: TOKEN })
    expect(results.map((r) => [r.status, r.via])).toEqual([
      ['confirmed', 'tx'],
      ['failed', 'tx'],
      ['confirmed', 'tx'],
    ])
    expect(results[1]?.error).toContain('blocked recipient')
    expect(chain.tokenBalance(TOKEN, R3)).toBe(3n)
  })

  it('onUpdate 只报告真实的状态变化；approve 交易在 approvals 里', async () => {
    const { multi } = setup()
    const updates: string[] = []
    const results = await batchTransfer(
      multi,
      KEY_A,
      [
        { to: R1, amount: 1n },
        { to: R2, amount: 2n },
        { to: R3, amount: 3n, token: NATIVE_TOKEN },
      ],
      { ...fast, token: TOKEN, onUpdate: (r) => updates.push(r.status) },
    )
    expect(updates).not.toContain('skipped')
    expect(updates.filter((u) => u === 'confirmed')).toHaveLength(3)
    expect(results[0]?.approvals).toEqual([expect.objectContaining({ to: TOKEN, spender: DISPERSE_ADDRESS, amount: '3', status: 'confirmed' })])
    expect(results[1]?.approvals).toEqual(results[0]?.approvals)
    expect(results[2]?.approvals).toEqual([])
  })

  it('分几轮发送时 nonce 接上（节点的 pending nonce 还没算上刚发出的交易）', async () => {
    const { multi } = setup({ mineAfterPolls: 3, nonceIgnoresPending: true })
    const results = await batchTransfer(
      multi,
      KEY_A,
      [
        { to: R1, amount: 1n },
        { to: R2, amount: 2n },
        { to: R3, amount: 5n, token: TOKEN }, // 只有一个收款人：Disperse 之后单独一轮逐笔发送
      ],
      { ...fast, wait: false },
    )
    expect(results.map((r) => [r.via, r.status, r.nonce])).toEqual([
      ['disperse', 'sent', 0],
      ['disperse', 'sent', 0],
      ['tx', 'sent', 1],
    ])
  })

  it('余额不够时抛错，一笔都不发', async () => {
    const { chain, multi } = setup()
    await expect(batchTransfer(multi, KEY_A, [{ to: R1, formatted: '999' }, { to: R2, formatted: '2' }], { token: TOKEN })).rejects.toThrow('Insufficient balance')
    expect(chain.broadcasts).toHaveLength(0)
  })

  it('数量参数校验：amount / formatted 二选一，小数位不能超过精度', async () => {
    const { multi } = setup()
    await expect(batchTransfer(multi, KEY_A, [{ to: R1 }])).rejects.toThrow('exactly one of amount / formatted')
    await expect(batchTransfer(multi, KEY_A, [{ to: R1, formatted: '0.0000001' }], { token: TOKEN })).rejects.toThrow()
  })

  it("mode '7702'：一笔交易转给所有收款人", async () => {
    const { chain, multi } = setup()
    const results = await batchTransfer(multi, KEY_A, [{ to: R1, amount: 1n }, { to: R2, token: TOKEN, amount: 2n }], { ...fast, mode: '7702' })
    expect(results.map((r) => [r.status, r.via])).toEqual([
      ['confirmed', '7702'],
      ['confirmed', '7702'],
    ])
    expect(chain.broadcasts).toHaveLength(1)
    expect(chain.tokenBalance(TOKEN, R2)).toBe(2n)
  })
})

describe('batchCollect', () => {
  it('补 gas → 归集代币 → 扫空主币', async () => {
    const { chain, multi } = setup()
    chain.setNative(C, 10n ** 15n) // C 自己的主币够付代币归集的手续费
    const { results, topUps } = await batchCollect(multi, [KEY_B, KEY_C], HOT, { ...fast, tokens: [TOKEN, NATIVE_TOKEN], gasWallet: KEY_GAS })
    expect(topUps).toHaveLength(1)
    expect(topUps[0]).toMatchObject({ to: B, status: 'confirmed', via: 'tx' })
    expect(results.map((r) => [r.from, r.token, r.status])).toEqual([
      [B, TOKEN, 'confirmed'],
      [B, NATIVE_TOKEN, 'skipped'], // 补的 gas 刚好够用，剩下的零头不够付扫尾的手续费
      [C, TOKEN, 'confirmed'],
      [C, NATIVE_TOKEN, 'confirmed'],
    ])
    expect(results[1]?.error).toContain('does not cover the gas fee')
    expect(results[0]).toMatchObject({ amount: '5000000', formatted: '5', to: HOT })
    expect(chain.tokenBalance(TOKEN, HOT)).toBe(12_000_000n)
    expect(chain.tokenBalance(TOKEN, B)).toBe(0n)
    // 扫尾按最新余额精确扣掉手续费（假链的实际 gas 价格等于 maxFee）
    expect(chain.native(C)).toBe(0n)
    expect(chain.native(HOT)).toBe(BigInt(results[3]!.amount))
    expect(results[3]?.formatted).toBe('0.000858')
  })

  it('多个钱包需要补 gas 时用 Disperse 一笔补齐', async () => {
    const { chain, multi } = setup()
    const { results, topUps } = await batchCollect(multi, [KEY_B, KEY_C], HOT, { ...fast, tokens: [TOKEN], gasWallet: KEY_GAS })
    expect(topUps.map((t) => [t.to, t.via, t.status])).toEqual([
      [B, 'disperse', 'confirmed'],
      [C, 'disperse', 'confirmed'],
    ])
    expect(results.map((r) => r.status)).toEqual(['confirmed', 'confirmed'])
    expect(chain.tokenBalance(TOKEN, HOT)).toBe(12_000_000n)
  })

  it('没有 gasWallet 时主币不够的钱包失败，余额为 0 的跳过', async () => {
    const { chain, multi } = setup()
    chain.setNative(C, 10n ** 15n)
    const { results, topUps } = await batchCollect(multi, [KEY_B, KEY_C, KEY_GAS], HOT, { ...fast, tokens: [TOKEN] })
    expect(topUps).toEqual([])
    expect(results.map((r) => r.status)).toEqual(['failed', 'confirmed', 'skipped'])
    expect(results[0]?.error).toContain('gasWallet')
    expect(results[2]?.error).toContain('zero balance')
    expect(chain.tokenBalance(TOKEN, HOT)).toBe(7_000_000n)
  })

  it('补 gas 确认期间节点报价上涨：归集仍按补 gas 时的价格发送', async () => {
    const { chain, multi } = setup()
    let offset = 0
    const now = Date.now.bind(Date)
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => now() + offset)
    chain.hooks.afterMine = () => {
      // 补 gas 上链后：过了 60 秒（手续费缓存过期），报价翻倍
      chain.hooks.afterMine = undefined
      offset = 60_000
      chain.setFees(2n * GAS_PRICE, 2n * MAX_FEE)
    }
    try {
      const { results, topUps } = await batchCollect(multi, [KEY_B], HOT, { ...fast, tokens: [TOKEN], gasWallet: KEY_GAS })
      expect(topUps[0]?.status).toBe('confirmed')
      expect(results[0]?.status).toBe('confirmed')
      expect(chain.tokenBalance(TOKEN, HOT)).toBe(5_000_000n)
    } finally {
      spy.mockRestore()
    }
  })

  it('代币没有归集成功的钱包不扫主币', async () => {
    const { chain, multi } = setup()
    chain.setNative(C, 10n ** 15n)
    chain.block(TOKEN, HOT)
    const { results } = await batchCollect(multi, [KEY_C], HOT, { ...fast, tokens: [TOKEN, NATIVE_TOKEN] })
    expect(results.map((r) => r.status)).toEqual(['failed', 'skipped'])
    expect(results[1]?.error).toContain('did not succeed')
    expect(chain.native(C)).toBe(10n ** 15n)
  })

  it('预估时没有主币、按兜底 gasLimit 补 gas 的项，补完后重新预估', async () => {
    const { chain, multi } = setup({ estimateNeedsGas: true })
    const { results } = await batchCollect(multi, [KEY_B], HOT, { ...fast, tokens: [TOKEN], gasWallet: KEY_GAS })
    expect(results[0]).toMatchObject({ status: 'confirmed', gasLimit: '60000' })

    // 实际需要的 gas 超过兜底值：发送前就失败，不会上链 out of gas 白付手续费
    chain.setTransferGas(TOKEN, 150_000)
    chain.addToken(TOKEN, 'TKN', 6, { [C]: 7_000_000n })
    const second = await batchCollect(multi, [KEY_C], HOT, { ...fast, tokens: [TOKEN], gasWallet: KEY_GAS })
    expect(second.topUps[0]?.status).toBe('confirmed')
    expect(second.results[0]?.status).toBe('failed')
    expect(second.results[0]?.error).toMatch(/insufficient/)
    expect(chain.native(C)).toBe(BigInt(second.topUps[0]!.amount)) // 补的 gas 一点没花
  })

  it('dryRun 返回计划，不发交易', async () => {
    const { chain, multi } = setup()
    const { results, topUps } = await batchCollect(multi, [KEY_B, KEY_C], HOT, { ...fast, tokens: [TOKEN], gasWallet: KEY_GAS, dryRun: true })
    expect(results.map((r) => r.status)).toEqual(['simulated', 'simulated'])
    expect(topUps.map((t) => t.status)).toEqual(['simulated', 'simulated'])
    expect(chain.broadcasts).toHaveLength(0)
  })
})

describe('EVM review 回归', () => {
  it('节点 A 收下交易后超时、节点 B 报 nonce too low、回执一时查不到：多查几次，不换 nonce 重发', async () => {
    const { chain } = setup({ receiptLag: 2 })
    // A 收下并出块，但返回超时；B 是正常节点（已上链的交易再发报 nonce too low）
    let timeouts = 1
    const nodeA = {
      ...chain.node,
      async broadcastTransaction(signed: string) {
        const result = await chain.node.broadcastTransaction(signed)
        if (timeouts-- > 0) throw makeError('request timeout', 'TIMEOUT', { operation: 'broadcastTransaction', reason: 'timeout' })
        return result
      },
    }
    const multi = new Provider(CHAIN_ID, [nodeA, chain.node] as never, { nativeBalance: 'rpc' })
    const [result] = await batchCall(multi, [{ from: KEY_A, to: R1, value: 5n }], fast)
    expect(result).toMatchObject({ status: 'confirmed', nonce: 0 })
    expect(chain.native(R1)).toBe(5n) // 只转了一次
    expect(new Set(chain.broadcasts.map((t) => t.nonce))).toEqual(new Set([0]))
  })

  it('节点明确拒绝（错误信息不在已知列表里）：报 failed，nonce 不被占住', async () => {
    const { chain, multi } = setup({ rejectBroadcast: 'tx fee (2.00 ether) exceeds the configured cap (1.00 ether)' })
    const results = await batchCall(
      multi,
      [
        { from: KEY_A, to: R1, value: 1n },
        { from: KEY_A, to: R2, value: 2n },
      ],
      { ...fast, continueOnError: true },
    )
    expect(results.map((r) => r.status)).toEqual(['failed', 'failed'])
    expect(results[0]?.error).toContain('exceeds the configured cap')
    expect(chain.native(R1)).toBe(0n)
  })

  it("'7702'：委托合约在这条链上没有部署时直接失败（否则调用会“成功”但什么都不执行）", async () => {
    const { chain, multi } = setup({ simple7702: false })
    const [result] = await batchCall(multi, [{ from: KEY_A, to: R1, value: 5n }], { ...fast, mode: '7702' })
    expect(result?.status).toBe('failed')
    expect(result?.error).toContain('not deployed')
    expect(chain.broadcasts).toHaveLength(0)
    expect(chain.code(A)).toBe('0x')
  })

  it("'7702'：钱包还有未确认的交易时不发授权交易（预估会不准）", async () => {
    const { chain, multi } = setup({ mineAfterPolls: 50 })
    await batchCall(multi, [{ from: KEY_A, to: R1, value: 1n }], { ...fast, wait: false })
    const [result] = await batchCall(multi, [{ from: KEY_A, to: R2, value: 1n }], { ...fast, mode: '7702' })
    expect(result?.status).toBe('failed')
    expect(result?.error).toContain('unconfirmed transactions')
    expect(chain.broadcasts).toHaveLength(1)
  })

  it("'7702'：带授权的交易等到超时还没确认，同一钱包后面的批次跳过", async () => {
    const { multi } = setup({ mineAfterPolls: 10_000 })
    const results = await batchCall(
      multi,
      [
        { from: KEY_A, to: R1, value: 1n },
        { from: KEY_A, to: R2, value: 1n },
      ],
      { ...fast, timeout: 50, mode: '7702', batchSize: 1 },
    )
    expect(results.map((r) => r.status)).toEqual(['pending', 'skipped'])
    expect(results[1]?.error).toContain('delegation transaction is not confirmed')
  })

  it('浏览器钱包在别的链上：不发送；同一条链时交易带上 chainId', async () => {
    const { chain, multi } = setup()
    const wallet = new Wallet(KEY_A)
    const requests: Array<Record<string, unknown>> = []
    const browser = (chainId: string) => ({
      provider: { send: async () => chainId },
      getAddress: async () => A,
      sendTransaction: async (tx: Record<string, unknown>) => {
        requests.push(tx)
        const nonce = await chain.node.getTransactionCount(A)
        const signed = await wallet.signTransaction({ ...tx, nonce, chainId: CHAIN_ID, gasPrice: 2_000_000_000n, type: 0 })
        return chain.node.broadcastTransaction(signed)
      },
    })
    const [wrong] = await batchCall(multi, [{ from: browser('0x1'), to: R1, value: 5n }], fast)
    expect(wrong?.status).toBe('failed')
    expect(wrong?.error).toContain('chain 1')
    expect(requests).toHaveLength(0)
    const [right] = await batchCall(multi, [{ from: browser(`0x${CHAIN_ID.toString(16)}`), to: R1, value: 5n }], fast)
    expect(right?.status).toBe('confirmed')
    expect(requests[0]?.chainId).toBe(CHAIN_ID)
  })

  it('浏览器钱包已经广播、之后 ethers 查询出错（带 sendTransactionHash）：按已发出跟踪，不报 failed', async () => {
    const { chain, multi } = setup()
    const wallet = new Wallet(KEY_A)
    const browser = {
      getAddress: async () => A,
      sendTransaction: async (tx: Record<string, unknown>) => {
        const signed = await wallet.signTransaction({ ...tx, nonce: 0, chainId: CHAIN_ID, gasPrice: 2_000_000_000n, type: 0 })
        const { hash } = await chain.node.broadcastTransaction(signed)
        throw makeError('network changed', 'NETWORK_ERROR', { event: 'changed', info: { sendTransactionHash: hash } } as never)
      },
    }
    const [result] = await batchCall(multi, [{ from: browser, to: R1, value: 5n }], fast)
    expect(result?.status).toBe('confirmed')
    expect(chain.native(R1)).toBe(5n)
  })

  it('onUpdate 回调抛错不会打断发送', async () => {
    const { chain, multi } = setup()
    const results = await batchCall(
      multi,
      [
        { from: KEY_A, to: R1, value: 1n },
        { from: KEY_A, to: R2, value: 2n },
      ],
      {
        ...fast,
        onUpdate: () => {
          throw new Error('ui bug')
        },
      },
    )
    expect(results.map((r) => r.status)).toEqual(['confirmed', 'confirmed'])
    expect(chain.native(R2)).toBe(2n)
  })
})
