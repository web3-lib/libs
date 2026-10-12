import { Interface, Wallet, makeError } from 'ethers'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { resetMulticallCache } from '../src/aggregate.js'
import { resetDecimalsCache } from '../src/erc20.js'
import { resetNodeHealth } from '../src/fallback.js'
import { Contract, ERC20_ABI, NATIVE_TOKEN, Provider, TronProvider } from '../src/index.js'
import { SIMPLE_7702_ACCOUNT, batchCall, batchCollect, batchTransfer, revokeDelegation, type CollectItemResult } from '../src/subpaths/write.js'
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
const NO_TOKEN = '0x1000000000000000000000000000000000000009'
const OTHER = '0x7000000000000000000000000000000000000007'
const R1 = '0x5000000000000000000000000000000000000001'
const R2 = '0x5000000000000000000000000000000000000002'
const HOT = '0x6000000000000000000000000000000000000006'
const ETH = 10n ** 18n
const fast = { pollInterval: 1, timeout: 5_000 }
const accountInterface = new Interface(['error ExecuteError(uint256 index, bytes reason)', 'error Error(string)'])

function setup(options: FakeChainOptions = {}) {
  const chain = createFakeChain(options)
  chain.addToken(TOKEN, 'TKN', 6, { [A]: 1_000_000_000n, [B]: 5_000_000n, [C]: 7_000_000n })
  chain.setNative(A, 10n * ETH)
  chain.setNative(GAS, 10n * ETH)
  const multi = new Provider(CHAIN_ID, chain.node as never, { nativeBalance: 'rpc' })
  return { chain, multi }
}

/** 只能让钱包发送的签名器（像浏览器钱包），sendTransaction 的行为可以替换 */
function sendOnly(address: string, send: (tx: Record<string, unknown>) => Promise<{ hash: string }>, provider?: unknown) {
  return { getAddress: async () => address, sendTransaction: send, provider }
}

afterEach(() => vi.restoreAllMocks())

beforeEach(() => {
  resetNodeHealth()
  resetMulticallCache()
  resetDecimalsCache()
  resetDisperseCache()
  resetL1OracleCache()
})

