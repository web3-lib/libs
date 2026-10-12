import { ed25519 } from '@noble/curves/ed25519.js'
import { base58 } from '@scure/base'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { NATIVE_MINT, SYSTEM_PROGRAM_ID, SolanaClient } from '../src/index.js'
import { RpcError, resetNodeHealth } from '../src/rpc.js'
import { batchCall, batchCollect, batchTransfer, systemTransfer, type CollectItemResult } from '../src/subpaths/write.js'
import { resolveSigner } from '../src/write/signer.js'
import { compileMessage, messageBlockhash, messageSigners, serializeTransaction, splitTransaction } from '../src/write/transaction.js'
import { RENT_EXEMPT_MIN, TOKEN_ACCOUNT_RENT, createFakeSolana, keypair, type FakeSolanaOptions } from './fakeSolana.js'

const A = keypair(1)
const B = keypair(2)
const GAS = keypair(9)
const R1 = keypair(21).address
const R2 = keypair(22).address
const R3 = keypair(23).address
const HOT = keypair(30).address
const MINT = keypair(40).address
const NO_MINT = keypair(41).address
const SOL = 1_000_000_000n
const fast = { pollInterval: 1, timeout: 5_000, priorityFee: 0 }

function setup(options: FakeSolanaOptions = {}) {
  const chain = createFakeSolana(options)
  chain.addMint(MINT, 6)
  chain.setSol(A.address, 10n * SOL)
  chain.setSol(GAS.address, 10n * SOL)
  chain.setToken(A.address, MINT, 1_000_000n)
  const client = new SolanaClient(chain.transport)
  return { chain, client }
}

const transfer = (from = A, to = R1, lamports = SOL) => ({ from: from.secretKey, instructions: systemTransfer(from.address, to, lamports) })

beforeEach(() => resetNodeHealth())
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('batchCollect 参数与跳过', () => {
  it('归集地址非法时报错', async () => {
    const { client } = setup()
    await expect(batchCollect(client, [A.secretKey], 'not-an-address', { tokens: [MINT] })).rejects.toThrow('Invalid collect address')
  })

  it('代币读不到、钱包就是归集地址、钱包就是 feePayer', async () => {
    const { client } = setup()
    const { results } = await batchCollect(client, [A.secretKey, GAS.secretKey], A.address, { ...fast, tokens: [NO_MINT, NATIVE_MINT], feePayer: GAS.secretKey })
    expect(results.map((r) => [r.from, r.token, r.status, r.error])).toEqual([
      [A.address, NO_MINT, 'failed', 'cannot read balance: not-found'],
      [A.address, NATIVE_MINT, 'skipped', 'skipped: wallet is the collect address'],
      [GAS.address, NO_MINT, 'failed', 'cannot read balance: not-found'],
      [GAS.address, NATIVE_MINT, 'skipped', 'skipped: wallet is the fee payer'],
    ])
  })

  it('dryRun 时扫 SOL 只标记 simulated', async () => {
    const { chain, client } = setup()
    const { results } = await batchCollect(client, [A.secretKey], HOT, { ...fast, tokens: [MINT, NATIVE_MINT], dryRun: true })
    expect(results.map((r) => r.status)).toEqual(['simulated', 'simulated'])
    expect(chain.sent).toHaveLength(0)
  })

  it('代币归集之后读 SOL 余额失败：扫 SOL 的项失败，代币的结果照常返回', async () => {
    const { chain, client } = setup()
    const { results } = await batchCollect(client, [A.secretKey], HOT, {
      ...fast,
      tokens: [MINT, NATIVE_MINT],
      onUpdate: (r) => {
        // 代币归集确认后，只读 lamports 的请求（带 dataSlice）开始报错
        if (r.status === 'confirmed' && !(r as CollectItemResult).native) {
          chain.intercept((method, params) => {
            if (method === 'getMultipleAccounts' && (params[1] as { dataSlice?: unknown } | undefined)?.dataSlice) throw new RpcError('invalid params', -32602)
            return undefined
          })
        }
      },
    })
    expect(results[0]?.status).toBe('confirmed')
    expect(results[1]).toMatchObject({ status: 'failed' })
    expect(results[1]?.error).toContain('cannot read SOL balance')
  })

  it('SOL 余额不够付扫尾手续费、低于 minAmount 时跳过', async () => {
    const { chain, client } = setup()
    chain.setSol(B.address, 3000n)
    const { results } = await batchCollect(client, [B.secretKey, A.secretKey], HOT, { ...fast, tokens: [NATIVE_MINT], minAmount: { [NATIVE_MINT]: 100n * SOL } })
    expect(results.map((r) => r.error)).toEqual(['skipped: SOL balance does not cover the fee', 'skipped: below minAmount'])
  })
})

