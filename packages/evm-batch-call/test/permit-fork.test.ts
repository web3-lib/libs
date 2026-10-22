/**
 * permit / Permit2 / swap 的 approve: 'permit'：在 Base 主网分叉上真实执行，默认跳过（anvil 要开 Prague）：
 *
 * ```sh
 * anvil --fork-url https://base-rpc.publicnode.com --hardfork prague --port 18701
 * FORK_RPC=http://127.0.0.1:18701 npx vitest run test/permit-fork.test.ts
 * ```
 */
import { AbiCoder, Contract, JsonRpcProvider, Wallet, keccak256, parseEther, toBeHex } from 'ethers'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { NATIVE_TOKEN, Provider } from '../src/index.js'
import { PERMIT2_ADDRESS, buildPermit, buildPermit2Single, buildPermit2Transfer, detectPermit, permit2Calldata, permitCalldata, permitTransferFromCalldata, signPermit } from '../src/subpaths/permit.js'
import { buildSwap, swap } from '../src/subpaths/swap.js'

const fork = process.env.FORK_RPC ? describe : describe.skip
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const WETH = '0x4200000000000000000000000000000000000006'
const UNI_ROUTER = '0x2626664c2603336E57B271c5C0b26F421741e481'
const ERC20 = [
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
]
const PERMIT2 = ['function allowance(address,address,address) view returns (uint160,uint48,uint48)']