describe('batchCall 参数与 7702 的各种情况', () => {
  it('调用既没有 to 也没有 call 时报错', async () => {
    const { multi } = setup()
    await expect(batchCall(multi, [{ from: KEY_A } as never], fast)).rejects.toThrow('either to or call is required')
  })

  it('合约账户不能用 7702；只能发送的钱包、不能签授权的签名器也不行', async () => {
    const { chain, multi } = setup()
    // A 是合约账户：只有 A 的调用失败，不影响其他钱包
    chain.state.code.set(A.toLowerCase(), '0x6080')
    chain.setNative(B, ETH)
    const results = await batchCall(
      multi,
      [
        { from: KEY_B, to: R1, value: 1n },
        { from: KEY_A, to: R1, value: 1n },
      ],
      { ...fast, mode: '7702' },
    )
    expect(results[0]?.status).toBe('confirmed')
    expect(results[1]?.error).toContain('is a contract, not an EOA')

    const browser = sendOnly(B, async () => ({ hash: '0x' }))
    const [sendOnlyResult] = await batchCall(multi, [{ from: browser, to: R1, value: 1n }], { ...fast, mode: '7702' })
    expect(sendOnlyResult?.error).toContain('requires a signer that can sign locally')

    const wallet = new Wallet(KEY_C)
    chain.setNative(C, ETH)
    const noAuthorize = { getAddress: async () => C, signTransaction: (tx: never) => wallet.signTransaction(tx) }
    const [noAuth] = await batchCall(multi, [{ from: noAuthorize, to: R1, value: 1n }], { ...fast, mode: '7702' })
    expect(noAuth?.error).toContain('sign EIP-7702 authorizations')
  })

  it('redelegate: true 时改为委托给新的合约', async () => {
    const { chain, multi } = setup()
    chain.state.code.set(OTHER.toLowerCase(), '0x6080')
    chain.state.code.set(A.toLowerCase(), `0xef0100${OTHER.slice(2).toLowerCase()}`)
    const [result] = await batchCall(multi, [{ from: KEY_A, to: R1, value: 5n }], { ...fast, mode: '7702', redelegate: true })
    expect(result?.status).toBe('confirmed')
    expect(chain.code(A)).toBe(`0xef0100${SIMPLE_7702_ACCOUNT.slice(2).toLowerCase()}`)
    expect(chain.native(R1)).toBe(5n)
  })

  it('7702 只有一个调用时 revert 原因直接透传', async () => {
    const { multi } = setup()
    const token = new Contract(TOKEN, ERC20_ABI)
    const [result] = await batchCall(multi, [{ from: KEY_A, call: token.transfer(R1, 10n ** 18n) }], { ...fast, mode: '7702' })
    expect(result).toMatchObject({ status: 'failed', error: 'execution reverted: ERC20: transfer amount exceeds balance' })
  })

  it('7702 的 revert 数据不是 ExecuteError、解析不了、下标越界时：整笔的调用都失败', async () => {
    const cases = [
      accountInterface.encodeErrorResult('Error', ['nope']),
      `${accountInterface.getError('ExecuteError')!.selector}1234`,
      accountInterface.encodeErrorResult('ExecuteError', [5, '0x']),
    ]
    for (const batchRevertData of cases) {
      const { multi } = setup({ batchRevertData })
      const results = await batchCall(
        multi,
        [
          { from: KEY_A, to: R1, value: 1n },
          { from: KEY_A, to: R2, value: 1n },
        ],
        { ...fast, mode: '7702' },
      )
      expect(results.map((r) => r.status)).toEqual(['failed', 'failed'])
    }
  })

  it('revokeDelegation：只能发送的钱包不能撤销', async () => {
    const { chain, multi } = setup()
    chain.state.code.set(A.toLowerCase(), `0xef0100${SIMPLE_7702_ACCOUNT.slice(2).toLowerCase()}`)
    const result = await revokeDelegation(multi, sendOnly(A, async () => ({ hash: '0x' })), fast)
    expect(result?.status).toBe('failed')
    expect(result?.error).toContain('revokeDelegation requires a signer that can sign locally')
  })
})

describe('签名器', () => {
  it('不是签名器、没有 signTransaction / sendTransaction 时报错', async () => {
    const { multi } = setup()
    await expect(batchCall(multi, [{ from: {} as never, to: R1, value: 1n }], fast)).rejects.toThrow('Invalid signer')
    await expect(batchCall(multi, [{ from: { getAddress: async () => A } as never, to: R1, value: 1n }], fast)).rejects.toThrow('signTransaction or sendTransaction')
  })

  it('用户在钱包里拒绝：rejected by user；问不到钱包的链时照常发送（靠交易里的 chainId 校验）', async () => {
    const { chain, multi } = setup()
    const rejecting = sendOnly(A, async () => {
      throw makeError('user rejected action', 'ACTION_REJECTED', { action: 'sendTransaction', reason: 'rejected' } as never)
    })
    const [rejected] = await batchCall(multi, [{ from: rejecting, to: R1, value: 1n }], fast)
    expect(rejected).toMatchObject({ status: 'failed', error: 'rejected by user' })

    const wallet = new Wallet(KEY_A)
    const unknownChain = sendOnly(
      A,
      async (tx) => chain.node.broadcastTransaction(await wallet.signTransaction({ ...tx, nonce: 0, gasPrice: GAS_PRICE, type: 0 } as never)),
      { send: async () => Promise.reject(new Error('method not supported')) },
    )
    const [sent] = await batchCall(multi, [{ from: unknownChain, to: R1, value: 3n }], fast)
    expect(sent?.status).toBe('confirmed')
  })
})

