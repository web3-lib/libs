import { AbiCoder, Interface, id, toBeHex, zeroPadValue } from 'ethers'
import { describe, expect, it } from 'vitest'

import type { Provider } from '../src/index.js'
import { assertSimulation, decodeCalldata, decodeRevert, simulate, simulateBatch } from '../src/subpaths/simulate.js'

const A = '0x1111111111111111111111111111111111111111'
const B = '0x2222222222222222222222222222222222222222'
const TOKEN = '0x3333333333333333333333333333333333333333'
const WETH = '0x4444444444444444444444444444444444444444'
const ROUTER = '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45' // Uniswap SwapRouter02（以太坊，内置表里有）
const topic = (a: string) => zeroPadValue(a, 32)
const word = (n: bigint) => toBeHex(n, 32)

const erc20 = new Interface(['function transfer(address to, uint256 amount)', 'function approve(address spender, uint256 amount)'])
const v3 = new Interface(['function multicall(uint256 deadline, bytes[] data)', 'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params)', 'function unwrapWETH9(uint256 amountMinimum, address recipient)'])
const ur = new Interface(['function execute(bytes commands, bytes[] inputs, uint256 deadline)'])
const m3 = new Interface(['function aggregate3((address target, bool allowFailure, bytes callData)[] calls)'])
const permit2 = new Interface(['function approve(address token, address spender, uint160 amount, uint48 expiration)'])

describe('calldata 解码', () => {
  it('ERC20 / Permit2 / 未知', () => {
    expect(decodeCalldata(erc20.encodeFunctionData('transfer', [A, 5n]))).toMatchObject({ type: 'transfer', method: 'transfer', args: { to: A, amount: '5' } })
    expect(decodeCalldata(erc20.encodeFunctionData('approve', [A, 5n]))).toMatchObject({ type: 'approve' })
    expect(decodeCalldata(permit2.encodeFunctionData('approve', [TOKEN, A, 5n, 0n]))).toMatchObject({ type: 'approve', protocol: 'Permit2' })
    expect(decodeCalldata('0xdeadbeef00')).toMatchObject({ type: 'unknown', args: { selector: '0xdeadbeef' } })
    expect(decodeCalldata('0x', { to: A, value: 1n })).toMatchObject({ type: 'transfer' })
  })

  it('SwapRouter02 multicall 带子调用，协议名来自内置表', () => {
    const swap = v3.encodeFunctionData('exactInputSingle', [{ tokenIn: A, tokenOut: B, fee: 500, recipient: A, amountIn: 1n, amountOutMinimum: 0n, sqrtPriceLimitX96: 0n }])
    const data = v3.encodeFunctionData('multicall', [123n, [swap, v3.encodeFunctionData('unwrapWETH9', [0n, A])]])
    const d = decodeCalldata(data, { to: ROUTER, chainId: 1 })
    expect(d).toMatchObject({ type: 'swap', protocol: 'Uniswap SwapRouter02', method: 'multicall' })
    expect(d.calls?.map((c) => c.method)).toEqual(['exactInputSingle', 'unwrapWETH9'])
    expect(d.summary).toContain('exactInputSingle + unwrapWETH9')
  })

  it('Universal Router 命令、Multicall3', () => {
    const d = decodeCalldata(ur.encodeFunctionData('execute', ['0x0a0c', ['0x', '0x'], 1n]))
    // 0a 是 PERMIT2_PERMIT，0c 是 UNWRAP_WETH；没有 swap 命令时按优先级取 approve
    expect(d).toMatchObject({ type: 'approve', protocol: 'Universal Router' })
    expect(decodeCalldata(ur.encodeFunctionData('execute', ['0x0a080c', ['0x', '0x', '0x'], 1n])).type).toBe('swap')
    const multi = decodeCalldata(m3.encodeFunctionData('aggregate3', [[{ target: TOKEN, allowFailure: false, callData: erc20.encodeFunctionData('transfer', [A, 1n]) }]]))
    expect(multi).toMatchObject({ type: 'transfer', protocol: 'Multicall3' })
  })
})

describe('revert 解码', () => {
  it('Error / Panic / 自定义错误 / 未知', () => {
    const coder = AbiCoder.defaultAbiCoder()
    expect(decodeRevert(`0x08c379a0${coder.encode(['string'], ['nope']).slice(2)}`)).toBe('nope')
    expect(decodeRevert(`0x4e487b71${coder.encode(['uint256'], [17n]).slice(2)}`)).toBe('Panic(17) arithmetic overflow / underflow')
    expect(decodeRevert(id('V3TooLittleReceived()').slice(0, 10))).toBe('V3TooLittleReceived()')
    const inner = `0x08c379a0${coder.encode(['string'], ['STF']).slice(2)}`
    expect(decodeRevert(`${id('ExecutionFailed(uint256,bytes)').slice(0, 10)}${coder.encode(['uint256', 'bytes'], [1n, inner]).slice(2)}`)).toBe('ExecutionFailed(command 1: STF)')
    expect(decodeRevert('0x12345678')).toBe('custom error 0x12345678')
    expect(decodeRevert('0x')).toBeNull()
  })
})

