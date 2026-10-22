/** 账户回收：扫描（空账户、垃圾币、Wrapped SOL、空仓位）、构建时重新核对、模拟（模拟节点 / 假节点，不连网络） */
import { beforeEach, describe, expect, it } from 'vitest'

import { NATIVE_MINT, SolanaClient, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, decodeAddress, findProgramAddress, getAssociatedTokenAddress, getMetadataAddress } from '../src/index.js'
import { ORCA_WHIRLPOOL_PROGRAM_ID, utf8 } from '../src/lp.js'
import { resetNodeHealth } from '../src/rpc.js'
import { resetClientCache } from '../src/shortcuts.js'
import { buildReclaim, getReclaimable, reclaim, reclaimable, simulateReclaim, type ReclaimItem } from '../src/subpaths/reclaim.js'
import { createFakeSolana, keypair } from './fakeSolana.js'
import { createMockNode, metaplexData, mintData, tokenAccountData, type MockAccount } from './mock.js'

const OWNER = keypair(1).address
const OTHER = keypair(2).address
const POOL = keypair(3).address
const mintOf = (n: number) => keypair(n).address
const META = 'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s'

/** 代币账户（165 字节）：amount、冻结、关闭权限、Wrapped SOL */
function account(mint: string, o: { amount?: bigint; frozen?: boolean; native?: boolean; closeAuthority?: string } = {}): Uint8Array {
  const out = tokenAccountData(mint, OWNER, o.amount ?? 0n)
  const view = new DataView(out.buffer)
  out[108] = o.frozen ? 2 : 1
  if (o.native) {
    view.setUint32(109, 1, true)
    view.setBigUint64(113, 2_039_280n, true)
  }
  if (o.closeAuthority) {
    view.setUint32(129, 1, true)
    out.set(decodeAddress(o.closeAuthority), 133)
  }
  return out
}

/** Orca Position（216 字节）：pool 8、mint 40、liquidity 72、owed 112 / 136 */
function orcaPosition(mint: string, o: { liquidity?: bigint; owed0?: bigint } = {}): Uint8Array {
  const out = new Uint8Array(216)
  const view = new DataView(out.buffer)
  out.set(decodeAddress(POOL), 8)
  out.set(decodeAddress(mint), 40)
  view.setBigUint64(72, o.liquidity ?? 0n, true)
  view.setBigUint64(112, o.owed0 ?? 0n, true)
  return out
}

const ata = (mint: string, program = TOKEN_PROGRAM_ID) => getAssociatedTokenAddress(OWNER, mint, program)
const positionPda = (mint: string) => findProgramAddress([utf8('position'), decodeAddress(mint)], ORCA_WHIRLPOOL_PROGRAM_ID)

const EMPTY = mintOf(10)
const FROZEN = mintOf(11)
const SPAM = mintOf(12)
const UNKNOWN = mintOf(13)
const VALUABLE = mintOf(14)
const NFT_EMPTY = mintOf(15)
const NFT_OWED = mintOf(16)
const T22_EMPTY = mintOf(17)

function setup() {
  const accounts: Record<string, MockAccount> = {}
  const put = (address: string, a: MockAccount) => (accounts[address] = { lamports: 2_039_280n, ...a })
  const mint = (m: string, decimals: number, program = TOKEN_PROGRAM_ID) => put(m, { owner: program, lamports: 1_461_600n, data: mintData({ decimals }) })
  const holding = (m: string, o: Parameters<typeof account>[1], program = TOKEN_PROGRAM_ID) => put(ata(m, program), { owner: program, data: account(m, o) })
  for (const m of [EMPTY, FROZEN, SPAM, UNKNOWN, VALUABLE]) mint(m, 6)
  put(getMetadataAddress(SPAM), { owner: META, data: metaplexData({ mint: SPAM, name: 'Claim', symbol: 'claim-rewards.xyz' }) })
  holding(EMPTY, {})
  holding(FROZEN, { frozen: true })
  holding(NATIVE_MINT, { native: true, amount: 5_000_000n })
  accounts[ata(NATIVE_MINT)]!.lamports = 7_039_280n // 租金 + 包装的 SOL
  holding(SPAM, { amount: 777n })
  holding(UNKNOWN, { amount: 1_000_000n })
  holding(VALUABLE, { amount: 100_000_000n })
  // Token-2022 空账户
  mint(T22_EMPTY, 6, TOKEN_2022_PROGRAM_ID)
  holding(T22_EMPTY, {}, TOKEN_2022_PROGRAM_ID)
  // 仓位 NFT：一个已清空、一个还有没领的手续费（Token-2022 NFT，mint 一起关闭）
  mint(NFT_EMPTY, 0)
  holding(NFT_EMPTY, { amount: 1n })
  put(positionPda(NFT_EMPTY), { owner: ORCA_WHIRLPOOL_PROGRAM_ID, lamports: 1_000_000n, data: orcaPosition(NFT_EMPTY) })
  mint(NFT_OWED, 0, TOKEN_2022_PROGRAM_ID)
  holding(NFT_OWED, { amount: 1n }, TOKEN_2022_PROGRAM_ID)
  put(positionPda(NFT_OWED), { owner: ORCA_WHIRLPOOL_PROGRAM_ID, lamports: 1_000_000n, data: orcaPosition(NFT_OWED, { owed0: 5n }) })
  const node = createMockNode({ accounts })
  const mints = [EMPTY, FROZEN, SPAM, UNKNOWN, VALUABLE, T22_EMPTY, NFT_EMPTY, NFT_OWED, NATIVE_MINT]
  const prices = { name: 'test', prices: async () => new Map([[VALUABLE, 1]]) }
  return { node, accounts, client: new SolanaClient(node), mints, prices }
}