fork('permit / Permit2 / swap（Base 分叉）', { timeout: 180_000 }, () => {
  let rpc: JsonRpcProvider
  let multi: Provider
  let snapshot: string
  const fast = { pollInterval: 100 }
  const usdc = () => new Contract(USDC, ERC20, rpc)
  const bal = async (a: string) => (await usdc().getFunction('balanceOf')(a)) as bigint
  const allowance = async (o: string, s: string) => (await usdc().getFunction('allowance')(o, s)) as bigint
  const setUsdc = async (a: string, amount: bigint) => {
    const slot = keccak256(AbiCoder.defaultAbiCoder().encode(['address', 'uint256'], [a, 9]))
    await rpc.send('anvil_setStorageAt', [USDC, slot, toBeHex(amount, 32)])
  }
  /** 发送并轮询回执（anvil 分叉上 ethers 的 wait() 偶尔会把未索引的哈希转给上游节点而报错） */
  const sendTx = async (w: { connect(p: JsonRpcProvider): { sendTransaction(tx: { to: string; data: string; gasLimit?: bigint }): Promise<{ hash: string }> } }, tx: { to: string; data: string; gasLimit?: bigint }) => {
    const sent = await w.connect(rpc).sendTransaction(tx)
    for (let i = 0; i < 100; i++) {
      const receipt = await rpc.getTransactionReceipt(sent.hash).catch(() => null)
      if (receipt) return receipt
      await new Promise((r) => setTimeout(r, 100))
    }
    throw new Error('no receipt')
  }
  const funded = async (usdcAmount = 100_000_000n, ethAmount = '1') => {
    const w = Wallet.createRandom()
    await rpc.send('anvil_setBalance', [w.address, `0x${parseEther(ethAmount).toString(16)}`])
    await setUsdc(w.address, usdcAmount)
    return w
  }

  beforeAll(async () => {
    rpc = new JsonRpcProvider(process.env.FORK_RPC, 8453, { staticNetwork: true })
    multi = new Provider(8453, rpc)
    snapshot = (await rpc.send('evm_snapshot', [])) as string
  })
  afterAll(async () => {
    if (snapshot) await rpc.send('evm_revert', [snapshot])
  })

  it('USDC：detectPermit 识别 v2；任何人提交 permit() 后 allowance 正好是签的数量', async () => {
    expect(await detectPermit(multi, USDC)).toMatchObject({ kind: 'eip2612', domain: { name: 'USD Coin', version: '2' } })
    const owner = await funded(10_000_000n, '0')
    const relayer = await funded(0n, '1')
    const spender = Wallet.createRandom().address
    const permit = await buildPermit(multi, { token: USDC, owner: owner.address, spender, value: 1_234_567n })
    const signed = await signPermit(owner, permit)
    expect((await sendTx(relayer, { to: USDC, data: permitCalldata(signed) })).status).toBe(1)
    expect(await allowance(owner.address, spender)).toBe(1_234_567n)
    // 同一个签名不能重放（nonce 已用）
    expect((await sendTx(relayer, { to: USDC, data: permitCalldata(signed), gasLimit: 200_000n })).status).toBe(0)
  })

  it('Permit2：PermitSingle 链上验签通过；SignatureTransfer 由 spender 直接转走，超过签名数量 / 重放都失败', async () => {
    const owner = await funded(10_000_000n, '1')
    const spender = await funded(0n, '1')
    expect((await sendTx(owner, { to: USDC, data: new Contract(USDC, ERC20).interface.encodeFunctionData('approve', [PERMIT2_ADDRESS, 10_000_000n]) })).status).toBe(1)

    const single = await buildPermit2Single(multi, { token: USDC, owner: owner.address, spender: spender.address, amount: 2_000_000n })
    const signedSingle = await signPermit(owner, single)
    expect((await sendTx(spender, { to: PERMIT2_ADDRESS, data: permit2Calldata(signedSingle) })).status).toBe(1)
    const [amount, , nonce] = (await new Contract(PERMIT2_ADDRESS, PERMIT2, rpc).getFunction('allowance')(owner.address, USDC, spender.address)) as [bigint, bigint, bigint]
    expect([amount, nonce]).toEqual([2_000_000n, 1n])

    const transfer = await buildPermit2Transfer(multi, { token: USDC, owner: owner.address, spender: spender.address, amount: 3_000_000n })
    const signed = await signPermit(owner, transfer)
    const to = Wallet.createRandom().address
    expect((await sendTx(spender, { to: PERMIT2_ADDRESS, data: permitTransferFromCalldata(signed, to, 3_000_000n) })).status).toBe(1)
    expect(await bal(to)).toBe(3_000_000n)
    expect((await sendTx(spender, { to: PERMIT2_ADDRESS, data: permitTransferFromCalldata(signed, to, 1n), gasLimit: 300_000n })).status).toBe(0)
    // 别的地址拿到签名也不能用：只有签名里的 spender 能调
    const thief = await funded(0n, '1')
    const again = await signPermit(owner, await buildPermit2Transfer(multi, { token: USDC, owner: owner.address, spender: spender.address, amount: 1n }))
    expect((await sendTx(thief, { to: PERMIT2_ADDRESS, data: permitTransferFromCalldata(again, thief.address), gasLimit: 300_000n })).status).toBe(0)
  })

  for (const protocol of ['uniswap-v3', 'pancakeswap-v3'] as const) {
    it(`swap approve: 'permit'（${protocol}）：没有授权也只发一笔交易（selfPermit 在 multicall 内），授权额度用完归零`, async () => {
      const user = await funded(50_000_000n, '1')
      const before = await rpc.getBalance(user.address)
      const r = await swap(multi, user.privateKey, { tokenIn: USDC, tokenOut: NATIVE_TOKEN, amountInFormatted: '20' }, { ...fast, approve: 'permit', protocols: [protocol], slippage: 0.02 })
      expect(r.status).toBe('confirmed')
      expect(r.approval).toMatchObject({ method: 'permit', via: 'selfPermit' })
      expect(r.results).toHaveLength(1)
      expect(await bal(user.address)).toBe(30_000_000n)
      expect(await rpc.getBalance(user.address)).toBeGreaterThan(before - parseEther('0.01'))
      expect(await allowance(user.address, r.plan.transactions[0]?.to as string)).toBe(0n)
    })
  }

  it("V2 路线 + 7702 代付：permit 和兑换在同一笔原子批量里，用户没有主币", async () => {
    const user = await funded(50_000_000n, '0')
    const sponsor = await funded(0n, '10')
    const r = await swap(multi, user.privateKey, { tokenIn: USDC, tokenOut: NATIVE_TOKEN, amountInFormatted: '20' }, { ...fast, approve: 'permit', protocols: ['uniswap-v2'], mode: '7702', sponsor: sponsor.privateKey, slippage: 0.03 })
    expect(r.approval).toMatchObject({ method: 'permit', via: 'batch' })
    expect(r.results.map((x) => [x.kind, x.status])).toEqual([['permit', 'confirmed'], ['swap', 'confirmed']])
    expect(await bal(user.address)).toBe(30_000_000n)
    expect(await rpc.getBalance(user.address)).toBeGreaterThan(0n) // 收到的 ETH，没付过 gas
  })

  it("V2 路线不批量：退回普通授权并说明；'permit2' 也退回；不支持 permit 的代币（WETH）'auto' 退回", async () => {
    const a = await funded(50_000_000n, '1')
    const v2 = await swap(multi, a.privateKey, { tokenIn: USDC, tokenOut: NATIVE_TOKEN, amountInFormatted: '10' }, { ...fast, approve: 'permit', protocols: ['uniswap-v2'], slippage: 0.03 })
    expect(v2.approval).toMatchObject({ method: 'approve' })
    expect(v2.approval?.reason).toMatch(/selfPermit/)
    expect(v2.results.map((x) => x.kind)).toEqual(['approve', 'swap'])
    expect(v2.status).toBe('confirmed')

    const b = await funded(50_000_000n, '1')
    const p2 = await swap(multi, b.privateKey, { tokenIn: USDC, tokenOut: NATIVE_TOKEN, amountInFormatted: '10' }, { ...fast, approve: 'permit2', protocols: ['uniswap-v3'] })
    expect(p2.approval).toMatchObject({ method: 'approve' })
    expect(p2.approval?.reason).toMatch(/Permit2/)
    expect(p2.status).toBe('confirmed')

    const c = await funded(0n, '1')
    const sent = await c.connect(rpc).sendTransaction({ to: WETH, value: parseEther('0.1') }) // WETH 的 fallback 等于 deposit
    for (let i = 0; i < 100 && !(await rpc.getTransactionReceipt(sent.hash).catch(() => null)); i++) await new Promise((r) => setTimeout(r, 100))
    const auto = await buildSwap(multi, c.address, { tokenIn: WETH, tokenOut: USDC, amountInFormatted: '0.05' }, { approve: 'auto' })
    expect(auto.approval).toMatchObject({ method: 'approve' })
    expect(auto.approval?.reason).toMatch(/no nonces/)
  })
})
