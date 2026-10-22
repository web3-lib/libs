/**
 * 一键领取手续费和挖矿奖励：在 BSC 主网分叉上核对，默认跳过。
 *
 * ```sh
 * anvil --fork-url https://bsc-rpc.publicnode.com --hardfork prague --port 18951
 * BSC_FORK_RPC=http://127.0.0.1:18951 npx vitest run test/rewards-fork.test.ts
 * ```
 *
 * Base 分叉（BASE_FORK_RPC，Aerodrome Slipstream gauge）见文件末尾。
 *
 * 1. 真实的 MasterChef 质押用户（模拟其身份）：getClaimable 的手续费与 MasterChef.collectTo 的静态调用结果逐位一致，
 *    挖矿奖励与 harvest 一致（只差分叉出块时间带来的零头），claimAll 实际到账等于预览
 * 2. 随机新钱包：从真实持有者那里转来 PancakeSwap V3 / Uniswap V3 / Uniswap V4 的仓位、再质押一个到 MasterChef，
 *    claimAll 分别用 'tx'（逐笔）和 '7702'（一笔原子交易）领取，到账的每个代币数量与预览逐位一致；坏的项被模拟剔除
 */
import { Contract, JsonRpcProvider, Wallet, ZeroAddress, getAddress } from 'ethers'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { Provider } from '../src/index.js'
import { SIMPLE_7702_ACCOUNT } from '../src/subpaths/write.js'
import { buildClaimAll, claimAll, claimable, type ClaimItem } from '../src/subpaths/rewards.js'

const fork = process.env.BSC_FORK_RPC ? describe : describe.skip

const MASTER_CHEF = '0x556B9306565093C855AEA9AE92A594704c2Cd59e'
const CAKE_NPM = '0x46A15B0b27311cedF172AB29E4f4766fbE7F4364'
const UNI_NPM = '0x7b8A01B39D58278b5DE7e48c8449c9f4F5170613'
const V4_PM = '0x7a4a5c919ae2541aed11041a1aeee68f1287f95b'
/** 2026-10 在 MasterChef 里质押了 5 个仓位的真实地址 */
const STAKER = '0xd617dfc6675197e21be95650c0fc13a09da0c714'

const ERC20 = ['function balanceOf(address) view returns (uint256)']
const NFT = [
  'function ownerOf(uint256) view returns (address)',
  'function transferFrom(address, address, uint256)',
  'function safeTransferFrom(address, address, uint256)',
  'function totalSupply() view returns (uint256)',
  'function tokenByIndex(uint256) view returns (uint256)',
  'function nextTokenId() view returns (uint256)',
]
const MC = [
  'function balanceOf(address) view returns (uint256)',
  'function tokenOfOwnerByIndex(address, uint256) view returns (uint256)',
  'function harvest(uint256, address) returns (uint256)',
  'function collectTo((uint256 tokenId, address recipient, uint128 amount0Max, uint128 amount1Max) params, address to) returns (uint256, uint256)',
]
const U128 = 2n ** 128n - 1n