describe('手续费', () => {
  it('指定 gasPrice：legacy 交易', async () => {
    const { chain, multi } = setup()
    const [result] = await batchCall(multi, [{ from: KEY_A, to: R1, value: 1n }], { ...fast, gasPrice: 3n * GAS_PRICE })
    expect(result?.status).toBe('confirmed')
    expect(chain.broadcasts[0]).toMatchObject({ type: 0, gasPrice: 3n * GAS_PRICE })
  })

  it('节点没有 EIP-1559 字段时用 legacy；什么价格都没有时报错', async () => {
    const legacy = setup({ feeData: { gasPrice: GAS_PRICE, maxFeePerGas: null, maxPriorityFeePerGas: null } })
    const [ok] = await batchCall(legacy.multi, [{ from: KEY_A, to: R1, value: 1n }], fast)
    expect(ok?.status).toBe('confirmed')
    expect(legacy.chain.broadcasts[0]?.type).toBe(0)

    const none = setup({ feeData: { gasPrice: null, maxFeePerGas: null, maxPriorityFeePerGas: null } })
    const [bad] = await batchCall(none.multi, [{ from: KEY_A, to: R1, value: 1n }], fast)
    expect(bad?.error).toContain('Unable to get gas price')
  })

  it('只指定 maxFeePerGas 且低于节点的 priority fee 时，抬到 priority fee', async () => {
    const { chain, multi } = setup()
    const [result] = await batchCall(multi, [{ from: KEY_A, to: R1, value: 1n }], { ...fast, maxFeePerGas: 1n })
    expect(result?.status).toBe('confirmed')
    expect(chain.broadcasts[0]).toMatchObject({ maxFeePerGas: GAS_PRICE, maxPriorityFeePerGas: GAS_PRICE })
  })

  it('7702 交易在 legacy 费用下：maxFee / priority 都用 gasPrice', async () => {
    const { chain, multi } = setup()
    const [result] = await batchCall(multi, [{ from: KEY_A, to: R1, value: 1n }], { ...fast, mode: '7702', gasPrice: 2n * GAS_PRICE })
    expect(result?.status).toBe('confirmed')
    expect(chain.broadcasts[0]).toMatchObject({ type: 4, maxFeePerGas: 2n * GAS_PRICE, maxPriorityFeePerGas: 2n * GAS_PRICE })
  })

  it('读手续费失败：这笔失败，下一笔重新读', async () => {
    const { multi } = setup({ feeErrors: 1 })
    const results = await batchCall(
      multi,
      [
        { from: KEY_A, to: R1, value: 1n },
        { from: KEY_A, to: R2, value: 1n },
      ],
      { ...fast, continueOnError: true },
    )
    expect(results.map((r) => r.status)).toEqual(['failed', 'confirmed'])
  })

  it('节点不支持某个方法时给出明确的错误', async () => {
    const { chain } = setup()
    const { getFeeData: _omit, ...partial } = chain.node
    const multi = new Provider(CHAIN_ID, partial as never, { nativeBalance: 'rpc' })
    const [result] = await batchCall(multi, [{ from: KEY_A, to: R1, value: 1n }], fast)
    expect(result?.error).toContain('getFeeData is not supported by this node')
  })

  it('配给 EVM 链的 Tron 节点：写操作报不支持', async () => {
    const multi = new Provider(CHAIN_ID, new TronProvider({ request: async () => ({}) }))
    const [result] = await batchCall(multi, [{ from: KEY_A, to: R1, value: 1n }], fast)
    expect(result?.error).toContain('not supported on Tron')
  })
})

