/** code review 发现的问题的回归测试 */
import { AbiCoder, JsonRpcProvider, makeError, type TransactionRequest } from 'ethers'
import { beforeEach, describe, expect, it } from 'vitest'

import { CallFailedError, Contract, MULTICALL3_ADDRESS, Provider, TRON_CHAIN_ID, TronProvider, isExecutionError, type Call } from '../src/index.js'
import { resetMulticallCache } from '../src/aggregate.js'
import { createMockProvider, fakeToken } from './mockProvider.js'

const TOKEN = '0x1000000000000000000000000000000000000001'
const USER = '0x4000000000000000000000000000000000000004'
const ABI = [
  'function symbol() view returns (string)',
  'function deposit() payable returns (uint256 received)',
  'function whoami() view returns (address)',
]

function healthy() {
  return createMockProvider({ contracts: { [TOKEN]: fakeToken('AAA', 18) }, multicallAddresses: [MULTICALL3_ADDRESS] })
}

const callException = (message: string, data: string | null = null) =>
  makeError('missing revert data', 'CALL_EXCEPTION', {
    action: 'call',
    data,
    reason: null,
    transaction: { to: null, data: '0x' },
    invocation: null,
    revert: null,
    info: { error: { code: -32000, message } },
  })

beforeEach(() => resetMulticallCache())

describe('multicall 地址可用性缓存', () => {
  it('out of gas 等无数据 revert 只退回 deployless 一次，不把地址判为无效', async () => {
    const mock = healthy()
    const realCall = mock.call
    const seen: boolean[] = []
    let first = true
    mock.call = async (tx: TransactionRequest) => {
      seen.push(Boolean(tx.to))
      if (first && tx.to) {
        first = false
        throw callException('out of gas')
      }
      return realCall(tx)
    }
    const multi = new Provider(56, mock)
    const c = new Contract(TOKEN, ABI)
    expect(await multi.tryAll([c.symbol()])).toEqual(['AAA'])
    expect(seen).toEqual([true, false])
    await multi.tryAll([c.symbol()])
    expect(seen.at(-1)).toBe(true) // 下一次仍然用合约
  })

  it('历史区块上查到无代码，不影响 latest 查询', async () => {
    const mock = healthy()
    const realCall = mock.call
    mock.call = async (tx: TransactionRequest) => (tx.to && tx.blockTag === 99_999_999 ? '0x' : realCall(tx))
    const multi = new Provider(56, mock, { multicall: { address: MULTICALL3_ADDRESS } })
    const c = new Contract(TOKEN, ABI)
    await multi.all([c.symbol()], { blockTag: 99_999_999 })
    await multi.all([c.symbol()])
    expect(mock.calls.at(-1)?.to).toBeTruthy()
  })
})

describe('overrides', () => {
  it('staticCallAll：Call 自带的 value 优先于共享 overrides，undefined 不覆盖', async () => {
    const multi = new Provider(56, healthy())
    const c = new Contract(TOKEN, ABI)
    const [a, b] = await multi.staticCallAll(
      [c.deposit({ value: 5n }), { call: c.deposit({ value: 6n }), overrides: { value: undefined } }],
      { value: 1n },
    )
    expect(a).toEqual({ success: true, data: 5n })
    expect(b).toEqual({ success: true, data: 6n })
  })

  it('await 绑定 Call 时使用末位参数里的 blockTag / from', async () => {
    const mock = healthy()
    const multi = new Provider(56, mock)
    const c = multi.contract(TOKEN, ABI)
    await c.symbol({ blockTag: 'pending', from: USER })
    expect(mock.calls[0]?.blockTag).toBe('pending')
    expect(mock.calls[0]?.from).toBe(USER)
  })
})