fork('领取手续费和挖矿奖励（BSC 分叉）', { timeout: 600_000 }, () => {
  let rpc: JsonRpcProvider
  let multi: Provider
  let snapshot: string

  const impersonate = async (address: string) => {
    await rpc.send('anvil_setBalance', [address, '0x56bc75e2d63100000'])
    await rpc.send('anvil_impersonateAccount', [address])
    return rpc.getSigner(address)
  }
  const balanceOf = async (token: string, who: string) => (token === ZeroAddress ? rpc.getBalance(who) : ((await new Contract(token, ERC20, rpc).getFunction('balanceOf')(who)) as bigint))
  const totalsOf = (items: ClaimItem[]) => {
    const sum = new Map<string, bigint>()
    for (const { amounts } of items) for (const a of amounts) sum.set(getAddress(a.token.address), (sum.get(getAddress(a.token.address)) ?? 0n) + BigInt(a.amount))
    return sum
  }

  beforeAll(async () => {
    rpc = new JsonRpcProvider(process.env.BSC_FORK_RPC, 56, { staticNetwork: true })
    multi = new Provider(56, rpc)
    snapshot = (await rpc.send('evm_snapshot', [])) as string
    // 分叉的最新区块是启动时的：先出一个当前时间的区块，挖矿奖励（按时间累计）的预览才与之后的交易接近
    await rpc.send('evm_mine', [])
  }, 60_000)

  afterAll(async () => {
    if (snapshot) await rpc.send('evm_revert', [snapshot])
  }, 60_000)

  it('质押用户：预览与 MasterChef 的静态调用一致，claimAll 到账等于预览', async () => {
    const mc = new Contract(MASTER_CHEF, MC, rpc)
    const count = Number(await mc.getFunction('balanceOf')(STAKER))
    expect(count).toBeGreaterThan(0)
    const staked: bigint[] = []
    for (let i = 0; i < count; i++) staked.push((await mc.getFunction('tokenOfOwnerByIndex')(STAKER, i)) as bigint)

    const c = await claimable(multi, STAKER, { prices: true })
    expect(c.errors).toEqual([])
    const farms = c.items.filter((i) => i.kind === 'farm')
    const fees = c.items.filter((i) => i.kind === 'fees' && i.staked)
    expect(c.items.some((i) => i.kind === 'fees' && !i.staked)).toBe(true) // 它自己还持有几个没质押的仓位
    expect(farms.length).toBeGreaterThan(0)
    expect(fees.length).toBeGreaterThan(0)
    expect(farms.every((i) => i.staked && i.target === MASTER_CHEF && i.amounts[0]?.token.symbol === 'Cake')).toBe(true)
    expect(c.usd).toBeGreaterThan(0)

    const signer = await impersonate(STAKER)
    const write = mc.connect(signer) as Contract
    // 手续费：逐位一致
    for (const item of fees) {
      const [a0, a1] = (await write.getFunction('collectTo').staticCall({ tokenId: item.tokenId, recipient: STAKER, amount0Max: U128, amount1Max: U128 }, STAKER)) as [bigint, bigint]
      expect([a0.toString(), a1.toString()]).toEqual(item.amounts.map((a) => a.amount))
    }
    // 挖矿奖励：harvest 在稍后的区块里算，只多出这几秒的零头
    for (const item of farms) {
      const reward = (await write.getFunction('harvest').staticCall(item.tokenId, STAKER)) as bigint
      const preview = BigInt(item.amounts[0]?.amount ?? 0)
      expect(reward).toBeGreaterThanOrEqual(preview)
      expect(reward - preview).toBeLessThan(preview / 100n + 1n)
    }
    expect(staked.length).toBe(count)

    // MasterChef 一笔 multicall + 自己持有的仓位按仓位合约各一笔；每笔模拟的资产变化 = 这一笔里各项的预览（CAKE 允许模拟区块多出的几秒）
    const plan = await buildClaimAll(multi, STAKER, { items: c.items })
    expect(plan.skipped).toEqual([])
    expect(plan.transactions.filter((t) => t.kind === 'farm')).toHaveLength(1)
    expect(plan.transactions.length).toBeGreaterThanOrEqual(2)
    for (const tx of plan.transactions) {
      expect(tx.simulation?.success).toBe(true)
      const mine = c.items.filter((i) => tx.itemIds.includes(i.id))
      for (const [token, amount] of totalsOf(mine)) {
        const change = tx.simulation?.balanceChanges.find((b) => b.address.toLowerCase() === STAKER && getAddress(b.asset) === token)
        const got = BigInt(change?.delta ?? 0)
        if (mine.some((i) => i.kind === 'farm' && getAddress(i.amounts[0]?.token.address as string) === token)) expect(got).toBeGreaterThanOrEqual(amount)
        else expect(got).toBe(amount)
      }
    }

    const before = new Map<string, bigint>()
    for (const token of totalsOf(c.items).keys()) before.set(token, await balanceOf(token, STAKER))
    const result = await claimAll(multi, signer, { items: c.items, pollInterval: 100 })
    expect(result.status).toBe('confirmed')
    expect(result.failed).toEqual([])
    expect(result.claimed).toHaveLength(c.items.length)
    for (const [token, amount] of totalsOf(c.items)) {
      const got = (await balanceOf(token, STAKER)) - (before.get(token) as bigint)
      const isCake = c.items.some((i) => i.kind === 'farm' && getAddress(i.amounts[0]?.token.address as string) === token)
      if (isCake) {
        expect(got).toBeGreaterThanOrEqual(amount)
        expect(got - amount).toBeLessThan(amount / 100n + 1n)
      } else {
        expect(got).toBe(amount)
      }
    }
    // 领完之后手续费清零
    const after = await claimable(multi, STAKER, { rewards: false })
    expect(after.items).toEqual([])
  })

  describe('随机钱包持有各协议的仓位', () => {
    const wallet = Wallet.createRandom()
    const owner = wallet.address
    let snap: string
    let v4Ids: bigint[] = []

    /** 把 NPM 里这批仓位中没有质押、没销毁的前 count 个转给 owner（模拟原持有者），返回转了哪些 */
    const take = async (npm: string, count: number, ids: bigint[]) => {
      const nft = new Contract(npm, NFT, rpc)
      const taken: bigint[] = []
      for (const tokenId of ids) {
        if (taken.length >= count) break
        let from: string
        try {
          from = (await nft.getFunction('ownerOf')(tokenId)) as string
        } catch {
          continue // 已销毁 / 还没铸造
        }
        if (getAddress(from) === getAddress(MASTER_CHEF)) continue
        const signer = await impersonate(from)
        await (await (nft.connect(signer) as Contract).getFunction('transferFrom')(from, owner, tokenId)).wait()
        taken.push(tokenId)
      }
      return taken
    }
    const recent = async (npm: string, from: number, step: number, n: number) => {
      const nft = new Contract(npm, NFT, rpc)
      const supply = Number(await nft.getFunction('totalSupply')())
      const ids: bigint[] = []
      for (let i = 0; i < n; i++) ids.push((await nft.getFunction('tokenByIndex')(supply - from - i * step)) as bigint)
      return ids
    }

    beforeAll(async () => {
      await rpc.send('anvil_setBalance', [owner, '0x56bc75e2d63100000'])
      await take(CAKE_NPM, 20, await recent(CAKE_NPM, 500, 15, 80))
      await take(UNI_NPM, 4, await recent(UNI_NPM, 1000, 20, 20))
      // V4：tokenId 连续递增，向前找一批
      const pm = new Contract(V4_PM, NFT, rpc)
      const next = (await pm.getFunction('nextTokenId')()) as bigint
      v4Ids = await take(V4_PM, 6, Array.from({ length: 60 }, (_, i) => next - 200n - BigInt(i) * 25n))
      // 质押一个 PancakeSwap 仓位到 MasterChef（NFT 打给 MasterChef 即质押）
      // 质押一个 PancakeSwap 仓位到 MasterChef（NFT 打给 MasterChef 即质押；池子没有开农场的仓位会 revert，换下一个）
      const mine = await claimable(multi, owner, { protocols: ['pancakeswap-v3'] })
      const npm = new Contract(CAKE_NPM, NFT, wallet.connect(rpc))
      let staked = false
      for (const item of mine.items) {
        try {
          await (await npm.getFunction('safeTransferFrom')(owner, MASTER_CHEF, item.tokenId)).wait()
          staked = true
          break
        } catch {
          // 这个池子没有农场
        }
      }
      expect(staked).toBe(true)
      snap = (await rpc.send('evm_snapshot', [])) as string
    }, 600_000)

    it('getClaimable：各来源都读到，V4 要传 tokenIds', async () => {
      const c = await claimable(multi, owner, { prices: true, v4: { tokenIds: v4Ids } })
      expect(c.errors).toEqual([])
      const protocols = new Set(c.items.map((i) => `${i.kind}:${i.protocol}`))
      expect(protocols).toContain('fees:pancakeswap-v3')
      expect(protocols).toContain('fees:uniswap-v4')
      expect(c.items.some((i) => i.staked && i.kind === 'fees')).toBe(true) // 质押的那个仓位：手续费由 MasterChef 代领
      expect(c.totals.length).toBeGreaterThan(0)
      // 只查一个协议
      const only = await claimable(multi, owner, { protocols: ['pancakeswap-v3'], v4: { tokenIds: v4Ids } })
      expect(only.items.every((i) => i.protocol === 'pancakeswap-v3')).toBe(true)
      expect(only.items.length).toBeLessThan(c.items.length)
    })

    const verify = async (mode: 'tx' | '7702') => {
      const c = await claimable(multi, owner, { v4: { tokenIds: v4Ids } })
      const before = new Map<string, bigint>()
      for (const token of totalsOf(c.items).keys()) before.set(token, await balanceOf(token, owner))
      const result = await claimAll(multi, wallet.privateKey, { items: c.items, mode, pollInterval: 100, ...(mode === '7702' ? { batchSize: 50 } : {}) })
      expect(result.plan.skipped).toEqual([])
      expect(result.status).toBe('confirmed')
      expect(result.failed).toEqual([])
      if (mode === '7702') expect(new Set(result.results.map((r) => r.hash)).size).toBe(1) // 全部在同一笔交易里
      else expect(result.results.length).toBeGreaterThan(2) // V3 / V4 / MasterChef 各一笔
      for (const [token, amount] of totalsOf(c.items)) {
        const got = (await balanceOf(token, owner)) - (before.get(token) as bigint)
        const isCake = c.items.some((i) => i.kind === 'farm' && getAddress(i.amounts[0]?.token.address as string) === token)
        // 原生币在 7702 / 手续费场景下要扣 gas：只核对代币
        if (token === ZeroAddress) continue
        if (isCake) expect(got).toBeGreaterThanOrEqual(amount)
        else expect(got).toBe(amount)
      }
    }

    it("claimAll 逐笔发送：到账与预览逐位一致", async () => {
      await verify('tx')
      await rpc.send('evm_revert', [snap])
      snap = (await rpc.send('evm_snapshot', [])) as string
    })

    it('claimAll 7702：一笔原子交易领完', async () => {
      expect((await rpc.getCode(SIMPLE_7702_ACCOUNT)).length).toBeGreaterThan(2)
      await verify('7702')
    })

    it('坏的仓位被模拟剔除，其余照常领取', async () => {
      await rpc.send('evm_revert', [snap])
      snap = (await rpc.send('evm_snapshot', [])) as string
      const c = await claimable(multi, owner, {})
      const v3 = c.items.filter((i) => i.version === 'v3' && !i.staked)
      expect(v3.length).toBeGreaterThan(2)
      // 把其中一个仓位悄悄转走：它的 collect 会 revert（不是所有者）
      const victim = v3[1] as ClaimItem
      const nft = new Contract(victim.target, NFT, wallet.connect(rpc))
      const other = Wallet.createRandom().address
      await (await nft.getFunction('transferFrom')(owner, other, victim.tokenId)).wait()
      const plan = await buildClaimAll(multi, owner, { items: c.items })
      expect(plan.skipped.map((s) => s.item.id)).toEqual([victim.id])
      expect(plan.skipped[0]?.reason).toMatch(/simulation failed/)
      expect(plan.items.some((i) => i.id === victim.id)).toBe(false)
      expect(plan.transactions.every((t) => t.simulation?.success !== false)).toBe(true)
    })
  })
})

