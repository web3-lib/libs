import { makeError } from 'ethers'
import { beforeEach, describe, expect, it } from 'vitest'

import { CallFailedError, Contract, MULTICALL3_ADDRESS, Provider } from '../src/index.js'
import { resetMulticallCache } from '../src/aggregate.js'
import { createMockProvider, erc20Interface, fakeToken } from './mockProvider.js'

const ERC20ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
  'function boom() view returns (uint256)',
  'function deposit() payable returns (uint256 received)',
  'function whoami() view returns (address)',
]

const TOKEN_A = '0x1000000000000000000000000000000000000001'
const TOKEN_B = '0x2000000000000000000000000000000000000002'
const NO_CODE = '0x3000000000000000000000000000000000000003'
const USER = '0x4000000000000000000000000000000000000004'
const SPENDER = '0x5000000000000000000000000000000000000005'

const BSC = 56 // 内置表里有 Multicall3
const UNKNOWN_CHAIN = 999999 // 内置表里没有 → deployless

function setup(options: { multicall?: boolean } = {}) {
  return createMockProvider({
    contracts: {
      [TOKEN_A]: fakeToken('AAA', 18, { [USER]: 10n ** 18n }),
      [TOKEN_B]: fakeToken('BBB', 6, { [USER]: 5_000_000n }),
    },
    multicallAddresses: options.multicall === false ? [] : [MULTICALL3_ADDRESS],
    balances: { [USER]: 42n },
  })
}

beforeEach(() => resetMulticallCache())