describe('解码缓存', () => {
  it('共用 inputs 数组、outputs 不同的手工 Call 各自正确解码', async () => {
    const mock = createMockProvider({
      contracts: {
        [TOKEN]: (data) => ({
          success: true,
          returnData: data.startsWith('0x95d89b41') ? AbiCoder.defaultAbiCoder().encode(['string'], ['AAA']) : '0x',
        }),
      },
      multicallAddresses: [MULTICALL3_ADDRESS],
    })
    const NO_INPUTS: never[] = []
    const asString: Call = { contract: { address: TOKEN }, name: 'symbol', inputs: NO_INPUTS, outputs: [{ type: 'string' }], params: [] }
    const asBytes: Call = { contract: { address: TOKEN }, name: 'symbol', inputs: NO_INPUTS, outputs: [{ type: 'bytes32' }], params: [] }
    const multi = new Provider(56, mock)
    const [s, b] = await multi.all([asString, asBytes])
    expect(s).toBe('AAA')
    expect(b).toMatch(/^0x0{62}20$/)
  })

  it('同一份 ABI 只解析一次，多个实例共享 inputs 数组', () => {
    const a = new Contract(TOKEN, ABI).symbol()
    const b = new Contract(USER, ABI).symbol()
    expect(a.inputs).toBe(b.inputs)
    expect(a.outputs).toBe(b.outputs)
  })
})

describe('tokenInfo', () => {
  it('主币占位地址不发调用', async () => {
    const mock = healthy()
    const multi = new Provider(56, mock)
    expect(await multi.tokenInfo(['0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'])).toEqual([null])
    expect(mock.calls).toHaveLength(0)
  })
})

describe('Tron', () => {
  it('交易校验失败（CONTRACT_VALIDATE_ERROR）是确定性错误：不换节点，staticCall 得到 CallFailedError', async () => {
    const requests: string[] = []
    const node = (name: string) =>
      new TronProvider({
        request: async () => {
          requests.push(name)
          return { result: { code: 'CONTRACT_VALIDATE_ERROR', message: Buffer.from('balance is not sufficient').toString('hex') } }
        },
      })
    const multi = new Provider(TRON_CHAIN_ID.mainnet, [node('a'), node('b')])
    const err = await multi.staticCall(new Contract('TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', ABI).deposit(), { value: 1n }).catch((e) => e)
    expect(err).toBeInstanceOf(CallFailedError)
    expect(isExecutionError((err as CallFailedError).cause)).toBe(true)
    expect(requests).toEqual(['a'])
  })

  it('并发限制在释放与唤醒之间不会被抢占', async () => {
    let active = 0
    let peak = 0
    const pending: Array<() => void> = []
    const tron = new TronProvider({
      concurrency: 1,
      request: () => {
        active++
        peak = Math.max(peak, active)
        return new Promise((resolve) =>
          pending.push(() => {
            active--
            resolve({ balance: 1 })
          }),
        )
      },
    })
    const tick = () => new Promise((r) => setTimeout(r, 0))
    const tasks = [tron.getBalance(USER), tron.getBalance(USER)] // 第二个排队等名额
    await tick()
    expect(pending).toHaveLength(1)
    // 第一个完成：释放名额、唤醒排队者；排队者恢复执行之前插进一个新请求
    pending.shift()?.()
    queueMicrotask(() => {
      tasks.push(tron.getBalance(USER))
    })
    let settled = 0
    await tick()
    tasks.forEach((task) => task.then(() => settled++))
    for (let i = 0; i < 20 && settled < tasks.length; i++) {
      pending.shift()?.()
      await tick()
    }
    expect(settled).toBe(3)
    expect(peak).toBe(1)
  })
})

describe('timeout', () => {
  it('timeout: 0 表示不限制，而不是立即超时', async () => {
    const multi = new Provider(56, [healthy(), healthy()], { fallback: { timeout: 0 } })
    expect(await multi.all([new Contract(TOKEN, ABI).symbol()])).toEqual(['AAA'])
    // URL 节点：FetchRequest 的 timeout 为 0 会让请求立即超时，应保持 ethers 默认值
    const rpc = new Provider(56, 'https://a.example', { fallback: { timeout: 0 } }).rpc as JsonRpcProvider
    expect(rpc._getConnection().timeout).toBeGreaterThan(0)
  })
})
