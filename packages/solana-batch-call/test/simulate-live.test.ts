/**
 * 交易模拟连主网，默认跳过：`LIVE=1 NODE_USE_ENV_PROXY=1 npx vitest run test/simulate-live.test.ts`
 * - SOLANA_RPC：自己的节点；默认内置公共节点（publicnode：simulateTransaction 最多返回 10 个账户）
 * 用交易所热钱包（有 SOL 和 USDC，不需要私钥，不验签名）的身份模拟自己构建的交易，再用 Jupiter 最近的一笔真实 v0 交易（带地址查找表）
 */
import { describe, expect, it } from 'vitest'

import { getAssociatedTokenAddress } from '../src/address.js'
import { NATIVE_MINT, SolanaClient, TOKEN_PROGRAM_ID } from '../src/index.js'
import { simulate } from '../src/subpaths/simulate.js'
import { buildSwap } from '../src/subpaths/swap.js'
import { createAssociatedTokenAccountIdempotent, systemTransfer, transferChecked } from '../src/subpaths/write.js'
import type { Instruction } from '../src/write/transaction.js'

const live = process.env.LIVE ? describe : describe.skip
const client = new SolanaClient(process.env.SOLANA_RPC)

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
/** 有 SOL 和 USDC 的系统账户（Coinbase 热钱包） */
const WHALE = 'H8sMJSCQxfKiFTCfDR3DUMLPwcRbM61LGFJ8N4dK3WjS'
/** 没人用过的地址 */
const FRESH = 'Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KQMnue'
const JUPITER = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4'

const approve = (account: string, delegate: string, owner: string, amount: bigint): Instruction => {
  const data = new Uint8Array(9)
  data[0] = 4
  new DataView(data.buffer).setBigUint64(1, amount, true)
  return {
    programId: TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: account, isSigner: false, isWritable: true },
      { pubkey: delegate, isSigner: false, isWritable: false },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
    data,
  }
}

live('交易模拟（Solana 主网）', { timeout: 300_000 }, () => {
  it('SOL 转账给新地址', async () => {
    const sim = await simulate(client, { owner: WHALE, instructions: [systemTransfer(WHALE, FRESH, 1_000_000n)] })
    console.log(JSON.stringify({ ...sim, logs: undefined, decoded: { ...sim.decoded, instructions: undefined } }, null, 1))
    expect(sim.success).toBe(true)
    expect(sim.balanceChanges).toMatchObject([{ asset: 'native', delta: '-1000000', symbol: 'SOL' }])
    expect(sim.decoded.type).toBe('transfer')
    expect(sim.warnings.map((w) => w.code)).toContain('new-recipient')
  })

  it('USDC 转账（自动建 ATA）、余额不够时给出原因', async () => {
    const dest = getAssociatedTokenAddress(FRESH, USDC, TOKEN_PROGRAM_ID)
    const source = getAssociatedTokenAddress(WHALE, USDC, TOKEN_PROGRAM_ID)
    const make = (amount: bigint) => [createAssociatedTokenAccountIdempotent(WHALE, dest, FRESH, USDC, TOKEN_PROGRAM_ID), transferChecked(source, USDC, dest, WHALE, amount, 6, TOKEN_PROGRAM_ID)]
    const ok = await simulate(client, { owner: WHALE, instructions: make(1_000_000n) })
    expect(ok.success).toBe(true)
    expect(ok.balanceChanges.find((c) => c.asset === USDC)).toMatchObject({ delta: '-1000000', symbol: 'USDC', formatted: '-1' })
    expect(ok.decoded.type).toBe('transfer')
    const bad = await simulate(client, { owner: WHALE, instructions: make(10n ** 15n) })
    console.log(bad.error)
    expect(bad.success).toBe(false)
    expect(bad.error).toMatch(/InsufficientFunds|insufficient/i)
  })

  it('兑换（本库的 buildSwap 输出）', async () => {
    const plan = await buildSwap(client, WHALE, { tokenIn: NATIVE_MINT, tokenOut: USDC, amountIn: 100_000_000n })
    const sim = await simulate(client, plan, { prices: true })
    console.log(sim.decoded.summary, sim.balanceChanges, sim.warnings)
    expect(sim.success).toBe(true)
    expect(sim.decoded.type).toBe('swap')
    expect(sim.balanceChanges.find((c) => c.asset === 'native')?.delta.startsWith('-')).toBe(true)
    expect(BigInt(sim.balanceChanges.find((c) => c.asset === USDC)?.delta ?? 0)).toBeGreaterThan(0n)
    expect(sim.balanceChanges.every((c) => typeof c.usd === 'number')).toBe(true)
  })

  it('授权：Approve 无限额度', async () => {
    const source = getAssociatedTokenAddress(WHALE, USDC, TOKEN_PROGRAM_ID)
    const sim = await simulate(client, { owner: WHALE, instructions: [approve(source, FRESH, WHALE, 2n ** 64n - 1n)] })
    expect(sim.success).toBe(true)
    expect(sim.approvalChanges).toMatchObject([{ kind: 'delegate-set', delegate: FRESH, unlimited: true, mint: USDC }])
    expect(sim.warnings.some((w) => w.code === 'unlimited-delegate' && w.severity === 'danger')).toBe(true)
    expect(sim.decoded.type).toBe('approve')
  })

  it('Jupiter 最近的真实 v0 交易（地址查找表）', async () => {
    const sigs = await client.request<Array<{ signature: string; err: unknown }>>('getSignaturesForAddress', [JUPITER, { limit: 15 }])
    let sim: Awaited<ReturnType<typeof simulate>> | undefined
    for (const { signature } of sigs.filter((s) => !s.err)) {
      const tx = await client.request<{ transaction: [string, string] } | null>('getTransaction', [signature, { encoding: 'base64', maxSupportedTransactionVersion: 1 }])
      // v1 格式的交易（主网约三成）不支持，跳过
      const candidate = await simulate(client, tx?.transaction[0] as string).catch(() => null)
      if (!candidate) continue
      // 顶层直接调用 Jupiter 的（其他的是别的程序通过 CPI 调用）
      if (candidate.version === 0 && candidate.decoded.instructions.some((ix) => ix.protocol === 'Jupiter')) {
        sim = candidate
        break
      }
    }
    if (!sim) throw new Error('no v0 Jupiter transaction found')
    console.log(sim.version, sim.success, sim.error, sim.decoded.summary, sim.balanceChanges, sim.warnings.map((w) => w.code))
    expect(sim.version).toBe(0)
    expect(sim.decoded.instructions.some((ix) => ix.protocol === 'Jupiter')).toBe(true)
  })
})