beforeEach(() => {
  resetNodeHealth()
  resetClientCache()
})

describe('reclaimable', () => {
  it('空账户、Wrapped SOL、垃圾币、空仓位；冻结的和还有手续费的仓位在 blocked；有价值的不列', async () => {
    const { client, mints, prices } = setup()
    const r = await reclaimable(client, OWNER, { mints, prices })
    const by = (kind: string) => r.items.filter((i) => i.kind === kind)
    expect(by('empty-token').map((i) => i.mint).sort()).toEqual([EMPTY, T22_EMPTY].sort())
    expect(by('wrapped-sol')[0]).toMatchObject({ mint: NATIVE_MINT, amount: '5000000', lamports: '7039280', rentLamports: '2039280', selected: true })
    // 垃圾币：名字可疑只是提示（没有价格 / 风险标记的不勾选）；没有价格也没有特征的列出但不勾选；有价格且价值高的不当垃圾币
    expect(by('junk-token').map((i) => [i.mint, i.selected, i.reasons])).toEqual([
      [SPAM, false, ['no-price', 'spam-name']],
      [UNKNOWN, false, ['no-price']],
    ])
    // 空仓位：Token-2022 NFT 连 mint 一起退回
    expect(by('orca-position')).toHaveLength(1)
    expect(by('orca-position')[0]).toMatchObject({ mint: NFT_EMPTY, lamports: (1_000_000n + 2_039_280n).toString(), position: { protocol: 'orca-whirlpool', pool: POOL } })
    expect(r.blocked.map((i) => [i.mint, i.blocker])).toEqual([
      [FROZEN, 'frozen'],
      [NFT_OWED, 'owed'],
    ])
    expect(r.items.some((i) => i.mint === VALUABLE)).toBe(false)
    expect(BigInt(r.totalLamports)).toBeGreaterThan(BigInt(r.selectedLamports))
    expect(r.byKind['empty-token']?.count).toBe(2)
  })

  it('仓位 NFT 的代币账户被冻结时放进 blocked，不算在 items 里', async () => {
    const { accounts, mints, client } = setup()
    accounts[ata(NFT_EMPTY)]!.data = account(NFT_EMPTY, { amount: 1n, frozen: true })
    const r = await reclaimable(client, OWNER, { mints, prices: false })
    expect(r.items.some((i) => i.mint === NFT_EMPTY)).toBe(false)
    expect(r.blocked.find((i) => i.mint === NFT_EMPTY)).toMatchObject({ kind: 'orca-position', blocker: 'frozen' })
  })

  it('价格没查到或关闭时垃圾币都不自动勾选；isJunk 可以强制 / 排除；junk: false 不找垃圾币', async () => {
    const { client, mints } = setup()
    const failing = { name: 'bad', prices: async () => Promise.reject(new Error('down')) }
    const down = await reclaimable(client, OWNER, { mints, prices: failing })
    expect(down.items.filter((i) => i.kind === 'junk-token').map((i) => i.selected)).toEqual([false, false, false]) // 没有价格时连有价值的也只是列出
    expect(down.warnings[0]).toMatch(/Price lookup failed/)
    const off = await reclaimable(client, OWNER, { mints, prices: false })
    expect(off.items.filter((i) => i.kind === 'junk-token' && i.selected)).toEqual([])

    const { prices } = setup()
    const custom = await reclaimable(client, OWNER, { mints, prices, isJunk: ({ account: a }) => (a.mint === UNKNOWN ? true : a.mint === SPAM ? false : a.mint === VALUABLE ? true : undefined) })
    const junk = custom.items.filter((i) => i.kind === 'junk-token')
    expect(junk.map((i) => [i.mint, i.selected, i.reasons])).toEqual([
      [UNKNOWN, true, ['custom']],
      [VALUABLE, true, ['custom']], // 应用明确说是垃圾币
    ])
    const none = await reclaimable(client, OWNER, { mints, prices, junk: false })
    expect(none.items.some((i) => i.kind === 'junk-token')).toBe(false)
  })

  it('快捷函数、地址检查', async () => {
    const { node, mints, prices } = setup()
    const r = await getReclaimable(OWNER, { provider: node, mints, prices })
    expect(r.owner).toBe(OWNER)
    await expect(reclaimable(new SolanaClient(node), 'bad')).rejects.toThrow(/Invalid owner/)
  })
})

