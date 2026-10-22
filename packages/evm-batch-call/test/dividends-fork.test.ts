/**
 * Flap 分红：在 BSC 主网分叉上对真实代币和真实持有人领取，核对收到的数量等于预览的 claimable（任何人可代领，款项直接到持有人），
 * 并与官方 TaxTokenHelper.getDividendInfo 交叉核对。默认跳过（上游节点要保留旧状态，如 blastapi）：
 *
 * ```sh
 * anvil --fork-url https://bsc-mainnet.public.blastapi.io --hardfork prague --port 18651
 * FORK_RPC=http://127.0.0.1:18651 npx vitest run test/dividends-fork.test.ts
 * ```
 */
import { Contract, JsonRpcProvider, Wallet, parseEther } from 'ethers'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { Provider } from '../src/index.js'
import { FLAP_DIVIDEND_CHAINS, claimDividends, dividends, type DividendItem } from '../src/subpaths/dividends.js'

const fork = process.env.FORK_RPC ? describe : describe.skip
// 2026-10 主网上的真实数据：分红资产是 BNB（WBNB 解包）的代币 / 分红资产是 FXIon（ERC20）的代币，以及这些代币的持有人（只要还有可领取的就行）
const TOKEN_BNB = '0x78dE1541Dc85b0c89035ed8Bb3F0e25685A87777'
const HOLDERS_BNB = ['0x7Ce5EC73d78a3988f06898286048EFa106D5B555', '0x1caE4e55478b3a07aC9A3FF5854095aF4eFF49Ff', '0xBa1d7BeFE69f4ea09D82eD30f56d8948C9bFb6D9', '0x00Ba45a02Ff5D077DAC749F5Db138864c5A3F15E']
const TOKEN_ERC20 = '0xB169215e59E11C84aa794B124f5345d58b447777'
const HOLDERS_ERC20 = ['0x4D8ed7Aa793D921E60cA5A007921cc27Bc6ff650', '0xEBbDfe1881F01b4355758E8F1e09f40A0D62dD8f', '0xb39e538193cc4426A950741372De7561fc5833dB', '0x45a6f15a5Ccac5F61C19196d0788C01f23bB85a9']
const HELPER_ABI = ['function getDividendInfo(address token, address user) view returns (uint256 claimed, uint256 pending)']
const ERC20_ABI = ['function balanceOf(address) view returns (uint256)']

fork('Flap 分红（BSC 分叉）', { timeout: 180_000 }, () => {
  let rpc: JsonRpcProvider
  let multi: Provider
  let snapshot: string
  const fast = { pollInterval: 100 }
  const helper = () => new Contract(FLAP_DIVIDEND_CHAINS[56]?.taxTokenHelper as string, HELPER_ABI, rpc)
  /** 找一个还有可领取分红的持有人 */
  async function pick(token: string, holders: string[]): Promise<DividendItem> {
    for (const h of holders) {
      const { items } = await dividends(multi, h, { tokens: [token], prices: false })
      if (items[0]) return items[0]
    }
    throw new Error(`no holder with claimable dividends for ${token}`)
  }
  const sender = async () => {
    const w = Wallet.createRandom()
    await rpc.send('anvil_setBalance', [w.address, '0x' + parseEther('1').toString(16)])
    return w
  }

  beforeAll(async () => {
    rpc = new JsonRpcProvider(process.env.FORK_RPC, 56, { staticNetwork: true })
    multi = new Provider(56, rpc)
    snapshot = (await rpc.send('evm_snapshot', [])) as string
  })
  afterAll(async () => {
    if (rpc) await rpc.send('evm_revert', [snapshot])
    rpc?.destroy()
  })

  it('读取与官方 TaxTokenHelper.getDividendInfo 一致', async () => {
    const item = await pick(TOKEN_ERC20, HOLDERS_ERC20)
    const [claimed, pending] = (await helper().getFunction('getDividendInfo')(item.token, item.owner)) as [bigint, bigint]
    expect(item.claimable).toBe(pending.toString())
    expect(item.claimed).toBe(claimed.toString())
    expect(item.asset).toBe(item.dividendToken)
    expect(item.assetSymbol).toBeTruthy()
    expect(item.dividendContract).toMatch(/^0x[0-9a-fA-F]{40}$/)
  })

  it('分红资产是 ERC20：第三方代领，持有人收到的数量等于预览', async () => {
    const item = await pick(TOKEN_ERC20, HOLDERS_ERC20)
    const reward = new Contract(item.asset, ERC20_ABI, rpc)
    const before = (await reward.getFunction('balanceOf')(item.owner)) as bigint
    const [r] = await claimDividends(multi, (await sender()).privateKey, [item], { ...fast, simulate: true })
    expect(r?.status).toBe('confirmed')
    const after = (await reward.getFunction('balanceOf')(item.owner)) as bigint
    expect(after - before).toBe(BigInt(item.claimable))
    const again = await dividends(multi, item.owner, { tokens: [item.token], includeZero: true, prices: false })
    expect(again.items[0]?.claimable).toBe('0')
    expect(BigInt(again.items[0]?.claimed as string)).toBe(BigInt(item.claimed) + BigInt(item.claimable))
    // 没有可领取时不发交易
    expect(await claimDividends(multi, (await sender()).privateKey, again.items, fast)).toEqual([])
  })

  it('分红代币是 WBNB：领取解包成 BNB，到账等于预览', async () => {
    const item = await pick(TOKEN_BNB, HOLDERS_BNB)
    expect(item.asset).toBe('native')
    const before = await rpc.getBalance(item.owner)
    const [r] = await claimDividends(multi, (await sender()).privateKey, [item], fast)
    expect(r?.status).toBe('confirmed')
    expect((await rpc.getBalance(item.owner)) - before).toBe(BigInt(item.claimable))
  })

  it("mode: '7702'：两个持有人的领取合成一笔原子交易", async () => {
    const a = await pick(TOKEN_BNB, HOLDERS_BNB.slice(1))
    const b = await pick(TOKEN_ERC20, HOLDERS_ERC20.slice(1))
    const reward = new Contract(b.asset, ERC20_ABI, rpc)
    const [beforeA, beforeB] = [await rpc.getBalance(a.owner), (await reward.getFunction('balanceOf')(b.owner)) as bigint]
    const results = await claimDividends(multi, (await sender()).privateKey, [a, b], { ...fast, mode: '7702', simulate: true })
    expect(results.map((r) => r.status)).toEqual(['confirmed', 'confirmed'])
    expect(results[0]?.hash).toBe(results[1]?.hash)
    expect((await rpc.getBalance(a.owner)) - beforeA).toBe(BigInt(a.claimable))
    expect(((await reward.getFunction('balanceOf')(b.owner)) as bigint) - beforeB).toBe(BigInt(b.claimable))
  })

  it('simulate: true 把会 revert 的项标记为 skipped，不发送', async () => {
    // 伪造一个指向不存在合约的项：模拟成功（调用空地址）不算失败，所以用一个会 revert 的目标：代币合约本身没有 withdrawDividendsFor
    const item = { ...(await pick(TOKEN_ERC20, HOLDERS_ERC20.slice(1))), dividendContract: TOKEN_ERC20 }
    const [r] = await claimDividends(multi, (await sender()).privateKey, [item], { ...fast, simulate: true })
    expect(r?.status).toBe('skipped')
    expect(r?.hash).toBeNull()
  })
})