const baseFork = process.env.BASE_FORK_RPC ? describe : describe.skip
/** 2026-10 在 Aerodrome Slipstream gauge 里质押了仓位的真实地址 */
const AERO_STAKER = '0xa1f2b434ae23314d0586f835e908729d6b041e8c'

baseFork('领取 Aerodrome Slipstream gauge 奖励（Base 分叉）', { timeout: 600_000 }, () => {
  it('读质押的仓位，预览 = 实际到账（奖励按时间累计，只多出几秒）', async () => {
    const rpc = new JsonRpcProvider(process.env.BASE_FORK_RPC, 8453, { staticNetwork: true })
    const multi = new Provider(8453, rpc)
    const snapshot = (await rpc.send('evm_snapshot', [])) as string
    try {
      await rpc.send('evm_mine', [])
      // 经 Voter 枚举两千多个池子的 gauge 要几千次读取，分叉的上游节点（有频率限制）受不了：枚举走公共节点，分叉上只读找到的 gauge
      const found = await claimable(new Provider(8453, 'https://base-rpc.publicnode.com'), AERO_STAKER, { protocols: ['aerodrome-slipstream'] })
      expect(found.items.length).toBeGreaterThan(0)
      const c = await claimable(multi, AERO_STAKER, { protocols: ['aerodrome-slipstream'], gauges: [...new Set(found.items.map((i) => i.target))] })
      expect(c.errors).toEqual([])
      expect(c.items.length).toBeGreaterThan(0)
      expect(c.items.every((i) => i.kind === 'gauge' && i.staked && i.amounts[0]?.token.symbol === 'AERO')).toBe(true)

      const aero = getAddress(c.items[0]?.amounts[0]?.token.address as string)
      const signer = await (async () => {
        await rpc.send('anvil_setBalance', [AERO_STAKER, '0x56bc75e2d63100000'])
        await rpc.send('anvil_impersonateAccount', [AERO_STAKER])
        return rpc.getSigner(AERO_STAKER)
      })()
      const token = new Contract(aero, ERC20, rpc)
      const before = (await token.getFunction('balanceOf')(AERO_STAKER)) as bigint
      const plan = await buildClaimAll(multi, AERO_STAKER, { items: c.items })
      expect(plan.skipped).toEqual([])
      expect(plan.transactions).toHaveLength(c.items.length) // gauge 一次只能领一个仓位
      expect(plan.transactions.every((t) => t.simulation?.success)).toBe(true)
      const result = await claimAll(multi, signer, { items: c.items, pollInterval: 100 })
      expect(result.status).toBe('confirmed')
      const got = ((await token.getFunction('balanceOf')(AERO_STAKER)) as bigint) - before
      const preview = c.items.reduce((s, i) => s + BigInt(i.amounts[0]?.amount ?? 0), 0n)
      expect(got).toBeGreaterThanOrEqual(preview)
      expect(got - preview).toBeLessThan(preview / 100n + 1n)
    } finally {
      await rpc.send('evm_revert', [snapshot])
    }
  })
})