describe('buildReclaim', () => {
  const kinds = (ix: { programId: string; data: Uint8Array }[]) => ix.map((i) => i.data[0])

  it('空账户：关闭；垃圾币：销毁 → 关闭；Wrapped SOL：关闭到 destination；仓位：关闭仓位', async () => {
    const { client, mints, prices } = setup()
    const r = await reclaimable(client, OWNER, { mints, prices, isJunk: ({ account: a }) => (a.mint === SPAM ? true : undefined) })
    const plan = await buildReclaim(client, OWNER, r.items.filter((i) => i.selected), { destination: OTHER })
    expect(plan.skipped).toEqual([])
    const call = (kind: string) => plan.calls.find((c) => c.kind === kind)!
    expect(kinds(call('junk-token').instructions)).toEqual([15, 9]) // BurnChecked、CloseAccount
    expect(call('junk-token').instructions[1]!.keys[1]!.pubkey).toBe(OTHER)
    expect(call('wrapped-sol').instructions[0]!.keys[1]!.pubkey).toBe(OTHER)
    expect(call('orca-position').instructions).toHaveLength(1)
    expect(call('orca-position').instructions[0]!.programId).toBe(ORCA_WHIRLPOOL_PROGRAM_ID)
    expect(plan.calls.every((c) => c.owner === OWNER)).toBe(true)
    expect(BigInt(plan.lamports)).toBeGreaterThan(0n)
  })

  it('Token-2022 空账户有暂存手续费时先收到 mint 上再关闭', async () => {
    const { client, accounts, mints, prices } = setup()
    const r = await reclaimable(client, OWNER, { mints, prices })
    const item = r.items.find((i) => i.mint === T22_EMPTY)!
    // 账户里有暂存的转账手续费（TransferFeeAmount 扩展）：在账户数据后补上账户类型 + TLV
    const withheld = new Uint8Array(8)
    new DataView(withheld.buffer).setBigUint64(0, 9n, true)
    accounts[ata(T22_EMPTY, TOKEN_2022_PROGRAM_ID)]!.data = new Uint8Array([...account(T22_EMPTY), 2, 2, 0, 8, 0, ...withheld])
    const plan = await buildReclaim(client, OWNER, [{ ...item, withheldAmount: '9' }])
    expect(plan.calls[0]!.instructions.map((i) => [...i.data])).toEqual([[26, 4], [9]])
  })

  it('重新读取：余额变了、被冻结、有人转入、仓位有了手续费的都不构建', async () => {
    const { client, accounts, mints, prices } = setup()
    const r = await reclaimable(client, OWNER, { mints, prices })
    const pick = (mint: string) => r.items.find((i) => i.mint === mint) as ReclaimItem
    // 空账户被转入了代币
    accounts[ata(EMPTY)]!.data = account(EMPTY, { amount: 3n })
    // 垃圾币的余额变了
    accounts[ata(SPAM)]!.data = account(SPAM, { amount: 778n })
    // 账户被冻结
    accounts[ata(NATIVE_MINT)]!.data = account(NATIVE_MINT, { native: true, amount: 5_000_000n, frozen: true })
    // 仓位产生了手续费
    accounts[positionPda(NFT_EMPTY)]!.data = orcaPosition(NFT_EMPTY, { owed0: 1n })
    const plan = await buildReclaim(client, OWNER, [pick(EMPTY), pick(SPAM), pick(NATIVE_MINT), pick(NFT_EMPTY), pick(T22_EMPTY)])
    expect(plan.calls.map((c) => c.item.mint)).toEqual([T22_EMPTY])
    expect(plan.skipped.map((s) => [s.item.mint, s.reason])).toEqual([
      [EMPTY, 'account is not empty anymore'],
      [SPAM, 'balance changed since the scan'],
      [NATIVE_MINT, 'account is frozen'],
      [NFT_EMPTY, 'position is not empty (has liquidity or unclaimed fees / rewards)'],
    ])
  })

  it('不是自己的账户、blocked 的项、不合法的 destination 直接报错', async () => {
    const { client, mints, prices } = setup()
    const r = await reclaimable(client, OWNER, { mints, prices })
    await expect(buildReclaim(client, OTHER, r.items.slice(0, 1))).rejects.toThrow(/belongs to/)
    await expect(buildReclaim(client, OWNER, r.blocked.slice(0, 1))).rejects.toThrow(/cannot be reclaimed yet \(frozen\)/)
    await expect(buildReclaim(client, OWNER, r.items.slice(0, 1), { destination: 'bad' })).rejects.toThrow(/Invalid destination/)
  })
})