describe('batchTransfer 参数', () => {
  it('createAccounts: false 时收款人没有代币账户的项失败', async () => {
    const { chain, client } = setup()
    chain.setToken(R2, MINT, 0n)
    const results = await batchTransfer(
      client,
      A.secretKey,
      [
        { to: R1, amount: 1n },
        { to: R2, amount: 2n },
      ],
      { ...fast, token: MINT, createAccounts: false },
    )
    expect(results.map((r) => r.status)).toEqual(['failed', 'confirmed'])
    expect(results[0]?.error).toContain('createAccounts is false')
  })

  it('代币读不到、数量超出范围时报错', async () => {
    const { client } = setup()
    await expect(batchTransfer(client, A.secretKey, [{ to: R1, amount: 1n, token: NO_MINT }], fast)).rejects.toThrow('cannot read token')
    await expect(batchTransfer(client, A.secretKey, [{ to: R1, amount: 2n ** 64n }], { ...fast, checkBalance: false })).rejects.toThrow('out of range')
    await expect(batchTransfer(client, A.secretKey, [{ to: R1, amount: -1n }], fast)).rejects.toThrow('out of range')
  })
})

describe('签名器', () => {
  it('@solana/kit 的 KeyPairSigner（WebCrypto 的 CryptoKey）', async () => {
    const { chain, client } = setup()
    const keyPair = (await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify'])) as CryptoKeyPair
    const address = base58.encode(new Uint8Array(await crypto.subtle.exportKey('raw', keyPair.publicKey)))
    chain.setSol(address, SOL)
    const [result] = await batchCall(client, [{ from: { address, keyPair }, instructions: systemTransfer(address, R1, SOL / 2n) }], fast)
    expect(result?.status).toBe('confirmed')
    expect(chain.sol(R1)).toBe(SOL / 2n)
  })

  it('格式不对的输入', async () => {
    await expect(resolveSigner('[1,2')).rejects.toThrow('JSON array')
    await expect(resolveSigner(123 as never)).rejects.toThrow('Invalid signer')
    await expect(resolveSigner({ foo: 1 } as never)).rejects.toThrow('Invalid signer')
  })

  it('运行环境没有 WebCrypto / 不支持 Ed25519 时给出明确的错误', async () => {
    vi.stubGlobal('crypto', {})
    await expect(resolveSigner(A.secretKey)).rejects.toThrow('WebCrypto is not available')
    // 按错误名称识别（消息里没有关键词）
    vi.stubGlobal('crypto', { subtle: { importKey: () => Promise.reject(Object.assign(new Error('nope'), { name: 'NotSupportedError' })) } })
    await expect(resolveSigner(A.secretKey)).rejects.toThrow('Ed25519 is not supported')
    // 按错误消息识别
    vi.stubGlobal('crypto', { subtle: { importKey: () => Promise.reject(new Error('Algorithm: Unrecognized name')) } })
    await expect(resolveSigner(A.secretKey)).rejects.toThrow('Ed25519 is not supported')
    vi.stubGlobal('crypto', { subtle: { importKey: () => Promise.reject(new Error('DataError')) } })
    await expect(resolveSigner(A.secretKey)).rejects.toThrow(/^Invalid private key$/)
  })

  it('钱包返回的交易笔数不对时这批失败', async () => {
    const { chain, client } = setup()
    const wallet = { accounts: [{ address: A.address }], features: { 'solana:signTransaction': { signTransaction: async () => [] } } }
    const [result] = await batchCall(client, [{ from: wallet, instructions: systemTransfer(A.address, R1, SOL) }], fast)
    expect(result?.error).toContain('different number of transactions')
    expect(chain.sent).toHaveLength(0)
  })
})

describe('交易编码', () => {
  it('长数据（长度前缀多字节）编码后能原样拆开；签名者和 blockhash 能读出来', () => {
    const data = new Uint8Array(300).fill(7)
    const blockhash = keypair(77).address
    const message = compileMessage(A.address, [{ programId: SYSTEM_PROGRAM_ID, keys: [{ pubkey: B.address, isSigner: true, isWritable: false }], data }], blockhash)
    const signatures = message.signers.map(() => new Uint8Array(64).fill(1))
    const split = splitTransaction(serializeTransaction(message, signatures))
    expect(split.message).toEqual(message.bytes)
    expect(split.signatures).toHaveLength(2)
    expect(messageSigners(split.message)).toEqual([A.address, B.address])
    expect(messageBlockhash(split.message)).toBe(blockhash)
  })

  it('坏的交易字节报错', () => {
    expect(() => splitTransaction(new Uint8Array([0xff, 0xff, 0xff, 0xff]))).toThrow('bad length prefix')
    expect(() => splitTransaction(new Uint8Array([1, 2, 3]))).toThrow('truncated')
  })
})

describe('发送流程', () => {
  it('已取消：不发送，标记 skipped', async () => {
    const { chain, client } = setup()
    const controller = new AbortController()
    controller.abort()
    const [result] = await batchCall(client, [transfer()], { ...fast, signal: controller.signal })
    expect(result).toMatchObject({ status: 'skipped', error: 'aborted' })
    expect(chain.sent).toHaveLength(0)
  })

  it('等待确认时取消：保持 sent', async () => {
    const { client } = setup({ landAfterPolls: 1000 })
    const controller = new AbortController()
    const [result] = await batchCall(client, [transfer()], {
      ...fast,
      pollInterval: 20,
      signal: controller.signal,
      onUpdate: (r) => r.status === 'sent' && setTimeout(() => controller.abort(), 30),
    })
    expect(result?.status).toBe('sent')
  })

  it('等到 timeout 还没确认：pending', async () => {
    const { client } = setup({ landAfterPolls: 1000 })
    const [result] = await batchCall(client, [transfer()], { ...fast, timeout: 30 })
    expect(result?.status).toBe('pending')
    expect(result?.error).toContain('not confirmed within')
  })

  it('单个调用超出交易大小上限：失败', async () => {
    const { client } = setup()
    const huge = { programId: SYSTEM_PROGRAM_ID, keys: [{ pubkey: A.address, isSigner: true, isWritable: true }], data: new Uint8Array(1300) }
    const [result] = await batchCall(client, [{ from: A.secretKey, instructions: huge }], fast)
    expect(result?.status).toBe('failed')
    expect(result?.error).toContain('transaction too large')
  })

  it('打包后计算单元超出单笔上限：拆成两笔', async () => {
    const { chain, client } = setup({ systemTransferUnits: 600_000 })
    const results = await batchTransfer(client, A.secretKey, [R1, R2, R3].map((to) => ({ to, amount: SOL })), fast)
    expect(results.every((r) => r.status === 'confirmed')).toBe(true)
    expect(new Set(results.map((r) => r.signature)).size).toBe(2)
    expect(chain.sol(R3)).toBe(SOL)
  })

  it('拆分后前半有调用失败（不继续）：后半不再发送', async () => {
    // 每笔转账 70 万计算单元：三笔一起超出 140 万 → 拆成 [2, 1]；前半里第二笔余额不够
    const { chain, client } = setup({ systemTransferUnits: 700_000 })
    const results = await batchCall(client, [transfer(A, R1, SOL), transfer(A, R2, 100n * SOL), transfer(A, R3, SOL)], fast)
    expect(results.map((r) => r.status)).toEqual(['confirmed', 'failed', 'skipped'])
    // 每次模拟里的调用数：3（超限）→ 拆成 [2] 和 [1]；[2] 加上计算预算指令仍超限 → 再拆成 [1]（成功）和 [1]（余额不够、失败）→ 停止，后半跳过
    expect(chain.simulations.map((tx) => (tx as { instructions: unknown[] }).instructions.length - 2)).toEqual([3, 2, 1, 1])
    expect(chain.sol(R3)).toBe(0n)
  })

  it('按真实优先费用复核时付不起：失败，不发送', async () => {
    const { chain, client } = setup()
    chain.setSol(B.address, 5500n)
    const [result] = await batchCall(client, [transfer(B, R1, 0n)], { ...fast, priorityFee: 1_000_000 })
    expect(result?.status).toBe('failed')
    expect(result?.error).toBe('insufficient SOL for the transaction fee')
    expect(chain.sent).toHaveLength(0)
  })

  it('模拟时节点限频：重试；参数错误：直接失败', async () => {
    const { chain, client } = setup()
    let limited = 1
    chain.intercept((method) => {
      if (method === 'simulateTransaction' && limited-- > 0) throw new RpcError('Too many requests', 429)
      return undefined
    })
    const [ok] = await batchCall(client, [transfer()], fast)
    expect(ok?.status).toBe('confirmed')
    let attempts = 0
    chain.intercept((method) => {
      if (method !== 'simulateTransaction') return undefined
      attempts++
      throw new RpcError('Invalid params: bad transaction', -32602)
    })
    const [bad] = await batchCall(client, [transfer()], fast)
    expect(bad).toMatchObject({ status: 'failed', error: 'Invalid params: bad transaction' })
    expect(attempts).toBe(1) // 确定性错误不重试
  })

  it('节点说交易已经处理过：按已发出处理', async () => {
    const { chain, client } = setup()
    chain.intercept(async (method, _params, next) => {
      if (method !== 'sendTransaction') return undefined
      await next()
      throw new RpcError('Transaction simulation failed: This transaction has already been processed', -32002)
    })
    const [result] = await batchCall(client, [transfer()], fast)
    expect(result?.status).toBe('confirmed')
    expect(chain.sol(R1)).toBe(SOL)
  })

  it('广播被节点明确拒绝：失败，同一支付者后面的调用跳过', async () => {
    const { chain, client } = setup()
    chain.intercept((method) => {
      if (method === 'sendTransaction') throw new RpcError('Transaction signature verification failure', -32003)
      return undefined
    })
    const results = await batchCall(client, [transfer(A, R1), transfer(A, R2)], { ...fast, mode: 'tx' })
    expect(results.map((r) => r.status)).toEqual(['failed', 'skipped'])
    expect(chain.sol(R1)).toBe(0n)
  })

  it('取 blockhash 失败：这笔失败，之后重新取', async () => {
    const { chain, client } = setup()
    let failures = 1
    chain.intercept((method) => {
      if (method === 'getLatestBlockhash' && failures-- > 0) throw new RpcError('Invalid params', -32602)
      return undefined
    })
    const results = await batchCall(client, [transfer(A, R1), transfer(A, R2)], { ...fast, mode: 'tx', continueOnError: true })
    expect(results.map((r) => r.status)).toEqual(['failed', 'confirmed'])
  })

  it('签名器抛错（非 Error 对象）：失败', async () => {
    const { client } = setup()
    const signer = {
      address: A.address,
      sign: () => {
        throw 'device disconnected'
      },
    }
    const [result] = await batchCall(client, [{ from: signer, instructions: systemTransfer(A.address, R1, SOL) }], fast)
    expect(result).toMatchObject({ status: 'failed', error: 'device disconnected' })
  })

  it('不认识的交易错误：原样给出；错误落在计算预算指令或超出范围时整笔失败', async () => {
    const { chain, client } = setup()
    let err: unknown = { DuplicateInstruction: 0 }
    let simulations = 0
    chain.intercept((method) => {
      if (method !== 'simulateTransaction') return undefined
      simulations++
      return { context: { slot: 1 }, value: { err, logs: [], unitsConsumed: 0 } }
    })
    const [unknown] = await batchCall(client, [transfer()], fast)
    expect(unknown?.error).toBe('{"DuplicateInstruction":0}')
    // 错误落在计算预算指令上 / 下标超出范围：对应不到某个调用，整笔失败、只模拟一次（算错成某个调用的话会剔除它再模拟一次）
    for (const index of [0, 99]) {
      err = { InstructionError: [index, 'InvalidInstructionData'] }
      simulations = 0
      const results = await batchCall(client, [transfer(A, R1), transfer(A, R2)], { ...fast, continueOnError: true })
      expect(results.map((r) => r.status)).toEqual(['failed', 'failed'])
      expect(simulations).toBe(1)
    }
  })

  it('浏览器钱包没签第一笔：后面的交易跳过（continueOnError 为 false）', async () => {
    const { chain, client } = setup()
    let calls = 0
    const kit = {
      address: A.address,
      signTransactions: async (txs: ReadonlyArray<{ messageBytes: Uint8Array }>) =>
        txs.map((t) => (calls++ === 0 ? {} : { [A.address]: ed25519.sign(t.messageBytes, A.seed) })),
    }
    const results = await batchCall(
      client,
      [
        { from: kit, instructions: systemTransfer(A.address, R1, SOL) },
        { from: kit, instructions: systemTransfer(A.address, R2, SOL) },
      ],
      { ...fast, mode: 'tx' },
    )
    expect(results.map((r) => r.status)).toEqual(['failed', 'skipped'])
    expect(results[0]?.error).toBe('wallet did not sign the transaction')
    expect(chain.sent).toHaveLength(0)
  })

  it('广播时网络出错（交易可能已经发出）：按 sent 跟踪，最终以链上为准', async () => {
    const { chain, client } = setup()
    chain.intercept(async (method, _params, next) => {
      if (method !== 'sendTransaction') return undefined
      await next()
      throw new Error('socket hang up')
    })
    const updates: string[] = []
    const [result] = await batchCall(client, [transfer()], { ...fast, onUpdate: (r) => updates.push(`${r.status}:${r.error ?? ''}`) })
    expect(result?.status).toBe('confirmed')
    expect(updates[0]).toContain('sent:broadcast not acknowledged')
    expect(chain.sol(R1)).toBe(SOL)
  })

  it('查确认状态时节点暂时出错：下一轮再查', async () => {
    const { chain, client } = setup()
    let failures = 2
    chain.intercept((method) => {
      if (method === 'getSignatureStatuses' && failures-- > 0) throw new Error('fetch failed')
      return undefined
    })
    const [result] = await batchCall(client, [transfer()], fast)
    expect(result?.status).toBe('confirmed')
  })

  it('onUpdate 回调抛错不会打断发送', async () => {
    const { chain, client } = setup()
    const results = await batchCall(client, [transfer(A, R1), transfer(A, R2)], {
      ...fast,
      onUpdate: () => {
        throw new Error('ui bug')
      },
    })
    expect(results.map((r) => r.status)).toEqual(['confirmed', 'confirmed'])
    expect(chain.sol(R2)).toBe(SOL)
  })

  it('计算单元超限拆成两笔、前半复核手续费失败（不继续）：后半跳过', async () => {
    const { chain, client } = setup({ systemTransferUnits: 600_000 })
    chain.setSol(B.address, 1_000_000n)
    const results = await batchCall(client, [transfer(B, R1, 0n), transfer(B, R2, 0n), transfer(B, R3, 0n)], { ...fast, priorityFee: 1_000_000 })
    expect(results.map((r) => r.status)).toEqual(['failed', 'failed', 'skipped'])
    expect(results[0]?.error).toBe('insufficient SOL for the transaction fee')
  })

  it('同一笔交易里第一个调用就失败（不继续）：整批都不发', async () => {
    const { chain, client } = setup()
    const results = await batchCall(client, [transfer(A, R1, 100n * SOL), transfer(A, R2)], fast)
    expect(results.map((r) => r.status)).toEqual(['failed', 'skipped'])
    expect(chain.sent).toHaveLength(0)
  })

  it('超出大小的调用允许继续时：只有它失败，后面的照常发送', async () => {
    const { client } = setup()
    const huge = { programId: SYSTEM_PROGRAM_ID, keys: [{ pubkey: A.address, isSigner: true, isWritable: true }], data: new Uint8Array(1300) }
    const results = await batchCall(client, [{ from: A.secretKey, instructions: huge }, transfer()], { ...fast, continueOnError: true })
    expect(results.map((r) => r.status)).toEqual(['failed', 'confirmed'])
  })

  it('发出后立刻取消：不等确认', async () => {
    const { client } = setup({ landAfterPolls: 1000 })
    const controller = new AbortController()
    const [result] = await batchCall(client, [transfer()], { ...fast, signal: controller.signal, onUpdate: (r) => r.status === 'sent' && controller.abort() })
    expect(result?.status).toBe('sent')
  })

  it("确认级别：processed 不算确认；commitment 'finalized' 时等到 finalized", async () => {
    // 交易在轮询过程中上链（第二次查询时），才能看到 processed → confirmed → finalized 的推进
    const { chain, client } = setup({ progression: { finalizeAfter: 3 }, landAfterPolls: 1 })
    const polls: string[] = []
    chain.intercept(async (method, _params, next) => {
      if (method !== 'getSignatureStatuses') return undefined
      const res = (await next()) as { value: Array<{ confirmationStatus: string } | null> }
      polls.push(res.value[0]?.confirmationStatus ?? 'none')
      return res
    })
    const [confirmed] = await batchCall(client, [transfer(A, R1)], fast)
    expect(confirmed?.status).toBe('confirmed')
    expect(polls).toEqual(['none', 'processed', 'confirmed'])
    polls.length = 0
    const [finalized] = await batchCall(client, [transfer(A, R2)], { ...fast, commitment: 'finalized' })
    expect(finalized?.status).toBe('confirmed')
    expect(polls).toEqual(['none', 'processed', 'confirmed', 'confirmed', 'confirmed', 'finalized'])
  })

  it('付款方扣完手续费会低于免租下限：交易被拒（失败，不发送）', async () => {
    const { chain, client } = setup()
    chain.setSol(B.address, RENT_EXEMPT_MIN + 3000n) // 扣 5000 手续费后低于免租下限
    const [result] = await batchCall(client, [transfer(B, R1, 0n)], fast)
    expect(result?.status).toBe('failed')
    expect(result?.error).toContain('rent-exempt')
    expect(chain.sent).toHaveLength(0)
  })

  it('新建账户时付款方付租金（feePayer 的余额变化）', async () => {
    const { chain, client } = setup()
    await batchTransfer(client, A.secretKey, [{ to: R1, amount: 1n, token: MINT }], { ...fast, feePayer: GAS.secretKey })
    expect(chain.sol(GAS.address)).toBe(10n * SOL - TOKEN_ACCOUNT_RENT - 10_000n)
  })
})
