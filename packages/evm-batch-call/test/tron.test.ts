import { AbiCoder, Interface } from 'ethers'
import { beforeEach, describe, expect, it } from 'vitest'

import { CallFailedError, Contract, Provider, TRON_CHAIN_ID, TronProvider, toEvmAddress, toTronAddress } from '../src/index.js'
import { multicall3Interface, resetMulticallCache } from '../src/aggregate.js'
import { DEPLOYLESS_MULTICALL3_BYTECODE } from '../src/deployless.js'

const USDT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'
const USDT_HEX = '0xa614f803b6fd780986a42c78ec9c7f77e6ded13c'
const MULTICALL = 'TEazPvZwDjDtFeJupyo7QunvnrnUjPH8ED'
const HOLDER = 'TNXoiAJ3dct8Fjg4M9fkLFh9S2v9TXc32G'

const erc20 = new Interface([
  'function symbol() view returns (string)',
  'function balanceOf(address) view returns (uint256)',
  'function transfer(address to, uint256 amount) returns (bool)',
])

beforeEach(() => resetMulticallCache())

describe('Tron 地址转换', () => {
  it('base58 ⇄ hex 互转并校验 checksum', () => {
    expect(toEvmAddress(USDT)).toBe(USDT_HEX)
    expect(toTronAddress(USDT_HEX)).toBe(USDT)
    expect(toTronAddress('41' + USDT_HEX.slice(2))).toBe(USDT)
    expect(toEvmAddress('0xabc')).toBe('0xabc')
    expect(() => toEvmAddress('TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6u')).toThrow(/Invalid Tron address/)
  })
})

/** 模拟 /wallet/triggerconstantcontract 与 /wallet/getaccount */
const GENESIS = {
  mainnet: '00000000000000001ebf88508a03865c71d452e25f4d51194196a1d22b6653dc',
  nile: '0000000000000000d698d4192c56cb6be724a558448e2684802de4d6cd8690dc',
}

function createTronNode(network: keyof typeof GENESIS = 'mainnet') {
  const requests: Array<{ path: string; body: any }> = []
  const request = async (path: string, body: any) => {
    // 链校验读创世区块（Tron 主网），不计入业务请求
    if (path === 'wallet/getblockbynum') {
      return { blockID: GENESIS[network] }
    }
    requests.push({ path, body })
    if (path === 'wallet/getaccount') {
      return { balance: 1234 }
    }
    const data = '0x' + body.data
    const execOne = (target: string, callData: string) => {
      const tx = erc20.parseTransaction({ data: callData })
      if (target !== '41' + USDT_HEX.slice(2)) return [true, '0x']
      if (tx?.name === 'symbol') return [true, erc20.encodeFunctionResult('symbol', ['USDT'])]
      if (tx?.name === 'balanceOf') return [true, erc20.encodeFunctionResult('balanceOf', [99n])]
      return [false, erc20.encodeErrorResult('Error', ['nope'])]
    }
    const toResult = (hex: string, failed = false) => ({
      constant_result: [hex.slice(2)],
      result: failed ? { result: true, message: Buffer.from('REVERT opcode executed').toString('hex') } : { result: true },
      transaction: { ret: [failed ? { ret: 'FAILED' } : {}] },
    })
    // deployless
    if (!body.contract_address) {
      const args = '0x' + data.slice(DEPLOYLESS_MULTICALL3_BYTECODE.length)
      const [calls] = AbiCoder.defaultAbiCoder().decode(['tuple(address target, bool allowFailure, bytes callData)[]'], args)
      const out = (calls as any[]).map((c) => execOne('41' + String(c.target).slice(2).toLowerCase(), c.callData))
      return toResult(multicall3Interface.encodeFunctionResult('aggregate3', [out]))
    }
    if (body.contract_address === '41' + toEvmAddress(MULTICALL).slice(2)) {
      const parsed = multicall3Interface.parseTransaction({ data })
      const out = (parsed?.args[0] as any[]).map((c) => execOne('41' + String(c.target).slice(2).toLowerCase(), c.callData))
      return toResult(multicall3Interface.encodeFunctionResult('aggregate3', [out]))
    }
    if (body.contract_address === '41' + USDT_HEX.slice(2)) {
      const [ok, ret] = execOne(body.contract_address, data) as [boolean, string]
      return toResult(ret, !ok)
    }
    return { result: { code: 'CONTRACT_VALIDATE_ERROR', message: Buffer.from('Smart contract is not exist.').toString('hex') } }
  }
  return { requests, request }
}

