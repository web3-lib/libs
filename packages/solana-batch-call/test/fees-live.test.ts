/**
 * 手续费估算连主网（只模拟），默认跳过：`LIVE=1 NODE_USE_ENV_PROXY=1 npx vitest run test/fees-live.test.ts`
 * - SOLANA_RPC：自己的节点；默认官方节点（关闭批量合并）
 */
import { describe, expect, it } from 'vitest'

import { HttpRpc, SolanaClient, TOKEN_PROGRAM_ID, getAssociatedTokenAddress } from '../src/index.js'
import { estimateCost, estimateFees } from '../src/subpaths/fees.js'
import { createAssociatedTokenAccountIdempotent, systemTransfer } from '../src/subpaths/write.js'
import { keypair } from './fakeSolana.js'

const live = process.env.LIVE ? describe : describe.skip
const client = new SolanaClient(new HttpRpc(process.env.SOLANA_RPC ?? 'https://api.mainnet-beta.solana.com', { batch: false, timeout: 30_000 }), { cluster: 'mainnet' })

const PAYER = '5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9' // 余额很多的普通钱包
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
const RAYDIUM_SOL_USDC = '58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2'
const JUPITER = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4'

live('手续费估算（Solana 主网）', { timeout: 180_000 }, () => {
  it('三档优先费：不递减；热门池子的高于全网', async () => {
    const [global, pool] = await Promise.all([estimateFees(client), estimateFees(client, { accounts: [RAYDIUM_SOL_USDC] })])
    console.log({ global, pool })
    for (const f of [global, pool]) {
      expect(f.slots).toBeGreaterThan(100)
      expect(BigInt(f.slow) <= BigInt(f.normal) && BigInt(f.normal) <= BigInt(f.fast)).toBe(true)
    }
    expect(BigInt(pool.fast)).toBeGreaterThanOrEqual(BigInt(global.fast))
  })

  it('新建 ATA：押金等于 165 字节的免租额；转 SOL 给新地址不算押金', async () => {
    const owner = keypair(Date.now() % 250).address
    const ata = getAssociatedTokenAddress(owner, USDC, TOKEN_PROGRAM_ID)
    const rent = await client.request<number>('getMinimumBalanceForRentExemption', [165])
    const cost = await estimateCost(client, { feePayer: PAYER, instructions: [createAssociatedTokenAccountIdempotent(PAYER, ata, owner, USDC, TOKEN_PROGRAM_ID)] }, { priorityFee: 1000 })
    console.log(cost)
    expect(cost.createdAccounts).toEqual([{ address: ata, owner: TOKEN_PROGRAM_ID, space: 165, rent: String(rent) }])
    expect(cost.computeUnitLimit).toBe(Math.ceil(cost.computeUnits * 1.1) + 1000)
    expect(BigInt(cost.fee)).toBe(5000n + (1000n * BigInt(cost.computeUnitLimit) + 999_999n) / 1_000_000n)
    expect(BigInt(cost.total)).toBe(BigInt(cost.fee) + BigInt(rent))

    const transfer = await estimateCost(client, { feePayer: PAYER, instructions: systemTransfer(PAYER, owner, 10_000_000n) })
    expect([transfer.rent, transfer.createdAccounts]).toEqual(['0', []])
  })

  it('真实的 v0 交易（带地址查找表）：算出的手续费和链上实际扣的相同', async () => {
    const signatures = await client.request<Array<{ signature: string; err: unknown }>>('getSignaturesForAddress', [JUPITER, { limit: 25 }])
    let matched = 0
    for (const { signature, err } of signatures) {
      if (err || matched >= 2) continue
      const tx = await client.request<{ transaction: [string, string]; version: number | 'legacy'; meta: { fee: number } } | null>('getTransaction', [
        signature,
        { encoding: 'base64', maxSupportedTransactionVersion: 1, commitment: 'confirmed' },
      ])
      if (!tx || tx.version !== 0) continue
      // 状态变了的交易（如套利、价格已经变了）重新模拟会失败：跳过
      const cost = await estimateCost(client, { transaction: tx.transaction[0] }).catch(() => null)
      if (!cost) continue
      expect(cost.fee).toBe(String(tx.meta.fee))
      matched++
    }
    expect(matched).toBeGreaterThan(0)
  })
})
