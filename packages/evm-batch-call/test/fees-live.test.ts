/**
 * 手续费估算连主网（只预估，不发送），默认跳过：`LIVE=1 NODE_USE_ENV_PROXY=1 npx vitest run test/fees-live.test.ts`
 */
import { Interface } from 'ethers'
import { describe, expect, it } from 'vitest'

import { Provider, TRON_CHAIN_ID, toTronAddress } from '../src/index.js'
import { estimateCost, estimateFees } from '../src/subpaths/fees.js'

const live = process.env.LIVE ? describe : describe.skip
const erc20 = new Interface(['function transfer(address to, uint256 amount) returns (bool)'])

/** 持有 USDC / USDT 的地址（2026-10，Binance 等的热钱包），转 1 个最小单位用来预估 */
const CASES = [
  { chainId: 1, from: '0x28C6c06298d514Db089934071355E5743bf21d60', token: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', l1: false },
  { chainId: 8453, from: '0x3304E22DDaa22bCdC5fCa2269b418046aE7b566A', token: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', l1: true },
  { chainId: 56, from: '0xF977814e90dA44bFA03b6295A0616a897441aceC', token: '0x55d398326f99059fF775485246999027B3197955', l1: false },
]

for (const c of CASES) {
  live(`手续费（${c.chainId}）`, { timeout: 60_000 }, () => {
    it('三档费用不递减；转账的手续费 = gas × 价格（+ L1 数据费）', async () => {
      const provider = new Provider(c.chainId)
      const fees = await estimateFees(provider)
      const per = (l: typeof fees.slow) => BigInt('gasPrice' in l ? l.gasPrice : l.maxFeePerGas)
      expect(per(fees.slow) <= per(fees.normal) && per(fees.normal) <= per(fees.fast)).toBe(true)
      if (c.chainId === 1) expect(fees.type).toBe('eip1559')
      const data = erc20.encodeFunctionData('transfer', ['0x000000000000000000000000000000000000dEaD', 1n])
      const cost = await estimateCost(provider, { from: c.from, to: c.token, data }, { fees })
      expect(cost.type).toBe('evm')
      if (cost.type !== 'evm') return
      expect(Number(cost.gasLimit)).toBeGreaterThan(21_000)
      expect(BigInt(cost.fee)).toBe(BigInt(cost.gasLimit) * BigInt(cost.gasPrice))
      expect(BigInt(cost.total)).toBe(BigInt(cost.fee) + BigInt(cost.l1Fee))
      expect(BigInt(cost.l1Fee) > 0n).toBe(c.l1)
      expect(BigInt(cost.maxFee) >= BigInt(cost.fee)).toBe(true)
    })
  })
}

const randomTron = () => toTronAddress(`0x${[...crypto.getRandomValues(new Uint8Array(20))].map((b) => b.toString(16).padStart(2, '0')).join('')}`)

live('手续费（Tron）', { timeout: 60_000 }, () => {
  it('USDT 转账：模拟能量，按发送者剩余资源算烧多少 TRX；转 TRX 给没激活的地址算激活费', async () => {
    const provider = new Provider(TRON_CHAIN_ID.mainnet)
    const usdt = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'
    const data = erc20.encodeFunctionData('transfer', ['0x000000000000000000000000000000000000dEaD', 0n])
    // 有质押能量 / 带宽的地址（2026-10）：资源够，不烧 TRX
    const staked = await estimateCost(provider, { from: 'TW7igRFaUUFWNuwsuVw1xiMQcDf4pf7SWe', to: usdt, data })
    // 新地址：没有任何资源，能量和带宽都按价格烧
    const empty = await estimateCost(provider, { from: randomTron(), to: usdt, data })
    if (staked.type !== 'tron' || empty.type !== 'tron') throw new Error('expected tron estimates')
    expect(staked.energy).toBeGreaterThan(10_000)
    expect(empty.energy).toBeGreaterThan(10_000)
    expect(BigInt(empty.energyBurn)).toBe(BigInt(empty.energy) * BigInt(empty.energyPrice))
    expect(BigInt(empty.bandwidthBurn)).toBe(BigInt(empty.bandwidth) * BigInt(empty.bandwidthPrice))
    expect(BigInt(empty.total)).toBe(BigInt(empty.energyBurn) + BigInt(empty.bandwidthBurn))
    expect(BigInt(staked.total) < BigInt(empty.total)).toBe(true)
    // 转 TRX 给没激活的地址：激活费（≥ 1 TRX）
    const fresh = await estimateCost(provider, { from: 'TW7igRFaUUFWNuwsuVw1xiMQcDf4pf7SWe', to: randomTron(), value: 1n })
    expect(fresh.type === 'tron' && fresh.activates && BigInt(fresh.bandwidthBurn) >= 1_000_000n).toBe(true)
  })
})
