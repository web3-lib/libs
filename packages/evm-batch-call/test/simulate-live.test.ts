/**
 * 交易模拟连主网（以太坊、Tron 的公共节点），默认跳过：`LIVE=1 NODE_USE_ENV_PROXY=1 npx vitest run test/simulate-live.test.ts`
 */
import { Interface, Wallet } from 'ethers'
import { describe, expect, it } from 'vitest'

import { NATIVE_TOKEN, Provider, TRON_CHAIN_ID } from '../src/index.js'
import { buildSwap } from '../src/subpaths/swap.js'
import { assertSimulation, simulate, simulateBatch } from '../src/subpaths/simulate.js'

const live = process.env.LIVE ? describe : describe.skip

const USDT = '0xdAC17F958D2ee523a2206206994597C13D831ec7'
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'
const HOLDER = '0xF977814e90dA44bFA03b6295A0616a897441aceC' // 持有大量 USDT / USDC / ETH 的地址
const token = new Interface(['function transfer(address to, uint256 amount) returns (bool)', 'function approve(address spender, uint256 amount) returns (bool)', 'function deposit() payable', 'function withdraw(uint256)'])
const other = Wallet.createRandom().address

live('交易模拟（以太坊）', { timeout: 180_000 }, () => {
  const provider = new Provider(1, ['https://ethereum-rpc.publicnode.com', 'https://eth.drpc.org'])

  it('USDT 转账：资产变化、解码', async () => {
    const sim = await simulate(provider, { to: USDT, data: token.encodeFunctionData('transfer', [other, 1_500_000n]) }, { from: HOLDER })
    expect(sim.success).toBe(true)
    expect(sim.mode).toBe('simulateV1')
    expect(sim.balanceChanges).toMatchObject([{ asset: USDT.toLowerCase(), symbol: 'USDT', delta: '-1500000', formatted: '-1.5' }])
    expect(sim.decoded).toMatchObject({ type: 'transfer', method: 'transfer' })
    expect(sim.decoded.summary).toBe('Send 1.5 USDT')
    expect(BigInt(sim.fee ?? 0)).toBeGreaterThan(0n)
  })

  it('revert 原因解码', async () => {
    const sim = await simulate(provider, { to: USDC, data: token.encodeFunctionData('transfer', [other, 10n ** 30n]) }, { from: HOLDER })
    expect(sim.success).toBe(false)
    expect(sim.error).toMatch(/exceeds balance|revert/i)
    expect(sim.warnings.some((w) => w.code === 'reverted')).toBe(true)
    await expect(assertSimulation(sim)).rejects.toThrow(/Simulation failed/)
  })

  it('无限授权给陌生地址：授权变化和提示', async () => {
    const sim = await simulate(provider, { to: USDC, data: token.encodeFunctionData('approve', [other, 2n ** 256n - 1n]) }, { from: HOLDER })
    expect(sim.approvalChanges).toMatchObject([{ type: 'erc20', unlimited: true, symbol: 'USDC', spender: other.toLowerCase() }])
    expect(sim.warnings.map((w) => w.code)).toEqual(expect.arrayContaining(['unlimited-approval', 'approve-to-eoa']))
    expect(sim.decoded.type).toBe('approve')
  })

  it('WETH 存入：主币转出 + WETH 收到（Deposit 事件）', async () => {
    const sim = await simulate(provider, { to: WETH, data: token.encodeFunctionData('deposit'), value: 10n ** 18n }, { from: HOLDER })
    const by = Object.fromEntries(sim.balanceChanges.map((c) => [c.symbol, c.formatted]))
    expect(by).toEqual({ ETH: '-1', WETH: '1' })
  })

  it('没有代码的地址：no-code 提示；状态覆盖给余额', async () => {
    const sim = await simulate(provider, { to: other, data: '0x12345678', value: 10n ** 18n }, { from: Wallet.createRandom().address, stateOverrides: {} })
    expect(sim.warnings.map((w) => w.code)).toContain('no-code')
    const funded = Wallet.createRandom().address
    const ok = await simulate(provider, { to: other, value: 10n ** 18n }, { from: funded, stateOverrides: { [funded]: { balance: '0x56bc75e2d63100000' } } })
    expect(ok.success).toBe(true)
    expect(ok.balanceChanges[0]).toMatchObject({ asset: 'native', formatted: '-1' })
  })

  it('兑换：buildSwap 的 approve + swap 一次模拟，状态延续', async () => {
    const plan = await buildSwap(provider, HOLDER, { tokenIn: USDT, tokenOut: NATIVE_TOKEN, amountInFormatted: '1000' })
    expect(plan.transactions.length).toBe(2)
    const batch = await simulateBatch(provider, plan, { from: HOLDER, usd: true })
    expect(batch.success).toBe(true)
    const [approve, swap] = batch.results
    expect(approve?.decoded.type).toBe('approve')
    expect(swap?.decoded.type).toBe('swap')
    const usdt = batch.balanceChanges.find((c) => c.symbol === 'USDT')
    const eth = batch.balanceChanges.find((c) => c.asset === 'native')
    expect(usdt?.formatted).toBe('-1000')
    expect(Number(eth?.formatted)).toBeGreaterThan(0)
    expect(usdt?.usd).toBeCloseTo(-1000, -1)
    expect(swap?.decoded.summary).toMatch(/^Swap 1000 USDT for [\d.]+ ETH/)
    // 精确额度的授权给内置 Router：已知被授权方，不报 unknown-spender
    expect(approve?.warnings.map((w) => w.code)).not.toContain('unknown-spender')
  })

  it('只模拟 swap（没有授权）时 revert 带原因', async () => {
    const plan = await buildSwap(provider, HOLDER, { tokenIn: USDT, tokenOut: NATIVE_TOKEN, amountInFormatted: '1000' })
    const sim = await simulate(provider, plan.transactions[1] as never, { from: HOLDER })
    expect(sim.success).toBe(false)
    expect(sim.error).toBeTruthy()
  })

  it('不支持 eth_simulateV1 时退回 eth_call', async () => {
    const sim = await simulate(provider, { to: USDT, data: token.encodeFunctionData('transfer', [other, 1_500_000n]) }, { from: HOLDER, forceCall: true })
    expect(sim.mode).toBe('eth_call')
    expect(sim.success).toBe(true)
    expect(sim.balanceChanges[0]).toMatchObject({ formatted: '-1.5' })
    expect(sim.warnings.map((w) => w.code)).toContain('no-logs')
  })
})

live('交易模拟（Tron）', { timeout: 120_000 }, () => {
  it('TRC20 转账', async () => {
    const provider = new Provider(TRON_CHAIN_ID.mainnet)
    const iface = new Interface(['function transfer(address to, uint256 amount) returns (bool)'])
    const sim = await simulate(provider, { to: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', data: iface.encodeFunctionData('transfer', ['0x' + '11'.repeat(20), 1_000_000n]) }, { from: 'TNXoiAJ3dct8Fjg4M9fkLFh9S2v9TXc32G' })
    expect(sim.success).toBe(true)
    expect(sim.mode).toBe('tron')
    expect(sim.balanceChanges[0]).toMatchObject({ symbol: 'USDT', formatted: '-1', asset: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t' })
    expect(Number(sim.gasUsed)).toBeGreaterThan(0)
  })
})