describe('Contract', () => {
  it('支持人类可读 ABI，生成与 ethcall 结构一致的 Call', () => {
    const erc20 = new Contract(TOKEN_A, ERC20ABI)
    const call = erc20.balanceOf(USER)
    expect(call.contract.address).toBe(TOKEN_A)
    expect(call.name).toBe('balanceOf')
    expect(call.params).toEqual([USER])
    expect(call.inputs[0].type).toBe('address')
    expect(call.outputs[0].type).toBe('uint256')
    expect(erc20.address).toBe(TOKEN_A)
  })

  it('支持 JSON ABI，重载函数可用签名访问', () => {
    const c = new Contract(TOKEN_A, [
      { type: 'function', name: 'get', stateMutability: 'view', inputs: [{ type: 'uint256' }], outputs: [{ type: 'uint256' }] },
      { type: 'function', name: 'get', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
    ])
    expect(c.get).toBeUndefined()
    expect(c['get(uint256)'](1).inputs[0].type).toBe('uint256')
    expect(c['get(address)'](USER).inputs[0].type).toBe('address')
  })

  it('非 view 函数也会暴露（用于模拟调用）', () => {
    const erc20 = new Contract(TOKEN_A, ERC20ABI)
    expect(typeof erc20.approve).toBe('function')
  })
})

describe('Provider.all', () => {
  it('合约模式：一次 eth_call 拿到所有结果', async () => {
    const mock = setup()
    const multi = new Provider(BSC, mock)
    const a = new Contract(TOKEN_A, ERC20ABI)
    const b = new Contract(TOKEN_B, ERC20ABI)
    const [symbol, decimals, balance, allowance, symbolB] = await multi.all([
      a.symbol(),
      a.decimals(),
      a.balanceOf(USER),
      a.allowance(USER, SPENDER),
      b.symbol(),
    ])
    expect(symbol).toBe('AAA')
    expect(decimals).toBe(18n)
    expect(balance).toBe(10n ** 18n)
    expect(allowance).toBe(123n)
    expect(symbolB).toBe('BBB')
    expect(mock.calls).toHaveLength(1)
    expect(String(mock.calls[0]?.to).toLowerCase()).toBe(MULTICALL3_ADDRESS.toLowerCase())
  })

  it('多返回值返回 Result，可按下标和名字取', async () => {
    const multi = new Provider(BSC, setup())
    const [reserves] = await multi.all([new Contract(TOKEN_A, ERC20ABI).getReserves()])
    expect(reserves[0]).toBe(1n)
    expect(reserves.reserve1).toBe(2n)
    expect(reserves.blockTimestampLast).toBe(3n)
  })

  it('任意一条失败则整体抛错', async () => {
    const multi = new Provider(BSC, setup())
    const a = new Contract(TOKEN_A, ERC20ABI)
    await expect(multi.all([a.symbol(), a.boom()])).rejects.toThrow()
  })

  it('chainId 接受数字字符串', async () => {
    const mock = setup()
    const multi = new Provider('56', mock)
    expect(multi.multicall?.address).toBe(MULTICALL3_ADDRESS)
    await multi.all([new Contract(TOKEN_A, ERC20ABI).symbol()])
    expect(mock.calls[0]?.to).toBeTruthy()
  })

  it('空数组不发请求', async () => {
    const mock = setup()
    expect(await new Provider(BSC, mock).all([])).toEqual([])
    expect(mock.calls).toHaveLength(0)
  })
})

describe('Provider.tryAll / tryEach', () => {
  it('失败与无代码地址返回 null，其余正常', async () => {
    const multi = new Provider(BSC, setup())
    const a = new Contract(TOKEN_A, ERC20ABI)
    const res = await multi.tryAll([a.symbol(), a.boom(), new Contract(NO_CODE, ERC20ABI).balanceOf(USER), a.decimals()])
    expect(res).toEqual(['AAA', null, null, 18n])
  })

  it('非法地址（checksum 错误）只让该条为 null，all 则直接抛错', async () => {
    const mock = setup()
    const multi = new Provider(BSC, mock)
    const bad = new Contract('0xbb4CdB9CBd36B01bD8cBaE3F2c8b3eB2B1A4F0b1', ERC20ABI)
    const a = new Contract(TOKEN_A, ERC20ABI)
    expect(await multi.tryAll([a.symbol(), bad.symbol(), a.balanceOf('not-an-address'), a.decimals()])).toEqual(['AAA', null, null, 18n])
    expect(mock.calls).toHaveLength(1)
    await expect(multi.all([a.symbol(), bad.symbol()])).rejects.toThrow(/checksum/)
  })

  it('tryEach：允许失败的返回 null，不允许失败的抛错', async () => {
    const multi = new Provider(BSC, setup())
    const a = new Contract(TOKEN_A, ERC20ABI)
    expect(await multi.tryEach([a.symbol(), a.boom()], [false, true])).toEqual(['AAA', null])
    await expect(multi.tryEach([a.symbol(), a.boom()], [true, false])).rejects.toThrow()
  })
})

describe('deployless', () => {
  it('未知链走 deployless（不带 to 的 eth_call）', async () => {
    const mock = setup({ multicall: false })
    const multi = new Provider(UNKNOWN_CHAIN, mock)
    expect(multi.multicall).toBeNull()
    const res = await multi.tryAll([new Contract(TOKEN_A, ERC20ABI).symbol(), new Contract(TOKEN_B, ERC20ABI).decimals()])
    expect(res).toEqual(['AAA', 6n])
    expect(mock.calls).toHaveLength(1)
    expect(mock.calls[0]?.to).toBeUndefined()
  })

  it('配置 deployless: true 时即使链在表里也走 deployless', async () => {
    const mock = setup()
    await new Provider(BSC, mock, { deployless: true }).all([new Contract(TOKEN_A, ERC20ABI).symbol()])
    expect(mock.calls[0]?.to).toBeUndefined()
  })

  it('multicall 地址上没有代码时自动退回 deployless，并记住该地址', async () => {
    const mock = setup({ multicall: false })
    const a = new Contract(TOKEN_A, ERC20ABI)
    expect(await new Provider(BSC, mock).all([a.symbol()])).toEqual(['AAA'])
    expect(mock.calls.map((c) => Boolean(c.to))).toEqual([true, false])

    // 每次新建 Provider 也不再尝试坏地址
    expect(await new Provider(BSC, mock).all([a.decimals()])).toEqual([18n])
    expect(mock.calls.map((c) => Boolean(c.to))).toEqual([true, false, false])
  })

  it('查询早于 multicall 部署区块的数据时走 deployless', async () => {
    const mock = setup()
    await new Provider(BSC, mock).all([new Contract(TOKEN_A, ERC20ABI).symbol()], { blockTag: 1 })
    expect(mock.calls[0]?.to).toBeUndefined()
    expect(mock.calls[0]?.blockTag).toBe(1)
  })
})

describe('getEthBalance', () => {
  it('合约模式下和 ERC20 调用合并在同一次 eth_call', async () => {
    const mock = setup()
    const multi = new Provider(BSC, mock)
    const res = await multi.all([multi.getEthBalance(USER), new Contract(TOKEN_A, ERC20ABI).balanceOf(USER)])
    expect(res).toEqual([42n, 10n ** 18n])
    expect(mock.calls).toHaveLength(1)
    expect(mock.balanceCalls).toHaveLength(0)
  })

  it('deployless 模式下也在同一次 eth_call 里（合约内用 BALANCE 读取）', async () => {
    const mock = setup({ multicall: false })
    const multi = new Provider(UNKNOWN_CHAIN, mock)
    const a = new Contract(TOKEN_A, ERC20ABI)
    const res = await multi.tryAll([a.balanceOf(USER), multi.getEthBalance(USER), a.symbol()])
    expect(res).toEqual([10n ** 18n, 42n, 'AAA'])
    expect(mock.calls).toHaveLength(1)
    expect(mock.balanceCalls).toHaveLength(0)
  })
})

describe('deployless 大批量', () => {
  it('结果超过 24KB 时通过 revert 带回', async () => {
    const mock = createMockProvider({
      contracts: { [TOKEN_A]: fakeToken('AAA', 18, { [USER]: 1n }) },
      balances: { [USER]: 42n },
      maxCodeSize: 300,
    })
    const multi = new Provider(UNKNOWN_CHAIN, mock)
    const a = new Contract(TOKEN_A, ERC20ABI)
    const calls = [...Array.from({ length: 10 }, () => a.balanceOf(USER)), multi.getEthBalance(USER)]
    expect(await multi.all(calls)).toEqual([...Array(10).fill(1n), 42n])
    expect(mock.calls).toHaveLength(1)
  })

  it('revert 数据被丢掉时对半拆分重试', async () => {
    const mock = createMockProvider({
      contracts: { [TOKEN_A]: fakeToken('AAA', 18, { [USER]: 1n }) },
      maxCodeSize: 300,
      dropRevertData: true,
    })
    const multi = new Provider(UNKNOWN_CHAIN, mock)
    const a = new Contract(TOKEN_A, ERC20ABI)
    expect(await multi.tryAll(Array.from({ length: 8 }, () => a.balanceOf(USER)))).toEqual(Array(8).fill(1n))
    expect(mock.calls.length).toBeGreaterThan(1)
  })

  it('按 initcode 大小（48KB）自动切片', async () => {
    const mock = setup({ multicall: false })
    const multi = new Provider(UNKNOWN_CHAIN, mock)
    const a = new Contract(TOKEN_A, ERC20ABI)
    const res = await multi.tryAll(Array.from({ length: 400 }, () => a.balanceOf(USER)))
    expect(res).toHaveLength(400)
    expect(res.every((r) => r === 10n ** 18n)).toBe(true)
    expect(mock.calls.length).toBeGreaterThan(1)
    for (const call of mock.calls) {
      expect((String(call.data).length - 2) / 2).toBeLessThanOrEqual(49152)
    }
  })
})

describe('节点错误不能误判 multicall 地址无效', () => {
  it('限流等 JSON-RPC 错误（ethers 也包装成 CALL_EXCEPTION）原样抛出，不缓存', async () => {
    const mock = setup()
    const realCall = mock.call
    let n = 0
    mock.call = async (tx) => {
      if (n++ === 0) {
        throw makeError('missing revert data', 'CALL_EXCEPTION', {
          action: 'call',
          data: null,
          reason: null,
          transaction: { to: null, data: '0x' },
          invocation: null,
          revert: null,
          info: { error: { code: -32005, message: 'limit exceeded' } },
        })
      }
      return realCall(tx)
    }
    const multi = new Provider(BSC, mock)
    const a = new Contract(TOKEN_A, ERC20ABI)
    await expect(multi.all([a.symbol()])).rejects.toThrow()
    expect(await multi.all([a.symbol()])).toEqual(['AAA'])
    expect(mock.calls.at(-1)?.to).toBeTruthy()
  })
})

describe('分片', () => {
  it('超过 chunkSize 自动拆分，结果顺序保持', async () => {
    const mock = setup()
    const multi = new Provider(BSC, mock, { chunkSize: 2 })
    const a = new Contract(TOKEN_A, ERC20ABI)
    const b = new Contract(TOKEN_B, ERC20ABI)
    const res = await multi.all([a.symbol(), b.symbol(), a.decimals(), b.decimals(), a.balanceOf(USER)])
    expect(res).toEqual(['AAA', 'BBB', 18n, 6n, 10n ** 18n])
    expect(mock.calls).toHaveLength(3)
  })
})

describe('Provider.call 自动合并', () => {
  it('同一 tick 内的独立调用合并成一次 eth_call，并去重', async () => {
    const mock = setup()
    const multi = new Provider(BSC, mock)
    const a = new Contract(TOKEN_A, ERC20ABI)
    const b = new Contract(TOKEN_B, ERC20ABI)
    const res = await Promise.all([
      multi.call(a.symbol()),
      multi.call(b.decimals()),
      multi.call(a.symbol()),
      multi.call(multi.getEthBalance(USER)),
    ])
    expect(res).toEqual(['AAA', 6n, 'AAA', 42n])
    expect(mock.calls).toHaveLength(1)
    const [requests] = erc20Interface.getAbiCoder().decode(
      ['tuple(address,bool,bytes)[]'],
      '0x' + String(mock.calls[0]?.data).slice(10),
    )
    expect(requests).toHaveLength(3)
  })

  it('单条失败只 reject 自己，并带上 revert 原因', async () => {
    const multi = new Provider(BSC, setup())
    const a = new Contract(TOKEN_A, ERC20ABI)
    const [ok, failed, noCode] = await Promise.allSettled([
      multi.call(a.symbol()),
      multi.call(a.boom()),
      multi.call(new Contract(NO_CODE, ERC20ABI).symbol()),
    ])
    expect(ok).toEqual({ status: 'fulfilled', value: 'AAA' })
    expect(failed.status).toBe('rejected')
    const err = (failed as PromiseRejectedResult).reason
    expect(err).toBeInstanceOf(CallFailedError)
    expect(err.reason).toBe('boom!')
    expect((noCode as PromiseRejectedResult).reason).toBeInstanceOf(CallFailedError)
  })

  it('不同 blockTag 分开发', async () => {
    const mock = setup()
    const multi = new Provider(BSC, mock)
    const a = new Contract(TOKEN_A, ERC20ABI)
    await Promise.all([multi.call(a.symbol()), multi.call(a.decimals(), { blockTag: 'pending' })])
    expect(mock.calls).toHaveLength(2)
  })

  it('达到 maxSize 立即发出', async () => {
    const mock = setup()
    const multi = new Provider(BSC, mock, { batch: { wait: 10_000, maxSize: 2 } })
    const a = new Contract(TOKEN_A, ERC20ABI)
    const res = await Promise.all([multi.call(a.symbol()), multi.call(a.decimals())])
    expect(res).toEqual(['AAA', 18n])
    expect(mock.calls).toHaveLength(1)
  })

  it('wait 窗口内跨 await 的调用也能合并', async () => {
    const mock = setup()
    const multi = new Provider(BSC, mock, { batch: { wait: 20 } })
    const a = new Contract(TOKEN_A, ERC20ABI)
    const p1 = multi.call(a.symbol())
    await new Promise((r) => setTimeout(r, 5))
    const p2 = multi.call(a.decimals())
    expect(await Promise.all([p1, p2])).toEqual(['AAA', 18n])
    expect(mock.calls).toHaveLength(1)
  })

  it('整个请求失败时所有调用都 reject', async () => {
    const mock = setup()
    mock.call = async () => {
      throw new Error('network down')
    }
    const multi = new Provider(BSC, mock)
    const a = new Contract(TOKEN_A, ERC20ABI)
    const res = await Promise.allSettled([multi.call(a.symbol()), multi.call(a.decimals())])
    expect(res.map((r) => r.status)).toEqual(['rejected', 'rejected'])
  })
})

describe('staticCall 预执行', () => {
  it('直接调目标合约，带 from / value，msg.sender 是用户而不是 multicall', async () => {
    const mock = setup()
    const multi = new Provider(BSC, mock)
    const a = new Contract(TOKEN_A, ERC20ABI)
    expect(await multi.staticCall(a.whoami(), { from: USER })).toBe(USER)
    expect(await multi.staticCall(a.deposit(), { value: 7n })).toBe(7n)
    expect(String(mock.calls[0]?.to)).toBe(TOKEN_A)
  })

  it('支持 ethers 风格把 overrides 作为最后一个参数', async () => {
    const multi = new Provider(BSC, setup())
    const call = new Contract(TOKEN_A, ERC20ABI).deposit({ value: 9n })
    expect(call.params).toEqual([])
    expect(await multi.staticCall(call)).toBe(9n)
    // 显式 overrides 优先
    expect(await multi.staticCall(call, { value: 3n })).toBe(3n)
  })

  it('revert 时抛 CallFailedError 并带原因', async () => {
    const multi = new Provider(BSC, setup())
    const err = await multi.staticCall(new Contract(TOKEN_A, ERC20ABI).deposit()).catch((e) => e)
    expect(err).toBeInstanceOf(CallFailedError)
    expect(err.reason).toBe('no value')
  })

  it('staticCallAll：逐条返回结果，单条失败互不影响，支持每条不同 overrides', async () => {
    const mock = setup()
    const multi = new Provider(BSC, mock)
    const a = new Contract(TOKEN_A, ERC20ABI)
    const res = await multi.staticCallAll(
      [a.whoami(), { call: a.deposit(), overrides: { value: 5n } }, a.deposit(), new Contract(NO_CODE, ERC20ABI).symbol()],
      { from: USER },
    )
    expect(res[0]).toEqual({ success: true, data: USER })
    expect(res[1]).toEqual({ success: true, data: 5n })
    expect(res[2]?.success).toBe(false)
    expect(res[3]?.success).toBe(false)
    expect(mock.calls).toHaveLength(4)
  })
})

describe('浏览器钱包', () => {
  it('直接接受 EIP-1193 provider（window.ethereum）', async () => {
    const mock = setup()
    const requests: string[] = []
    const eip1193 = {
      async request({ method, params }: { method: string; params?: any[] }) {
        requests.push(method)
        if (method === 'eth_chainId') return '0x38'
        if (method === 'eth_call') {
          const [tx, blockTag] = params as [any, string]
          return mock.call({ ...tx, blockTag })
        }
        throw new Error(`unsupported ${method}`)
      },
    }
    const multi = new Provider(BSC, eip1193)
    const a = new Contract(TOKEN_A, ERC20ABI)
    expect(await multi.all([a.symbol(), a.decimals()])).toEqual(['AAA', 18n])
    expect(requests.filter((m) => m === 'eth_call')).toHaveLength(1)
  })

  it('不支持的对象直接报错', () => {
    expect(() => new Provider(BSC, {} as any)).toThrow(/Unsupported provider/)
  })
})
