/**
 * 智能账户（ERC-4337 自己打包、EIP-7702 代付）：在 Base 主网分叉上真实执行，默认跳过。anvil 要开 Prague（EIP-7702）：
 *
 * ```sh
 * anvil --fork-url https://base-rpc.publicnode.com --hardfork prague --port 18701
 * FORK_RPC=http://127.0.0.1:18701 npx vitest run test/smart-account-fork.test.ts
 * ```
 */
import { AbiCoder, Contract, JsonRpcProvider, Wallet, keccak256, parseEther, toBeHex } from 'ethers'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { Provider } from '../src/index.js'
import { ENTRY_POINT_V07, ENTRY_POINT_V08, getSimpleAccount, getUserOpHash, packUserOp, type UserOperation } from '../src/subpaths/smart-account.js'
import { SIMPLE_7702_ACCOUNT, batchCall, batchCollect, batchTransfer } from '../src/subpaths/write.js'

const fork = process.env.FORK_RPC ? describe : describe.skip
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const ERC20 = ['function balanceOf(address) view returns (uint256)', 'function transfer(address,uint256) returns (bool)']
const EP = ['function getUserOpHash((address sender, uint256 nonce, bytes initCode, bytes callData, bytes32 accountGasLimits, uint256 preVerificationGas, bytes32 gasFees, bytes paymasterAndData, bytes signature) userOp) view returns (bytes32)']

