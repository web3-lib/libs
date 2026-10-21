/**
 * 兑换连主网核对（只用 eth_call，不发交易），默认跳过：`LIVE=1 NODE_USE_ENV_PROXY=1 npx vitest run test/swap-live.test.ts`
 *
 * 固定一个区块：按 slippage 0 构建（最少收到 = 报价），在同一个区块上 eth_call 执行兑换交易应当成功；
 * 把交易里的最少收到改成报价 + 1 应当失败——两者合起来说明实际收到的正好等于报价。
 * 卖出代币时用 state override 给发送者设置对 Router 的额度（存储槽位置在测试里探测），发送者是持有这个代币的地址
 */
import { AbiCoder, Interface, JsonRpcProvider, keccak256, toBeHex } from 'ethers'
import { describe, expect, it } from 'vitest'

import { NATIVE_TOKEN, Provider, TRON_CHAIN_ID } from '../src/index.js'
import { buildSwap, type SwapOptions, type SwapPlan } from '../src/subpaths/swap.js'

const live = process.env.LIVE ? describe : describe.skip
const coder = AbiCoder.defaultAbiCoder()
const erc20 = new Interface(['function allowance(address owner, address spender) view returns (uint256)'])

interface Chain {
  chainId: number
  rpc: string
  stable: string
  other: string
  /** 持有 stable 的地址（2026-10） */
  holder: string
  v2: string
  v3: string
}

const CHAINS: Chain[] = [
  {
    chainId: 8453,
    rpc: 'https://base-rpc.publicnode.com',
    stable: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', // USDC
    other: '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf', // cbBTC
    holder: '0x3304E22DDaa22bCdC5fCa2269b418046aE7b566A',
    v2: 'uniswap-v2',
    v3: 'uniswap-v3',
  },
  {
    chainId: 56,
    rpc: 'https://bsc-rpc.publicnode.com',
    stable: '0x55d398326f99059fF775485246999027B3197955', // USDT
    other: '0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82', // CAKE
    holder: '0xF977814e90dA44bFA03b6295A0616a897441aceC',
    v2: 'pancakeswap-v2',
    v3: 'pancakeswap-v3',
  },
]

for (const c of CHAINS) {
  live(`兑换（${c.chainId}，eth_call 核对）`, { timeout: 180_000 }, () => {
    const rpc = new JsonRpcProvider(c.rpc, c.chainId, { staticNetwork: true })
    const provider = new Provider(c.chainId, c.rpc)

    /** ERC20 的 allowance 映射在第几个存储槽（试 0~20） */
    const slots = new Map<string, number>()
    async function allowanceSlot(token: string, owner: string, spender: string): Promise<number> {
      const cached = slots.get(token)
      if (cached !== undefined) return cached
      for (let slot = 0; slot <= 20; slot++) {
        const key = allowanceKey(owner, spender, slot)
        const r = await rpc.send('eth_call', [{ to: token, data: erc20.encodeFunctionData('allowance', [owner, spender]) }, 'latest', { [token]: { stateDiff: { [key]: toBeHex(12345n, 32) } } }])
        if (BigInt(r) === 12345n) {
          slots.set(token, slot)
          return slot
        }
      }
      throw new Error(`allowance slot not found for ${token}`)
    }
    const allowanceKey = (owner: string, spender: string, slot: number) => keccak256(coder.encode(['address', 'bytes32'], [spender, keccak256(coder.encode(['address', 'uint256'], [owner, slot]))]))

    /** 固定区块构建、执行兑换交易；返回计划。最少收到 + 1 时必须失败 */
    async function check(tokenIn: string, tokenOut: string, amountInFormatted: string, options: SwapOptions = {}): Promise<SwapPlan> {
      const block = (await rpc.getBlockNumber()) - 2
      const from = tokenIn === NATIVE_TOKEN ? '0x000000000000000000000000000000000000c0DE' : c.holder
      const plan = await buildSwap(provider, from, { tokenIn, tokenOut, amountInFormatted }, { ...options, slippage: 0, blockTag: block })
      const tx = plan.transactions[plan.transactions.length - 1] as { to: string; data: string; value: string }
      const override: Record<string, unknown> = { [from]: { balance: toBeHex(10n ** 24n) } }
      if (tokenIn !== NATIVE_TOKEN) {
        const slot = await allowanceSlot(tokenIn, from, tx.to)
        override[tokenIn] = { stateDiff: { [allowanceKey(from, tx.to, slot)]: toBeHex(2n ** 255n, 32) } }
      }
      const call = (data: string) => rpc.send('eth_call', [{ from, to: tx.to, data, value: toBeHex(BigInt(tx.value)) }, toBeHex(block), override])
      await call(tx.data)
      const min = BigInt(plan.amountOutMin).toString(16).padStart(64, '0')
      expect(plan.amountOutMin).toBe(plan.amountOut)
      expect(tx.data.includes(min)).toBe(true)
      await expect(call(tx.data.replaceAll(min, (BigInt(plan.amountOutMin) + 1n).toString(16).padStart(64, '0')))).rejects.toThrow()
      return plan
    }

    it('主币 → 稳定币（最好的路线）、稳定币 → 主币（授权 + V3 解包）：收到的正好等于报价', async () => {
      const buy = await check(NATIVE_TOKEN, c.stable, '1')
      expect(buy.transactions.map((t) => t.kind)).toEqual(['swap'])
      const sell = await check(c.stable, NATIVE_TOKEN, '500')
      expect(sell.transactions.map((t) => t.kind)).toEqual(['approve', 'swap'])
    })

    it('两跳（V3 exactInput 的路径编码）和 V2 的三种函数', async () => {
      const plan = await buildSwap(provider, c.holder, { tokenIn: NATIVE_TOKEN, tokenOut: c.other, amountInFormatted: '0.5' }, { protocols: [c.v3], intermediates: [c.stable] })
      const twoHop = plan.routes.find((r) => r.path.length === 3)
      if (!twoHop) throw new Error('no two-hop route')
      expect((await check(NATIVE_TOKEN, c.other, '0.5', { protocols: [c.v3], intermediates: [c.stable], route: twoHop })).route.path.length).toBe(3)
      // V2：主币 → 代币、代币 → 主币、代币 → 代币
      for (const [a, b, amount] of [
        [NATIVE_TOKEN, c.stable, '0.5'],
        [c.stable, NATIVE_TOKEN, '200'],
        [c.stable, c.other, '200'],
      ] as const) {
        expect((await check(a, b, amount, { protocols: [c.v2] })).route.version).toBe('v2')
      }
    })
  })
}

