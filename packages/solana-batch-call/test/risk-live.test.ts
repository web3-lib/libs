/**
 * 代币风险检查连主网，默认跳过：`LIVE=1 NODE_USE_ENV_PROXY=1 npx vitest run test/risk-live.test.ts`
 * - SOLANA_RPC：自己的节点；默认官方节点
 */
import { describe, expect, it } from 'vitest'

import { HttpRpc, NATIVE_MINT, SolanaClient } from '../src/index.js'
import { tokenRisks, tradeChecks } from '../src/subpaths/risk.js'

const live = process.env.LIVE ? describe : describe.skip
const client = new SolanaClient(new HttpRpc(process.env.SOLANA_RPC ?? 'https://api.mainnet-beta.solana.com', { batch: false, retries: 5 }))

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
/** Token-2022：永久授权、转账 hook、保密转账、转账手续费扩展（费率 0） */
const PYUSD = '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo'
/** Token-2022，转账手续费 2.69% */
const BERN = 'CKfatsPMUf8SkiURsDXs7eK6GWb4Jsd6UDbs7twMCWxo'
const JUP = 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN'
const MISSING = '3MU8CwCqv82fAvufNDY3vwvfCGqSUMbq7Qexr4hofXG1'
/** 有 SOL 的系统账户（Coinbase 热钱包） */
const WHALE = 'H8sMJSCQxfKiFTCfDR3DUMLPwcRbM61LGFJ8N4dK3WjS'

live('代币风险（Solana 主网）', { timeout: 300_000 }, () => {
  it('mint 权限和 Token-2022 扩展', async () => {
    const risks = await tokenRisks(client, [USDC, PYUSD, BERN, JUP, NATIVE_MINT, MISSING])
    console.table(risks.map((r) => ({ mint: r.mint.slice(0, 6), program: r.program, flags: r.flags.join(' '), fee: r.transferFee?.basisPoints ?? '-' })))
    const [usdc, pyusd, bern, jup, sol, missing] = risks
    expect(usdc).toMatchObject({ exists: true, program: 'spl-token', decimals: 6 })
    expect(usdc?.flags).toEqual(['mintable', 'freezable'])
    expect(pyusd?.program).toBe('token-2022')
    expect(pyusd?.permanentDelegate).toBeTruthy()
    expect(pyusd?.flags).toEqual(expect.arrayContaining(['mintable', 'freezable', 'permanent-delegate', 'transfer-hook', 'confidential-transfer', 'fee-changeable']))
    expect(pyusd?.flags).not.toContain('transfer-fee') // 扩展在，费率是 0
    expect(pyusd?.transferFee?.basisPoints).toBe(0)
    expect(bern?.transferFee?.basisPoints).toBeGreaterThan(0)
    expect(bern?.flags).toContain('transfer-fee')
    expect(jup?.flags).toEqual([])
    expect(sol).toMatchObject({ mintAuthority: null, freezeAuthority: null, flags: [] })
    expect(missing).toMatchObject({ exists: false, flags: ['not-found'] })
  })

  it('买入再卖出（模拟）', async () => {
    const checks = await tradeChecks(client, [USDC, JUP, BERN, MISSING], { owner: WHALE, amountFormatted: '0.2' })
    console.table(checks.map((c) => ({ mint: c.mint.slice(0, 6), stage: c.stage, loss: c.roundTripLoss, bought: c.bought, sold: c.sold, route: c.buyRoute?.map((r) => r.protocol).join('>'), flags: c.flags.join(' '), error: c.error?.slice(0, 60) })))
    const [usdc, jup, bern, missing] = checks
    for (const c of [usdc, jup]) {
      expect(c).toMatchObject({ stage: 'ok', honeypot: false, flags: [] })
      expect(c?.roundTripLoss).toBeLessThan(0.02)
    }
    // BERN 有 2.69% 的转账手续费，能买能卖
    expect(bern).toMatchObject({ stage: 'ok', honeypot: false })
    expect(missing).toMatchObject({ stage: 'no-pool', flags: ['no-pool'] })
  })
})
