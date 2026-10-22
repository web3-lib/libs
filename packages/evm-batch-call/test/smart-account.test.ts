import { Wallet } from 'ethers'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { resetMulticallCache } from '../src/aggregate.js'
import { resetDecimalsCache } from '../src/erc20.js'
import { resetNodeHealth } from '../src/fallback.js'
import { Provider } from '../src/index.js'
import { BundlerClient, DUMMY_SIGNATURE, ENTRY_POINT_V07, PaymasterClient, getCallsStatus, getWalletCapabilities, packUserOp, userOpToRpc, type UserOperation } from '../src/subpaths/smart-account.js'
import { batchCall } from '../src/subpaths/write.js'
import { CHAIN_ID, createFakeChain } from './fakeChain.js'

const A = new Wallet(`0x${'11'.repeat(32)}`).address
const R1 = '0x5000000000000000000000000000000000000001'
const R2 = '0x5000000000000000000000000000000000000002'

const op: UserOperation = {
  sender: A,
  nonce: 3n,
  callData: '0x1234',
  callGasLimit: 100_000n,
  verificationGasLimit: 200_000n,
  preVerificationGas: 50_000n,
  maxFeePerGas: 2n * 10n ** 9n,
  maxPriorityFeePerGas: 10n ** 9n,
  signature: '0x',
}

/** 记录请求的 JSON-RPC fetch */
function rpcFetch(handler: (method: string, params: unknown[]) => unknown) {
  const calls: Array<{ method: string; params: unknown[] }> = []
  const fetchFn = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { id: number; method: string; params: unknown[] }
    calls.push({ method: body.method, params: body.params })
    let result: unknown
    try {
      result = { result: handler(body.method, body.params) }
    } catch (e) {
      result = { error: { code: -32500, message: (e as Error).message } }
    }
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, ...(result as object) }))
  })
  return { calls, fetch: fetchFn as unknown as typeof fetch }
}

describe('UserOperation 打包', () => {
  it('accountGasLimits / gasFees / paymasterAndData 按 v0.7 的布局打包；RPC 格式数值为十六进制', () => {
    const paymaster = '0x7000000000000000000000000000000000000007'
    const p = packUserOp({ ...op, paymaster, paymasterVerificationGasLimit: 1n, paymasterPostOpGasLimit: 2n, paymasterData: '0xabcd' })
    expect(p.accountGasLimits).toBe(`0x${(200_000).toString(16).padStart(32, '0')}${(100_000).toString(16).padStart(32, '0')}`)
    expect(p.gasFees).toBe(`0x${(10 ** 9).toString(16).padStart(32, '0')}${(2 * 10 ** 9).toString(16).padStart(32, '0')}`)
    expect(p.paymasterAndData).toBe(`${paymaster}${'1'.padStart(32, '0')}${'2'.padStart(32, '0')}abcd`)
    expect(p.initCode).toBe('0x')
    expect(userOpToRpc(op)).toMatchObject({ nonce: '0x3', callGasLimit: '0x186a0' })
    expect((DUMMY_SIGNATURE.length - 2) / 2).toBe(65)
  })
})

describe('BundlerClient / PaymasterClient', () => {
  it('估算（空签名换成占位签名）、发送、回执、等待', async () => {
    const hash = `0x${'ab'.repeat(32)}`
    let polls = 0
    const { calls, fetch } = rpcFetch((method) => {
      if (method === 'eth_estimateUserOperationGas') return { callGasLimit: '0x10', verificationGasLimit: '0x20', preVerificationGas: '0x30' }
      if (method === 'eth_sendUserOperation') return hash
      if (method === 'eth_getUserOperationReceipt') {
        return ++polls < 2 ? null : { userOpHash: hash, sender: A, success: false, reason: '0x08c379a0', actualGasCost: '0x5', actualGasUsed: '0x6', receipt: { transactionHash: `0x${'cd'.repeat(32)}`, blockNumber: '0x9' } }
      }
      throw new Error(`unexpected ${method}`)
    })
    const bundler = new BundlerClient('https://bundler.example/rpc?apikey=SECRET', { fetch })
    expect(await bundler.estimateUserOperationGas(op, ENTRY_POINT_V07)).toEqual({ callGasLimit: 16n, verificationGasLimit: 32n, preVerificationGas: 48n })
    expect((calls[0]?.params[0] as { signature: string }).signature).toBe(DUMMY_SIGNATURE)
    expect(await bundler.sendUserOperation(op, ENTRY_POINT_V07)).toBe(hash)
    const receipt = await bundler.waitForUserOperation(hash, { pollInterval: 1, timeout: 2_000 })
    expect(receipt).toMatchObject({ success: false, reason: '0x08c379a0', actualGasCost: 5n, blockNumber: 9 })
    expect(await new BundlerClient('https://x', { fetch: rpcFetch(() => null).fetch }).waitForUserOperation(hash, { pollInterval: 1, timeout: 20 })).toBeNull()
  })

  it('RPC 错误里不带 URL（URL 里常有 API Key）', async () => {
    const fetchFn = (async () => new Response('', { status: 401 })) as unknown as typeof fetch
    const error = await new BundlerClient('https://bundler.example/rpc?apikey=SECRET', { fetch: fetchFn }).supportedEntryPoints().catch((e: Error) => e)
    expect(String((error as Error).message)).not.toContain('SECRET')
  })

  it('ERC-7677：stub / final 两个阶段，context 原样传给服务', async () => {
    const { calls, fetch } = rpcFetch((method) => ({ paymaster: '0x7000000000000000000000000000000000000007', paymasterData: method === 'pm_getPaymasterStubData' ? '0x01' : '0x02', paymasterVerificationGasLimit: '0x5', paymasterPostOpGasLimit: '0x6' }))
    const pm = new PaymasterClient('https://pm.example', { sponsorshipPolicyId: 'p1' }, { fetch })
    const stub = await pm.hook(op, { entryPoint: ENTRY_POINT_V07, chainId: 8453, stage: 'stub' })
    const final = await pm.hook(op, { entryPoint: ENTRY_POINT_V07, chainId: 8453, stage: 'final' })
    expect([stub.paymasterData, final.paymasterData]).toEqual(['0x01', '0x02'])
    expect(calls.map((c) => c.method)).toEqual(['pm_getPaymasterStubData', 'pm_getPaymasterData'])
    expect(calls[0]?.params.slice(1)).toEqual([ENTRY_POINT_V07, '0x2105', { sponsorshipPolicyId: 'p1' }])
  })
})