live('兑换（Tron，triggerconstantcontract 核对）', { timeout: 120_000 }, () => {
  it('TRX → USDT、USDT → TRX（SunSwap V2 的 Supporting… 函数）：最少收到 = 报价时成功，+1 时失败', async () => {
    const provider = new Provider(TRON_CHAIN_ID.mainnet)
    // 持有 TRX 和 USDT、已授权过 SunSwap V2 Router 的地址（2026-10，见 approvals-live）
    const owner = 'TW7igRFaUUFWNuwsuVw1xiMQcDf4pf7SWe'
    /** 执行成功为 true、合约 revert 为 false；请求本身失败（限频、网络）时重试 */
    const trigger = async (to: string, data: string, value: string): Promise<boolean> => {
      for (let attempt = 0; ; attempt++) {
        try {
          const res = await fetch('https://api.trongrid.io/wallet/triggerconstantcontract', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ owner_address: owner, contract_address: to, data: data.slice(2), call_value: Number(value), visible: true }),
          })
          const body = (await res.json()) as { result?: { result?: boolean; code?: string; message?: string }; transaction?: { ret?: Array<{ ret?: string }> } }
          if (!res.ok || !body.result) throw new Error(`HTTP ${res.status}`)
          if (body.result.result === true) return body.transaction?.ret?.[0]?.ret !== 'FAILED'
          if (body.result.code === 'CONTRACT_EXE_ERROR' || body.transaction?.ret?.[0]?.ret === 'FAILED') return false
          throw new Error(`${body.result.code ?? 'unknown'} ${body.result.message ?? ''}`)
        } catch (err) {
          if (attempt >= 4) throw err
          await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)))
        }
      }
    }
    for (const [a, b, amount] of [
      [NATIVE_TOKEN, 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', '10'],
      ['TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', NATIVE_TOKEN, '1'],
    ] as const) {
      const plan = await buildSwap(provider, owner, { tokenIn: a, tokenOut: b, amountInFormatted: amount }, { slippage: 0 })
      const tx = plan.transactions[plan.transactions.length - 1] as { to: string; data: string; value: string }
      if (plan.transactions.length > 1) continue // 额度不够（需要先授权）时跳过这个方向
      const min = BigInt(plan.amountOutMin).toString(16).padStart(64, '0')
      expect(await trigger(tx.to, tx.data, tx.value)).toBe(true)
      expect(await trigger(tx.to, tx.data.replaceAll(min, (BigInt(plan.amountOutMin) + 1n).toString(16).padStart(64, '0')), tx.value)).toBe(false)
    }
  })
})
