/** 交易模拟：余额 / 授权变化、错误解码、警告、指令解码，模拟节点，不连网络 */
import { sha256 } from '@noble/hashes/sha2.js'
import { base64 } from '@scure/base'
import { describe, expect, it } from 'vitest'

import { SYSTEM_PROGRAM_ID, SolanaClient, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, decodeAddress } from '../src/index.js'
import { decodeInstruction, failureText, simulate } from '../src/subpaths/simulate.js'
import { systemTransfer } from '../src/subpaths/write.js'
import { createMockNode, mintData, tokenAccountData, type MockAccount } from './mock.js'
import { keypair } from './fakeSolana.js'

const WALLET = keypair(1).address
const OTHER = keypair(2).address
const MINT = keypair(3).address
const TOKEN_ACCOUNT = keypair(4).address
const SPENDER = keypair(5).address

interface Sim {
  err?: unknown
  logs?: string[]
  /** 模拟后的账户 */
  post?: Record<string, MockAccount | null>
}

function node(pre: Record<string, MockAccount>, sim: Sim) {
  const base = createMockNode({ accounts: { [MINT]: { owner: TOKEN_2022_PROGRAM_ID, data: mintData({ decimals: 6, metadata: { name: 'Test', symbol: 'TST', uri: '' } }) }, ...pre } })
  return {
    ...base,
    async request<T>(method: string, params: readonly unknown[] = []): Promise<T> {
      if (method !== 'simulateTransaction') return base.request<T>(method, params)
      const addresses = (params[1] as { accounts: { addresses: string[] } }).accounts.addresses
      const accounts = addresses.map((a) => {
        const post = sim.post?.[a]
        return post ? { lamports: Number(post.lamports ?? 0n), owner: post.owner, data: [base64.encode(post.data ?? new Uint8Array()), 'base64'], executable: false } : null
      })
      return { context: { slot: 1 }, value: { err: sim.err ?? null, logs: sim.logs ?? [], unitsConsumed: 1234, accounts: sim.err ? null : accounts } } as T
    },
  }
}

const approveIx = (amount: bigint) => {
  const data = new Uint8Array(9)
  data[0] = 4
  new DataView(data.buffer).setBigUint64(1, amount, true)
  return {
    programId: TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: TOKEN_ACCOUNT, isSigner: false, isWritable: true },
      { pubkey: SPENDER, isSigner: false, isWritable: false },
      { pubkey: WALLET, isSigner: true, isWritable: false },
    ],
    data,
  }
}

/** 代币账户数据，可带 delegate */
function tokenData(amount: bigint, delegate?: { key: string; amount: bigint }) {
  const data = tokenAccountData(MINT, WALLET, amount)
  data[108] = 1
  if (delegate) {
    const view = new DataView(data.buffer)
    view.setUint32(72, 1, true)
    data.set(decodeAddress(delegate.key), 76)
    view.setBigUint64(121, delegate.amount, true)
  }
  return data
}