fork('智能账户（Base 分叉，自己打包 / 7702 代付）', { timeout: 120_000 }, () => {
  let rpc: JsonRpcProvider
  let multi: Provider
  let snapshot: string
  const fast = { pollInterval: 100 }
  const rand = () => Wallet.createRandom().address
  const eth = (n: string) => `0x${parseEther(n).toString(16)}`

  const usdc = () => new Contract(USDC, ERC20, rpc)
  const balance = async (a: string) => (await usdc().getFunction('balanceOf')(a)) as bigint
  /** 直接写 USDC 的余额存储槽（FiatToken 的 balances 在 slot 9） */
  const setUsdc = async (a: string, amount: bigint) => {
    const slot = keccak256(AbiCoder.defaultAbiCoder().encode(['address', 'uint256'], [a, 9]))
    await rpc.send('anvil_setStorageAt', [USDC, slot, toBeHex(amount, 32)])
    expect(await balance(a)).toBe(amount)
  }

  beforeAll(async () => {
    rpc = new JsonRpcProvider(process.env.FORK_RPC, 8453, { staticNetwork: true })
    multi = new Provider(8453, rpc)
    snapshot = (await rpc.send('evm_snapshot', [])) as string
  })
  afterAll(async () => {
    if (snapshot) await rpc.send('evm_revert', [snapshot])
  })

  it('userOpHash 与 EntryPoint.getUserOpHash 一致（v0.7 / v0.8，含 7702 的 initCode 替换）', async () => {
    const op: UserOperation = {
      sender: rand(),
      nonce: 5n,
      callData: '0x1234',
      callGasLimit: 100_000n,
      verificationGasLimit: 200_000n,
      preVerificationGas: 50_000n,
      maxFeePerGas: 2n * 10n ** 9n,
      maxPriorityFeePerGas: 10n ** 9n,
      paymaster: rand(),
      paymasterVerificationGasLimit: 30_000n,
      paymasterPostOpGasLimit: 40_000n,
      paymasterData: '0xabcd',
      signature: '0x',
    }
    const onChain = async (ep: string, o: UserOperation) => (await new Contract(ep, EP, rpc).getFunction('getUserOpHash')(packUserOp(o))) as string
    expect(getUserOpHash(op, ENTRY_POINT_V07, 8453, '0.7')).toBe(await onChain(ENTRY_POINT_V07, op))
    expect(getUserOpHash(op, ENTRY_POINT_V08, 8453, '0.8')).toBe(await onChain(ENTRY_POINT_V08, op))
    // 7702：账户已委托时，EntryPoint 用“委托的合约地址”代替 initCode
    await rpc.send('anvil_setCode', [op.sender, `0xef0100${SIMPLE_7702_ACCOUNT.slice(2)}`])
    const op7702 = { ...op, factory: '0x7702000000000000000000000000000000000000', factoryData: '0x' }
    expect(getUserOpHash(op7702, ENTRY_POINT_V08, 8453, '0.8', SIMPLE_7702_ACCOUNT)).toBe(await onChain(ENTRY_POINT_V08, op7702))
  })

  for (const entryPoint of ['0.7', '0.8'] as const) {
    it(`4337：未部署的 SimpleAccount（EntryPoint v${entryPoint}）首次部署 + 批量转账（主币 + USDC），自己打包`, async () => {
      const owner = Wallet.createRandom()
      const bundler = Wallet.createRandom()
      await rpc.send('anvil_setBalance', [bundler.address, eth('10')])
      const { address: account, deployed } = await getSimpleAccount(multi, owner.address, { entryPoint })
      expect(deployed).toBe(false)
      await rpc.send('anvil_setBalance', [account, eth('1')])
      await setUsdc(account, 100_000_000n)
      const [a, b, c] = [rand(), rand(), rand()]
      const results = await batchTransfer(
        multi,
        owner.privateKey,
        [
          { to: a, amount: 10n ** 16n },
          { to: b, amount: 2n * 10n ** 16n },
          { to: c, amount: 25_000_000n, token: USDC },
        ],
        { ...fast, mode: '4337', smartAccount: { entryPoint, selfBundle: bundler.privateKey } },
      )
      expect(results.map((r) => r.status)).toEqual(['confirmed', 'confirmed', 'confirmed'])
      expect(results[0]?.from).toBe(account)
      expect(results[0]?.userOpHash).toMatch(/^0x[0-9a-f]{64}$/)
      expect(results[0]?.atomic).toBe(true)
      expect(await rpc.getBalance(a)).toBe(10n ** 16n)
      expect(await rpc.getBalance(b)).toBe(2n * 10n ** 16n)
      expect(await balance(c)).toBe(25_000_000n)
      expect(await rpc.getCode(account)).not.toBe('0x')
      expect(await rpc.getBalance(owner.address)).toBe(0n) // owner 一分钱没动
      // 第二批：账户已部署，不再带 initCode
      const again = await batchTransfer(multi, owner.privateKey, [{ to: a, amount: 1n }, { to: b, amount: 1n }], { ...fast, mode: '4337', smartAccount: { entryPoint, selfBundle: bundler.privateKey } })
      expect(again.map((r) => r.status)).toEqual(['confirmed', 'confirmed'])
    })
  }

  it('4337：批量里有一个调用 revert：整个 UserOperation 回滚，状态 reverted', async () => {
    const owner = Wallet.createRandom()
    const bundler = Wallet.createRandom()
    await rpc.send('anvil_setBalance', [bundler.address, eth('10')])
    const { address: account } = await getSimpleAccount(multi, owner.address)
    await rpc.send('anvil_setBalance', [account, eth('1')])
    await setUsdc(account, 10_000_000n)
    const [a, b] = [rand(), rand()]
    // 第二个调用转的 USDC 超过余额：预估单个调用时就会失败 → 用 gas 覆盖跳过预估，让它上链后回滚
    const results = await batchTransfer(
      multi,
      owner.privateKey,
      [
        { to: a, amount: 10n ** 15n },
        { to: b, amount: 20_000_000n, token: USDC },
      ],
      { ...fast, mode: '4337', checkBalance: false, smartAccount: { selfBundle: bundler.privateKey, gas: { callGasLimit: 300_000n } } },
    ).catch((e) => e)
    expect(Array.isArray(results)).toBe(true)
    expect((results as Array<{ status: string }>).map((r) => r.status)).toEqual(['reverted', 'reverted'])
    expect(await rpc.getBalance(a)).toBe(0n)
  })

  it('7702 代付：用户没有主币，sponsor 付 gas；已委托后再来一批不带授权', async () => {
    const user = Wallet.createRandom()
    const sponsor = Wallet.createRandom()
    await rpc.send('anvil_setBalance', [sponsor.address, eth('10')])
    await setUsdc(user.address, 100_000_000n)
    const [a, b] = [rand(), rand()]
    expect(await rpc.getBalance(user.address)).toBe(0n)
    const results = await batchTransfer(
      multi,
      user.privateKey,
      [
        { to: a, amount: 30_000_000n, token: USDC },
        { to: b, amount: 20_000_000n, token: USDC },
      ],
      { ...fast, mode: '7702', sponsor: sponsor.privateKey },
    )
    expect(results.map((r) => r.status)).toEqual(['confirmed', 'confirmed'])
    expect(results[0]?.from).toBe(user.address)
    expect(await balance(a)).toBe(30_000_000n)
    expect(await balance(b)).toBe(20_000_000n)
    expect(await rpc.getBalance(user.address)).toBe(0n)
    expect(await rpc.getBalance(sponsor.address)).toBeLessThan(parseEther('10'))
    expect((await rpc.getCode(user.address)).toLowerCase()).toBe(`0xef0100${SIMPLE_7702_ACCOUNT.slice(2).toLowerCase()}`)
    // 已委托：这一批不带授权，同样由 sponsor 付 gas
    const [again] = await batchCall(multi, [{ from: user.privateKey, to: a, data: usdcTransfer(b, 1n) }].map((c) => ({ ...c, to: USDC })), { ...fast, mode: '7702', sponsor: sponsor.privateKey })
    expect(again?.status).toBe('confirmed')
    expect(await rpc.getTransactionCount(user.address)).toBe(1) // 授权让 nonce +1，之后用户没有发过交易
  })

  it('4337 + 7702 账户：没有 sponsor 时用户自己发 handleOps（授权 nonce + 1），账户是用户地址本身', async () => {
    const user = Wallet.createRandom()
    await rpc.send('anvil_setBalance', [user.address, eth('1')])
    const [a, b] = [rand(), rand()]
    const results = await batchTransfer(multi, user.privateKey, [{ to: a, amount: 10n ** 15n }, { to: b, amount: 10n ** 15n }], { ...fast, mode: '4337', smartAccount: { account: 'simple7702', selfBundle: true } })
    expect(results.map((r) => r.status)).toEqual(['confirmed', 'confirmed'])
    expect(results[0]?.from).toBe(user.address)
    expect(await rpc.getBalance(b)).toBe(10n ** 15n)
  })

  it('7702 代付归集：多个没有主币的子钱包的 USDC + 主币全部转走', async () => {
    const sponsor = Wallet.createRandom()
    await rpc.send('anvil_setBalance', [sponsor.address, eth('10')])
    const hot = rand()
    const kids = [Wallet.createRandom(), Wallet.createRandom()]
    await setUsdc(kids[0]?.address as string, 5_000_000n)
    await setUsdc(kids[1]?.address as string, 7_000_000n)
    await rpc.send('anvil_setBalance', [kids[1]?.address, eth('0.5')])
    const { results, topUps } = await batchCollect(multi, kids.map((k) => k.privateKey), hot, { ...fast, tokens: [USDC, '0x0000000000000000000000000000000000000000'], sponsor: sponsor.privateKey })
    expect(topUps).toEqual([])
    expect(results.map((r) => r.status)).toEqual(['confirmed', 'skipped', 'confirmed', 'confirmed'])
    expect(await balance(hot)).toBe(12_000_000n)
    expect(await rpc.getBalance(hot)).toBe(10n ** 18n / 2n)
    expect(await rpc.getBalance(kids[1]?.address as string)).toBe(0n)
  })

  it('sponsor 付 gas、用户签错 UserOperation 时被 EntryPoint 拒绝（AA24）', async () => {
    const user = Wallet.createRandom()
    const sponsor = Wallet.createRandom()
    await rpc.send('anvil_setBalance', [sponsor.address, eth('1')])
    await setUsdc(user.address, 1_000_000n)
    // 签名器换成别人的：signTypedData 给出的签名不是 user 的
    const other = Wallet.createRandom()
    const liar = { getAddress: async () => user.address, signTransaction: user.signTransaction.bind(user), authorize: user.authorize.bind(user), signTypedData: other.signTypedData.bind(other) }
    const [r] = await batchCall(multi, [{ from: liar, to: USDC, data: usdcTransfer(rand(), 1n) }], { ...fast, mode: '7702', sponsor: sponsor.privateKey })
    expect(r?.status).toBe('failed')
    expect(r?.error).toMatch(/AA24|signature/)
  })
})

function usdcTransfer(to: string, amount: bigint): string {
  return new Contract(USDC, ERC20).interface.encodeFunctionData('transfer', [to, amount])
}