describe('nonce 与广播', () => {
  it('节点给的 nonce 落后（被别的交易占用）、确认不是这笔：换新 nonce 重发', async () => {
    const { chain, multi } = setup({ staleNonce: { by: 1 } })
    chain.state.nonces.set(A.toLowerCase(), 1) // nonce 0 已被钱包在别处发的交易用掉
    const [result] = await batchCall(multi, [{ from: KEY_A, to: R1, value: 5n }], fast)
    expect(result).toMatchObject({ status: 'confirmed', nonce: 1 })
    expect(chain.native(R1)).toBe(5n)
    expect(chain.broadcasts.map((t) => t.nonce)).toEqual([0, 1]) // 先用落后的 nonce 0 被拒，确认不是这笔后换 1
  })

  it('换了 nonce 重发仍然被占用：失败，不再重试', async () => {
    const { chain, multi } = setup({ staleNonce: { by: 2, times: 2 } })
    chain.state.nonces.set(A.toLowerCase(), 2)
    const [result] = await batchCall(multi, [{ from: KEY_A, to: R1, value: 5n }], fast)
    expect(result).toMatchObject({ status: 'failed', error: 'nonce already used by another transaction' })
    expect(chain.native(R1)).toBe(0n)
    expect(chain.broadcasts.map((t) => t.nonce)).toEqual([0, 1])
  })

  it('确认 nonce 被占用期间取消：不换 nonce 重发（不再发新交易），按不确定的 sent 返回', async () => {
    const { chain } = setup({ staleNonce: { by: 1 } })
    chain.state.nonces.set(A.toLowerCase(), 1)
    const controller = new AbortController()
    const node = {
      ...chain.node,
      async broadcastTransaction(signed: string) {
        try {
          return await chain.node.broadcastTransaction(signed)
        } catch (err) {
          controller.abort() // 节点说 nonce 已被用掉的同时取消
          throw err
        }
      },
    }
    const multi = new Provider(CHAIN_ID, node as never, { nativeBalance: 'rpc' })
    const [result] = await batchCall(multi, [{ from: KEY_A, to: R1, value: 5n }], { ...fast, pollInterval: 60_000, signal: controller.signal })
    expect(result?.status).toBe('sent')
    expect(result?.error).toContain('unable to confirm whether this transaction was mined')
    expect(chain.broadcasts).toHaveLength(1)
    expect(chain.native(R1)).toBe(0n)
  })

  it('nonce too low 后查回执出错：不确定，不重发，按已发出跟踪', async () => {
    const { chain } = setup({ receiptErrors: 20 })
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
    const updates: Array<string | null> = []
    const [result] = await batchCall(multi, [{ from: KEY_A, to: R1, value: 5n }], { ...fast, onUpdate: (r) => updates.push(r.error) })
    expect(result).toMatchObject({ status: 'confirmed', nonce: 0 })
    expect(updates[0]).toContain('unable to confirm whether this transaction was mined')
    expect(chain.native(R1)).toBe(5n)
  })

  it('等待确认时查回执出错：下一轮再查', async () => {
    const { multi } = setup({ receiptErrors: 2, mineAfterPolls: 1 })
    const [result] = await batchCall(multi, [{ from: KEY_A, to: R1, value: 1n }], fast)
    expect(result?.status).toBe('confirmed')
  })
})

describe('取消', () => {
  it('等待确认时取消：保持 sent', async () => {
    const { multi } = setup({ mineAfterPolls: 10_000 })
    const controller = new AbortController()
    const [result] = await batchCall(multi, [{ from: KEY_A, to: R1, value: 1n }], {
      ...fast,
      pollInterval: 20,
      signal: controller.signal,
      onUpdate: (r) => r.status === 'sent' && setTimeout(() => controller.abort(), 30),
    })
    expect(result?.status).toBe('sent')
  })

  it('等前一笔确认（依赖）时取消：后面的标记 skipped', async () => {
    const { multi } = setup({ mineAfterPolls: 10_000 })
    const controller = new AbortController()
    const token = new Contract(TOKEN, ERC20_ABI)
    const results = await batchCall(
      multi,
      [
        { from: KEY_A, call: token.approve(A, 300n) },
        { from: KEY_A, call: token.transferFrom(A, R1, 300n) }, // 依赖上一笔的 approve
      ],
      { ...fast, pollInterval: 20, signal: controller.signal, onUpdate: (r) => r.status === 'sent' && setTimeout(() => controller.abort(), 30) },
    )
    expect(results.map((r) => r.status)).toEqual(['sent', 'skipped'])
    expect(results[1]?.error).toBe('aborted')
  })
})