describe('reclaim（假链：模拟 → 发送）', () => {
  function chain() {
    const c = createFakeSolana({
      programs: {
        // 假节点没有实现 BurnChecked：把余额清零
        [TOKEN_PROGRAM_ID]: (ix, state) => {
          if (ix.data[0] !== 15 || !ix.signers[2]) throw new Error('unsupported')
          const acc = state[ix.keys[0] as string] as MockAccount
          new DataView((acc.data as Uint8Array).buffer).setBigUint64(64, 0n, true)
        },
      },
    })
    const key = keypair(1)
    c.setSol(key.address, 1_000_000_000n)
    const [empty, junk] = [mintOf(60), mintOf(61)]
    c.addMint(empty, 6)
    c.addMint(junk, 6)
    const emptyAta = c.setToken(key.address, empty, 0n)
    const junkAta = c.setToken(key.address, junk, 5n)
    return { c, key, mints: [empty, junk], emptyAta, junkAta, client: new SolanaClient(c.transport) }
  }
  const fast = { pollInterval: 1, timeout: 5_000, priorityFee: 0 }

  it('dryRun 只模拟：给出预计退回的 SOL，不发送；发送后账户关闭、租金退到 destination', async () => {
    const { c, key, mints, emptyAta, junkAta, client } = chain()
    const r = await reclaimable(client, key.address, { mints, prices: false, isJunk: () => true })
    expect(r.items.map((i) => i.kind)).toEqual(['empty-token', 'junk-token'])

    const dry = await reclaim(client, key.secretKey, r.items, { dryRun: true, ...fast })
    expect(dry.results.map((x) => x.status)).toEqual(['simulated', 'simulated'])
    expect(dry.simulation).toMatchObject({ success: true, lamports: '4078560', lamportsSource: 'simulation' })
    expect(c.sent).toHaveLength(0)
    expect(c.accounts[emptyAta]).toBeDefined()

    const done = await reclaim(client, key.secretKey, r.items, { destination: OTHER, ...fast })
    expect(done.results.map((x) => x.status)).toEqual(['confirmed', 'confirmed'])
    expect(done.simulation?.lamportsSource).toBe('estimate') // 收款地址不是付款人：按账户余额估算
    expect(c.accounts[emptyAta]).toBeUndefined()
    expect(c.accounts[junkAta]).toBeUndefined()
    expect(c.sol(OTHER)).toBe(4_078_560n)
    expect(c.sent).toHaveLength(1) // 两个账户打包进一笔交易
  })

  it('模拟失败的账户不发送，找出是哪一个；签名者必须是 owner', async () => {
    const { c, key, mints, emptyAta, client } = chain()
    const r = await reclaimable(client, key.address, { mints, prices: false, isJunk: () => true })
    // 账户在构建后、模拟前换了 owner（假节点：关闭失败 owner does not match）
    const plan = await buildReclaim(client, key.address, r.items)
    ;(c.accounts[emptyAta] as MockAccount).data = tokenAccountData(mints[0] as string, OTHER, 0n)
    const sim = await simulateReclaim(client, plan)
    expect(sim.success).toBe(false)
    expect(sim.failed.map((f) => f.index)).toEqual([0])
    await expect(reclaim(client, keypair(9).secretKey, r.items, fast)).rejects.toThrow(/belongs to/)
  })
})