describe('simulate', () => {
  it('SOL 转账：余额变化不含手续费，新地址给警告', async () => {
    const client = new SolanaClient(node({ [WALLET]: { owner: SYSTEM_PROGRAM_ID, lamports: 10n ** 9n } }, { post: { [WALLET]: { owner: SYSTEM_PROGRAM_ID, lamports: 10n ** 9n - 1_000_000n - 5000n }, [OTHER]: { owner: SYSTEM_PROGRAM_ID, lamports: 1_000_000n } } }))
    const sim = await simulate(client, { owner: WALLET, instructions: [systemTransfer(WALLET, OTHER, 1_000_000n)] })
    expect(sim).toMatchObject({ success: true, fee: '5000', gasUsed: '1234', version: 'legacy', decoded: { type: 'transfer', summary: expect.stringContaining('Send 0.001 SOL') } })
    expect(sim.balanceChanges).toEqual([{ address: WALLET, asset: 'native', symbol: 'SOL', decimals: 9, delta: '-1000000', formatted: '-0.001' }])
    expect(sim.warnings.map((w) => w.code)).toEqual(['new-recipient'])
  })

  it('Approve：delegate 变化、无限额度是 danger', async () => {
    const client = new SolanaClient(node({ [WALLET]: { owner: SYSTEM_PROGRAM_ID, lamports: 10n ** 9n }, [TOKEN_ACCOUNT]: { owner: TOKEN_PROGRAM_ID, data: tokenData(100n) } }, { post: { [WALLET]: { owner: SYSTEM_PROGRAM_ID, lamports: 10n ** 9n - 5000n }, [TOKEN_ACCOUNT]: { owner: TOKEN_PROGRAM_ID, data: tokenData(100n, { key: SPENDER, amount: 2n ** 64n - 1n }) } } }))
    const sim = await simulate(client, { owner: WALLET, instructions: [approveIx(2n ** 64n - 1n)] })
    expect(sim.approvalChanges).toMatchObject([{ kind: 'delegate-set', account: TOKEN_ACCOUNT, mint: MINT, delegate: SPENDER, unlimited: true }])
    expect(sim.warnings).toContainEqual(expect.objectContaining({ code: 'unlimited-delegate', severity: 'danger' }))
    expect(sim.decoded.type).toBe('approve')
    expect(sim.balanceChanges).toEqual([])
  })

  it('账户所有权被改走：SetAuthority（AccountOwner）', async () => {
    const stolen = tokenAccountData(MINT, OTHER, 100n)
    stolen[108] = 1
    const client = new SolanaClient(node({ [WALLET]: { owner: SYSTEM_PROGRAM_ID, lamports: 10n ** 9n }, [TOKEN_ACCOUNT]: { owner: TOKEN_PROGRAM_ID, data: tokenData(100n) } }, { post: { [WALLET]: { owner: SYSTEM_PROGRAM_ID, lamports: 10n ** 9n - 5000n }, [TOKEN_ACCOUNT]: { owner: TOKEN_PROGRAM_ID, data: stolen } } }))
    const ix = { programId: TOKEN_PROGRAM_ID, keys: [{ pubkey: TOKEN_ACCOUNT, isSigner: false, isWritable: true }, { pubkey: WALLET, isSigner: true, isWritable: false }], data: new Uint8Array([6, 2, 1, ...decodeAddress(OTHER)]) }
    const sim = await simulate(client, { owner: WALLET, instructions: [ix] })
    expect(sim.approvalChanges).toContainEqual(expect.objectContaining({ kind: 'authority-changed', authorityType: 'AccountOwner', authority: OTHER, previousAuthority: WALLET }))
    expect(sim.warnings).toContainEqual(expect.objectContaining({ code: 'authority-changed', severity: 'danger' }))
    expect(sim.balanceChanges[0]).toMatchObject({ asset: MINT, symbol: 'TST', delta: '-100' })
  })

  it('失败：解码程序错误码和日志；还需要别的签名者时给警告', async () => {
    const client = new SolanaClient(node({ [WALLET]: { owner: SYSTEM_PROGRAM_ID, lamports: 10n ** 9n } }, { err: { InstructionError: [1, { Custom: 1 }] }, logs: [`Program ${TOKEN_PROGRAM_ID} invoke [1]`, `Program ${TOKEN_PROGRAM_ID} failed: custom program error: 0x1`] }))
    const sim = await simulate(client, { owner: WALLET, instructions: [{ programId: TOKEN_PROGRAM_ID, keys: [{ pubkey: OTHER, isSigner: true, isWritable: false }], data: new Uint8Array([9]) }] })
    expect(sim.success).toBe(false)
    expect(sim.error).toMatch(/InsufficientFunds \(0x1\)/)
    expect(sim.warnings.map((w) => w.code)).toEqual(expect.arrayContaining(['simulation-failed', 'unexpected-signer']))
    expect(sim.balanceChanges).toEqual([])
  })
})

describe('指令解码和错误', () => {
  it('Anchor 指令名按 discriminator 识别', () => {
    const disc = sha256(new TextEncoder().encode('global:swap_v2')).slice(0, 8)
    const orca = decodeInstruction(0, 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc', [], new Uint8Array([...disc, 0]))
    expect(orca).toMatchObject({ type: 'swap', protocol: 'Orca', method: 'swap_v2' })
    expect(decodeInstruction(0, 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc', [], new Uint8Array(8))).toMatchObject({ type: 'contract', protocol: 'Orca' })
    expect(decodeInstruction(1, WALLET, [], new Uint8Array(1))).toMatchObject({ type: 'unknown', program: null })
  })

  it('数据格式不对不抛错', () => {
    expect(decodeInstruction(0, TOKEN_PROGRAM_ID, [], new Uint8Array([3, 1]))).toMatchObject({ type: 'contract' })
  })

  it('Anchor 日志里的错误名优先', () => {
    const ix = decodeInstruction(2, 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4', [], new Uint8Array(1))
    const logs = ['Program log: AnchorError thrown in programs/jupiter/src/lib.rs:1. Error Code: SlippageToleranceExceeded. Error Number: 6001. Error Message: Slippage tolerance exceeded.']
    expect(failureText({ InstructionError: [2, { Custom: 6001 }] }, logs, [ix, ix, ix])).toBe('instruction 2 (Jupiter Aggregator v6) failed: SlippageToleranceExceeded (6001): Slippage tolerance exceeded')
    expect(failureText({ InstructionError: [0, { Custom: 6001 }] }, [`Program JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4 failed: custom program error: 0x1771`], [ix])).toContain('SlippageToleranceExceeded (0x1771)')
    expect(failureText('InsufficientFundsForFee', [], [])).toMatch(/fee/)
  })
})