describe('batchTransfer 参数与模式', () => {
  it('代币读不到时 formatted / checkBalance 报错；数量不能为负', async () => {
    const { multi } = setup()
    await expect(batchTransfer(multi, KEY_A, [{ to: R1, formatted: '1', token: NO_TOKEN }], fast)).rejects.toThrow('cannot read decimals')
    await expect(batchTransfer(multi, KEY_A, [{ to: R1, amount: 1n, token: NO_TOKEN }], fast)).rejects.toThrow('Cannot read the balance')
    await expect(batchTransfer(multi, KEY_A, [{ to: R1, amount: -1n }], fast)).rejects.toThrow('must not be negative')
  })

  it("mode 'tx'：每个收款人一笔", async () => {
    const { chain, multi } = setup()
    const results = await batchTransfer(
      multi,
      KEY_A,
      [
        { to: R1, amount: 1n },
        { to: R2, amount: 2n },
      ],
      { ...fast, mode: 'tx' },
    )
    expect(results.map((r) => [r.status, r.via])).toEqual([
      ['confirmed', 'tx'],
      ['confirmed', 'tx'],
    ])
    expect(new Set(results.map((r) => r.hash)).size).toBe(2)
    expect(chain.native(R2)).toBe(2n)
  })

  it('dryRun 且 Disperse 额度不够：只预估 approve，分发批次标记 simulated', async () => {
    const { chain, multi } = setup()
    const results = await batchTransfer(
      multi,
      KEY_A,
      [
        { to: R1, amount: 1n },
        { to: R2, amount: 2n },
      ],
      { ...fast, token: TOKEN, dryRun: true },
    )
    expect(results.map((r) => r.status)).toEqual(['simulated', 'simulated'])
    expect(results[0]?.approvals).toEqual([expect.objectContaining({ status: 'simulated', amount: '3' })])
    expect(chain.broadcasts).toHaveLength(0)
  })
})