describe("EIP-5792（mode: '5792'）", () => {
  beforeEach(() => {
    resetNodeHealth()
    resetMulticallCache()
    resetDecimalsCache()
  })
  const chainHex = `0x${CHAIN_ID.toString(16)}`

  /** 假的钱包：能力、sendCalls 和状态可配置；同时是 ethers 风格的只能发送的签名器 */
  function wallet(caps: unknown, sendTx = vi.fn(async () => ({ hash: `0x${'ee'.repeat(32)}` }))) {
    const log: Array<{ method: string; params: unknown[] }> = []
    const provider = {
      request: async ({ method, params = [] }: { method: string; params?: unknown[] | object }) => {
        log.push({ method, params: params as unknown[] })
        if (method === 'wallet_getCapabilities') {
          if (caps === null) throw Object.assign(new Error('method not supported'), { code: 4200 })
          return { [chainHex]: caps }
        }
        if (method === 'wallet_sendCalls') return { id: '0xbatch' }
        if (method === 'wallet_getCallsStatus') return { version: '2.0.0', id: '0xbatch', status: 200, atomic: true, receipts: [{ transactionHash: `0x${'dd'.repeat(32)}`, blockNumber: '0x7', gasUsed: '0x5208', status: '0x1' }] }
        throw new Error(method)
      },
    }
    return { log, sendTx, signer: { getAddress: async () => A, sendTransaction: sendTx, provider } }
  }
  const multi = () => new Provider(CHAIN_ID, createFakeChain().node as never, { nativeBalance: 'rpc' })

  it('钱包支持原子批量：一次 wallet_sendCalls，所有调用共用同一笔交易，不逐笔发送', async () => {
    const w = wallet({ atomic: { status: 'supported' } })
    const results = await batchCall(multi(), [{ from: w.signer, to: R1, value: 5n }, { from: w.signer, to: R2, data: '0x1234' }], { mode: '5792', pollInterval: 1 })
    expect(results.map((r) => r.status)).toEqual(['confirmed', 'confirmed'])
    expect(results.every((r) => r.hash === `0x${'dd'.repeat(32)}` && r.atomic === true && r.gasUsed === '21000' && r.blockNumber === 7)).toBe(true)
    const sent = w.log.find((l) => l.method === 'wallet_sendCalls')?.params[0] as { atomicRequired: boolean; chainId: string; calls: Array<{ to: string; value?: string }> }
    expect(sent).toMatchObject({ atomicRequired: true, chainId: chainHex })
    expect(sent.calls).toEqual([{ to: R1, value: '0x5', data: '0x' }, { to: R2, data: '0x1234' }])
    expect(w.sendTx).not.toHaveBeenCalled()
  })

  it('钱包不支持 EIP-5792（或不能原子）：退回逐笔发送并标 atomic: false；atomicRequired 时直接失败', async () => {
    for (const caps of [null, { atomic: { status: 'unsupported' } }]) {
      const w = wallet(caps)
      const results = await batchCall(multi(), [{ from: w.signer, to: R1, value: 5n, gasLimit: 21_000n }], { mode: '5792', pollInterval: 1, timeout: 50 })
      expect(w.sendTx).toHaveBeenCalledTimes(1)
      expect(results[0]?.atomic).toBe(false)
      const strict = await batchCall(multi(), [{ from: w.signer, to: R1, value: 5n }], { mode: '5792', atomicRequired: true })
      expect(strict[0]).toMatchObject({ status: 'failed' })
      expect(strict[0]?.error).toMatch(/atomically|EIP-5792/)
    }
  })

  it('能力与状态码解析：ready 视为可用；v1 的字符串状态；失败状态码', async () => {
    const w = wallet({ atomic: { status: 'ready' }, paymasterService: { supported: true } })
    expect(await getWalletCapabilities(w.signer, A, CHAIN_ID)).toMatchObject({ atomic: 'ready', paymasterService: true })
    const v1 = { request: async () => ({ status: 'CONFIRMED', receipts: [{ transactionHash: '0x1', status: '0x0' }] }) }
    expect(await getCallsStatus(v1, 'id')).toMatchObject({ status: 'confirmed', receipts: [{ success: false }] })
    expect((await getCallsStatus({ request: async () => ({ status: 500 }) }, 'id')).status).toBe('reverted')
  })

  it('4337 没有 bundler 也没有 selfBundle：报错', async () => {
    await expect(batchCall(multi(), [{ from: `0x${'11'.repeat(32)}`, to: R1, value: 1n }], { mode: '4337' })).rejects.toThrow(/bundler/)
  })
})
