import { JsonRpcProvider, makeError, type TransactionRequest } from 'ethers'
import { describe, expect, it } from 'vitest'

import {
  CallFailedError,
  ChainCheckedProvider,
  Contract,
  DEFAULT_RPC_URLS,
  FallbackRpc,
  MULTICALL3_ADDRESS,
  Provider,
  TRON_CHAIN_ID,
  TronProvider,
  getDefaultRpcUrls,
} from '../src/index.js'
import { createMockProvider, fakeToken } from './mockProvider.js'

const TOKEN = '0x1000000000000000000000000000000000000001'
const USER = '0x4000000000000000000000000000000000000004'
const ERC20ABI = ['function symbol() view returns (string)', 'function boom() view returns (uint256)']

function healthy() {
  return createMockProvider({ contracts: { [TOKEN]: fakeToken('AAA', 18) }, multicallAddresses: [MULTICALL3_ADDRESS], balances: { [USER]: 5n } })
}

function broken(error: () => unknown) {
  const calls: TransactionRequest[] = []
  return {
    calls,
    async call(tx: TransactionRequest): Promise<string> {
      calls.push(tx)
      throw error()
    },
    async getBalance(): Promise<bigint> {
      throw error()
    },
  }
}

const serverError = () => makeError('server response 503', 'SERVER_ERROR', { request: null as any, response: null as any })
// ethers 对 eth_call 的 JSON-RPC 错误（如限流）也会包装成 CALL_EXCEPTION
const rateLimited = () =>
  makeError('missing revert data', 'CALL_EXCEPTION', {
    action: 'call',
    data: null,
    reason: null,
    transaction: { to: null, data: '0x' },
    invocation: null,
    revert: null,
    info: { error: { code: -32005, message: 'limit exceeded' } },
  })

describe('FallbackRpc', () => {
  it('节点出错自动切到下一个', async () => {
    const bad = broken(serverError)
    const good = healthy()
    const multi = new Provider(56, [bad, good])
    expect(await multi.all([new Contract(TOKEN, ERC20ABI).symbol()])).toEqual(['AAA'])
    expect(bad.calls).toHaveLength(1)
    expect(good.calls).toHaveLength(1)
  })

  it('限流（包装成 CALL_EXCEPTION 的 JSON-RPC 错误）也会切换', async () => {
    const multi = new Provider(56, [broken(rateLimited), healthy()])
    expect(await multi.all([new Contract(TOKEN, ERC20ABI).symbol()])).toEqual(['AAA'])
  })

  it('出错的节点在 cooldown 内排到最后', async () => {
    const bad = broken(serverError)
    const good = healthy()
    const multi = new Provider(56, [bad, good], { fallback: { cooldown: 60_000 } })
    const c = new Contract(TOKEN, ERC20ABI)
    await multi.all([c.symbol()])
    await multi.all([c.symbol()])
    expect(bad.calls).toHaveLength(1)
    expect(good.calls).toHaveLength(2)
  })

  it('合约 revert 是确定性结果，不换节点重试', async () => {
    const first = healthy()
    const second = healthy()
    const multi = new Provider(56, [first, second])
    const err = await multi.staticCall(new Contract(TOKEN, ERC20ABI).boom()).catch((e) => e)
    expect(err).toBeInstanceOf(CallFailedError)
    expect(err.reason).toBe('boom!')
    expect(second.calls).toHaveLength(0)
  })

  it('超时视为故障', async () => {
    const hang = { call: () => new Promise<string>(() => {}), getBalance: () => new Promise<bigint>(() => {}) }
    const good = healthy()
    const multi = new Provider(56, [hang, good], { fallback: { timeout: 20 } })
    expect(await multi.all([new Contract(TOKEN, ERC20ABI).symbol()])).toEqual(['AAA'])
  })

  it('全部失败时抛最后一个错误', async () => {
    const rpc = new FallbackRpc([broken(serverError), broken(() => new Error('last'))])
    await expect(rpc.call({ to: TOKEN, data: '0x' })).rejects.toThrow('last')
  })

  it('getBalance 同样支持切换', async () => {
    const rpc = new FallbackRpc([broken(serverError), healthy()])
    expect(await rpc.getBalance(USER)).toBe(5n)
  })

  it('钱包 + 公共节点混合', async () => {
    const good = healthy()
    const wallet = {
      async request({ method }: { method: string }) {
        if (method === 'eth_chainId') return '0x38'
        throw Object.assign(new Error('wallet disconnected'), { code: 4900 })
      },
    }
    const multi = new Provider(56, [wallet, good])
    expect(await multi.all([new Contract(TOKEN, ERC20ABI).symbol()])).toEqual(['AAA'])
  })
})

describe('节点来源', () => {
  it('不传节点时使用内置公共节点表', () => {
    expect(DEFAULT_RPC_URLS[56]?.length).toBeGreaterThan(1)
    expect(getDefaultRpcUrls(56)).toBe(DEFAULT_RPC_URLS[56])
    expect(getDefaultRpcUrls(TRON_CHAIN_ID.mainnet).length).toBeGreaterThan(1)
    expect(() => new Provider(56)).not.toThrow()
    expect(() => new Provider(TRON_CHAIN_ID.mainnet)).not.toThrow()
    expect(() => new Provider(999_999_999)).toThrow(/No default RPC/)
  })

  it('URL 字符串：EVM 链创建 JsonRpcProvider，Tron 链创建 TronProvider', () => {
    const evm = new Provider(56, ['https://a.example', 'https://b.example'])
    expect(evm.rpc).toBeInstanceOf(FallbackRpc)
    // URL 节点外面套了一层链校验
    const inner = (node: unknown) => (node as ChainCheckedProvider).inner
    expect(inner((evm.rpc as FallbackRpc).nodes[0])).toBeInstanceOf(JsonRpcProvider)
    expect(inner(new Provider(TRON_CHAIN_ID.mainnet, 'https://api.trongrid.io').rpc)).toBeInstanceOf(TronProvider)
    expect(inner((new Provider(TRON_CHAIN_ID.mainnet).rpc as FallbackRpc).nodes[0])).toBeInstanceOf(TronProvider)
  })
})
