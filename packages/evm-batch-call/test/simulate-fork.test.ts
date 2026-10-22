/**
 * 模拟 vs 真实执行：在以太坊主网分叉上先模拟 buildSwap 的 approve + swap，再真的发出去，核对资产变化一致。默认跳过：
 *
 * ```sh
 * anvil --fork-url https://ethereum-rpc.publicnode.com --port 18547 --base-fee 0 --gas-price 0
 * FORK_RPC=http://127.0.0.1:18547 npx vitest run test/simulate-fork.test.ts
 * ```
 */
import { Contract, JsonRpcProvider } from 'ethers'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { NATIVE_TOKEN, Provider } from '../src/index.js'
import { buildSwap } from '../src/subpaths/swap.js'
import { simulateBatch } from '../src/subpaths/simulate.js'

const fork = process.env.FORK_RPC ? describe : describe.skip
const USDT = '0xdAC17F958D2ee523a2206206994597C13D831ec7'
const HOLDER = '0xF977814e90dA44bFA03b6295A0616a897441aceC'

fork('模拟 vs 真实执行（以太坊分叉）', { timeout: 180_000 }, () => {
  let rpc: JsonRpcProvider
  let provider: Provider

  beforeAll(async () => {
    rpc = new JsonRpcProvider(process.env.FORK_RPC, 1, { staticNetwork: true })
    provider = new Provider(1, rpc)
    await rpc.send('anvil_impersonateAccount', [HOLDER])
  })
  afterAll(async () => {
    await rpc.send('anvil_stopImpersonatingAccount', [HOLDER])
    rpc.destroy()
  })

  it('approve + swap：模拟的变化与实际一致', async () => {
    const usdt = new Contract(USDT, ['function balanceOf(address) view returns (uint256)'], rpc)
    const plan = await buildSwap(provider, HOLDER, { tokenIn: USDT, tokenOut: NATIVE_TOKEN, amountInFormatted: '1000' })
    const sim = await simulateBatch(provider, plan, { from: HOLDER, fee: false })
    expect(sim.success).toBe(true)
    console.log('fork simulate mode:', sim.mode)

    const before = { usdt: await usdt.balanceOf!(HOLDER), eth: await rpc.getBalance(HOLDER) }
    const signer = await rpc.getSigner(HOLDER)
    for (const tx of plan.transactions) await (await signer.sendTransaction({ to: tx.to, data: tx.data, value: BigInt(tx.value), gasPrice: 0n })).wait()
    const after = { usdt: await usdt.balanceOf!(HOLDER), eth: await rpc.getBalance(HOLDER) }

    const delta = (asset: string) => sim.balanceChanges.find((c) => c.asset === asset)?.delta
    expect(delta(USDT.toLowerCase())).toBe((after.usdt - before.usdt).toString())
    expect(delta('native')).toBe((after.eth - before.eth).toString())
  })
})