describe('batchCollect 跳过与失败', () => {
  it('读不到余额、钱包就是归集地址、重复钱包、低于 minAmount', async () => {
    const { multi } = setup()
    const { results } = await batchCollect(multi, [KEY_A, KEY_B, KEY_B, KEY_C], A, { ...fast, tokens: [NO_TOKEN, TOKEN], minAmount: { [TOKEN]: 6_000_000n }, gasWallet: KEY_GAS })
    expect(results.map((r) => r.error)).toEqual([
      'cannot read balance: no-contract',
      'skipped: wallet is the collect address',
      'cannot read balance: no-contract',
      'skipped: below minAmount',
      'cannot read balance: no-contract',
      'skipped: duplicate wallet',
      'cannot read balance: no-contract',
      null,
    ])
  })

  it('主币余额读不到（success: false）：不补 gas，这个钱包的代币项失败', async () => {
    const { chain, multi } = setup()
    const real = multi.multiBalances.bind(multi)
    vi.spyOn(multi, 'multiBalances').mockImplementation((async (queries: never, options: never) => {
      const result = await real(queries, options)
      result.forEach((list) => list.forEach((b) => b.native && Object.assign(b, { success: false, error: 'reverted', balance: '0' })))
      return result
    }) as never)
    const { results, topUps } = await batchCollect(multi, [KEY_B], HOT, { ...fast, tokens: [TOKEN], gasWallet: KEY_GAS })
    expect(topUps).toEqual([])
    expect(results[0]?.status).toBe('failed')
    expect(chain.broadcasts).toHaveLength(0)
  })

  it('补 gas 失败：这些钱包的代币项失败', async () => {
    const { multi } = setup()
    const rejecting = sendOnly(GAS, async () => {
      throw makeError('user rejected action', 'ACTION_REJECTED', { action: 'sendTransaction', reason: 'rejected' } as never)
    })
    const { results, topUps } = await batchCollect(multi, [KEY_B], HOT, { ...fast, tokens: [TOKEN], gasWallet: rejecting })
    expect(topUps[0]?.status).toBe('failed')
    expect(results[0]?.error).toBe('gas top-up failed: rejected by user')
  })

  it('dryRun 包含主币时，扫主币的项也标记 simulated', async () => {
    const { chain, multi } = setup()
    chain.setNative(C, ETH)
    const { results } = await batchCollect(multi, [KEY_C], HOT, { ...fast, tokens: [TOKEN, NATIVE_TOKEN], dryRun: true })
    expect(results.map((r) => r.status)).toEqual(['simulated', 'simulated'])
  })

  it('代币归集后读主币余额抛错：扫主币的项失败，代币的结果照常返回', async () => {
    const { chain, multi } = setup()
    chain.setNative(C, ETH)
    vi.spyOn(multi, 'balances').mockRejectedValue(new Error('node down'))
    const { results } = await batchCollect(multi, [KEY_C], HOT, { ...fast, tokens: [TOKEN, NATIVE_TOKEN] })
    expect(results[0]?.status).toBe('confirmed')
    expect(results[1]).toMatchObject({ status: 'failed', error: 'cannot read balance: node down' })
  })

  it('代币归集后读手续费失败：扫主币的项失败，代币的结果照常返回', async () => {
    const { chain, multi } = setup()
    chain.setNative(C, ETH)
    const { results } = await batchCollect(multi, [KEY_C], HOT, {
      ...fast,
      tokens: [TOKEN, NATIVE_TOKEN],
      onUpdate: (r) => r.status === 'confirmed' && !(r as CollectItemResult).native && chain.failFees(1),
    })
    expect(results[0]?.status).toBe('confirmed')
    expect(results[1]?.status).toBe('failed')
    expect(results[1]?.error).toContain('cannot get the fee data')
  })

  it('扫主币时读到的余额是 success: false：这一项失败', async () => {
    const { chain, multi } = setup()
    chain.setNative(C, ETH)
    const real = multi.balances.bind(multi)
    vi.spyOn(multi, 'balances').mockImplementation((async (owner: never, tokens: never, options: never) => {
      const result = await real(owner, tokens, options)
      return result.map((b) => ({ ...b, success: false, error: 'reverted' }))
    }) as never)
    const { results } = await batchCollect(multi, [KEY_C], HOT, { ...fast, tokens: [NATIVE_TOKEN] })
    expect(results[0]).toMatchObject({ status: 'failed', error: 'cannot read balance: reverted' })
  })

  it('扫主币时归集地址拒收主币（预估 revert）：不发送，失败', async () => {
    const { chain, multi } = setup({ rejectNative: new Set([HOT.toLowerCase()]) })
    chain.setNative(C, ETH)
    const { results } = await batchCollect(multi, [KEY_C], HOT, { ...fast, tokens: [NATIVE_TOKEN] })
    expect(results[0]?.status).toBe('failed')
    expect(results[0]?.error).toContain('cannot receive the native coin')
    expect(chain.broadcasts).toHaveLength(0)
    expect(chain.native(C)).toBe(ETH)
  })

  it('扫主币时预估 gas 暂时出错：按普通转账的 21000 发送', async () => {
    const { chain, multi } = setup({ estimateErrors: 1 })
    chain.setNative(C, ETH)
    const { results } = await batchCollect(multi, [KEY_C], HOT, { ...fast, tokens: [NATIVE_TOKEN] })
    expect(results[0]).toMatchObject({ status: 'confirmed', gasLimit: '21000' })
    expect(chain.native(C)).toBe(0n)
  })

  it('OP Stack 链上扫主币时预留 L1 数据费（× 1.25）', async () => {
    const l1Fee = 4_000_000_000n
    const { chain, multi } = setup({ l1Fee })
    chain.setNative(C, ETH)
    const { results } = await batchCollect(multi, [KEY_C], HOT, { ...fast, tokens: [NATIVE_TOKEN] })
    expect(results[0]?.status).toBe('confirmed')
    // 扫尾按 21000 × maxFee + L1 费 × 1.25 预留；实际扣 21000 × maxFee + L1 费，剩下 L1 费的 25%
    expect(chain.native(C)).toBe(l1Fee / 4n)
    expect(BigInt(results[0]!.amount)).toBe(ETH - 21_000n * MAX_FEE - (l1Fee * 125n) / 100n)
  })

  it('L1 预言机读不到 / 调用失败时按 0 处理，不阻塞', async () => {
    for (const options of [{ l1OracleCodeError: true }, { l1OracleCallError: true }]) {
      resetL1OracleCache()
      const { chain, multi } = setup({ l1Fee: 0n, ...options })
      chain.setNative(C, ETH)
      const { results } = await batchCollect(multi, [KEY_C], HOT, { ...fast, tokens: [NATIVE_TOKEN] })
      expect(results[0]?.status).toBe('confirmed')
    }
  })
})