describe('TronProvider', () => {
  it('节点实际所在的链与 chainId 不一致时报错，不会返回另一条链的数据', async () => {
    const node = createTronNode('nile')
    const multi = new Provider(TRON_CHAIN_ID.mainnet, new TronProvider({ request: node.request }))
    await expect(multi.all([new Contract(USDT, erc20).symbol()])).rejects.toThrow(/chainId mismatch/)
  })

  it('Tron 主网走 Multicall3，T 地址可直接用于合约地址和参数', async () => {
    const node = createTronNode()
    const multi = new Provider(TRON_CHAIN_ID.mainnet, new TronProvider({ request: node.request }))
    const usdt = new Contract(USDT, erc20)
    expect(await multi.all([usdt.symbol(), usdt.balanceOf(HOLDER)])).toEqual(['USDT', 99n])
    expect(node.requests).toHaveLength(1)
    expect(node.requests[0]?.body.contract_address).toBe('41' + toEvmAddress(MULTICALL).slice(2))
  })

  it('未知 Tron 网络（如 Nile）走 deployless', async () => {
    const node = createTronNode('nile')
    const multi = new Provider(TRON_CHAIN_ID.nile, new TronProvider({ request: node.request }))
    expect(await multi.tryAll([new Contract(USDT, erc20).symbol()])).toEqual(['USDT'])
    expect(node.requests[0]?.body.contract_address).toBeUndefined()
  })

  it('自定义 multicall 地址不存在时退回 deployless', async () => {
    const node = createTronNode()
    const multi = new Provider(TRON_CHAIN_ID.mainnet, new TronProvider({ request: node.request }), {
      multicall: { address: 'TNXoiAJ3dct8Fjg4M9fkLFh9S2v9TXc32G' },
    })
    expect(await multi.all([new Contract(USDT, erc20).symbol()])).toEqual(['USDT'])
    expect(node.requests.map((r) => Boolean(r.body.contract_address))).toEqual([true, false])
  })

  it('staticCall：带 from / value，revert 时返回原因', async () => {
    const node = createTronNode()
    const multi = new Provider(TRON_CHAIN_ID.mainnet, new TronProvider({ request: node.request }))
    const usdt = new Contract(USDT, erc20)
    const err = await multi.staticCall(usdt.transfer(HOLDER, 1n), { from: HOLDER, value: 5n }).catch((e) => e)
    expect(err).toBeInstanceOf(CallFailedError)
    expect(err.reason).toBe('nope')
    const body = node.requests[0]?.body
    expect(body.owner_address).toBe('41' + toEvmAddress(HOLDER).slice(2))
    expect(body.call_value).toBe(5)
    expect(body.contract_address).toBe('41' + USDT_HEX.slice(2))
  })

  it('getBalance 走 getaccount', async () => {
    const node = createTronNode()
    expect(await new TronProvider({ request: node.request }).getBalance(HOLDER)).toBe(1234n)
  })

  it('不支持历史区块', async () => {
    const node = createTronNode()
    await expect(new TronProvider({ request: node.request }).call({ to: USDT, data: '0x', blockTag: 1 })).rejects.toThrow(/does not support/)
  })

  it('并发限制', async () => {
    let active = 0
    let peak = 0
    const tron = new TronProvider({
      concurrency: 2,
      request: async () => {
        active++
        peak = Math.max(peak, active)
        await new Promise((r) => setTimeout(r, 5))
        active--
        return { balance: 1 }
      },
    })
    await Promise.all(Array.from({ length: 6 }, () => tron.getBalance(HOLDER)))
    expect(peak).toBe(2)
  })

  it('直接接受钱包注入的 tronWeb，默认以当前连接地址作为 from（切换账号后跟随）', async () => {
    const node = createTronNode()
    const tronWeb = {
      defaultAddress: { base58: HOLDER as string | false },
      fullNode: { request: (url: string, payload: any) => node.request(url, payload) },
    }
    const multi = new Provider(TRON_CHAIN_ID.mainnet, tronWeb)
    const usdt = new Contract(USDT, erc20)
    await multi.staticCall(usdt.symbol())
    expect(node.requests[0]?.body.owner_address).toBe('41' + toEvmAddress(HOLDER).slice(2))
    tronWeb.defaultAddress.base58 = USDT
    await multi.staticCall(usdt.symbol())
    expect(node.requests[1]?.body.owner_address).toBe('41' + USDT_HEX.slice(2))
  })

  it('429 自动退避重试', async () => {
    let n = 0
    const tron = new TronProvider({
      request: async () => {
        if (n++ === 0) throw Object.assign(new Error('rate limited'), { response: { status: 429 } })
        return { balance: 7 }
      },
    })
    expect(await tron.getBalance(HOLDER)).toBe(7n)
    expect(n).toBe(2)
  })

  it('minInterval 控制请求间隔', async () => {
    const starts: number[] = []
    const tron = new TronProvider({
      minInterval: 30,
      request: async () => {
        starts.push(Date.now())
        return { balance: 1 }
      },
    })
    await Promise.all([tron.getBalance(HOLDER), tron.getBalance(HOLDER), tron.getBalance(HOLDER)])
    expect((starts[2] as number) - (starts[0] as number)).toBeGreaterThanOrEqual(55)
  })
})