// 假节点：eth_simulateV1 返回预设日志
function fakeProvider(send: (method: string, params: unknown[]) => unknown): Provider {
  const meta: Record<string, { symbol: string; decimals: number }> = { [TOKEN.toLowerCase()]: { symbol: 'TKN', decimals: 6 }, [WETH.toLowerCase()]: { symbol: 'WTKN', decimals: 18 }, [NATIVE.toLowerCase()]: { symbol: 'ETH', decimals: 18 } }
  return {
    rpc: { send: async (m: string, p: unknown[]) => send(m, p), getCode: async (a: string) => (a.toLowerCase() === A ? '0x' : '0x60') },
    getChainId: async () => 1,
    tokens: async (list: string[]) => list.map((t) => ({ ...meta[t.toLowerCase()], success: true })),
    balances: async () => [{ balance: '1000000000000000000' }],
  } as unknown as Provider
}
const NATIVE = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE'
const TRANSFER = id('Transfer(address,address,uint256)')
const log = (address: string, topics: string[], data = '0x') => ({ address, topics, data })

describe('simulate（假节点）', () => {
  it('simulateV1：日志变成资产变化和授权变化', async () => {
    const provider = fakeProvider((method, params) => {
      expect(method).toBe('eth_simulateV1')
      return [
        {
          calls: [
            {
              status: '0x1',
              returnData: '0x',
              gasUsed: '0x5208',
              logs: [
                log(NATIVE, [TRANSFER, topic(A), topic(WETH)], word(10n ** 18n)),
                log(WETH, [id('Deposit(address,uint256)'), topic(A)], word(10n ** 18n)),
                log(TOKEN, [TRANSFER, topic(B), topic(A)], word(3_000_000n)),
                log(TOKEN, [id('Approval(address,address,uint256)'), topic(A), topic(B)], word(2n ** 256n - 1n)),
              ],
            },
          ],
        },
      ]
    })
    const sim = await simulate(provider, { from: A, to: WETH, value: 10n ** 18n, data: '0xd0e30db0' }, { fee: false })
    expect(sim.balanceChanges.map((c) => [c.symbol, c.formatted])).toEqual([['ETH', '-1'], ['WTKN', '1'], ['TKN', '3']])
    expect(sim.approvalChanges).toMatchObject([{ type: 'erc20', unlimited: true, spender: B, symbol: 'TKN' }])
    // B 没有已知名字、有代码：unknown-spender
    expect(sim.warnings.map((w) => w.code)).toEqual(expect.arrayContaining(['unlimited-approval', 'unknown-spender', 'large-value']))
    expect(sim.gasUsed).toBe('21000')
    await expect(assertSimulation(sim)).resolves.toBe(sim)
  })

  it('不支持 eth_simulateV1 时退回 eth_call，revert 原因解码', async () => {
    const coder = AbiCoder.defaultAbiCoder()
    const reverted = Object.assign(new Error('execution reverted'), { data: `0x08c379a0${coder.encode(['string'], ['ERC20: transfer amount exceeds balance']).slice(2)}` })
    const provider = fakeProvider((method) => {
      if (method === 'eth_simulateV1') throw new Error('the method eth_simulateV1 does not exist/is not available')
      if (method === 'eth_call') throw reverted
      return '0x5208'
    })
    const sim = await simulate(provider, { from: A, to: TOKEN, data: erc20.encodeFunctionData('transfer', [B, 1n]) }, { fee: false })
    expect(sim).toMatchObject({ success: false, mode: 'eth_call', error: 'ERC20: transfer amount exceeds balance' })
    await expect(assertSimulation(sim)).rejects.toThrow('Simulation failed: ERC20: transfer amount exceeds balance')
  })

  it('simulateBatch：汇总、失败下标', async () => {
    let n = 0
    const provider = fakeProvider(() => [
      {
        calls: [0, 1].map((i) => ({
          status: i === 0 ? '0x1' : '0x0',
          returnData: '0x',
          gasUsed: '0x10',
          error: i === 1 ? { message: 'execution reverted' } : undefined,
          logs: i === 0 ? [log(TOKEN, [TRANSFER, topic(A), topic(B)], word(5n))] : [],
        })),
      },
    ])
    n++
    const batch = await simulateBatch(provider, [{ to: TOKEN, data: '0x' }, { to: TOKEN, data: '0x' }], { from: A, fee: false })
    expect(batch).toMatchObject({ success: false, failedIndex: 1, gasUsed: '32' })
    expect(batch.balanceChanges).toMatchObject([{ delta: '-5' }])
    expect(n).toBe(1)
  })
})
