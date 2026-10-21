/**
 * 兑换：本地报价与主网模拟逐位核对，默认跳过：`LIVE=1 NODE_USE_ENV_PROXY=1 npx vitest run test/swap-live.test.ts`
 * - SOLANA_RPC：自己的节点；默认官方节点（getMultipleAccounts 一次最多 100 个账户）
 * - RECORD=1：把核对通过的快照写进 test/fixtures/swap-mainnet.json.gz（swap.test.ts 离线重放）
 *
 * 做法：同一个 JSON-RPC 批量请求里读账户（池子、配置、tick 数组、Oracle、Clock、用户的代币账户）和模拟兑换交易
 * （simulateTransaction，不验签名），两者的 context.slot 相同时说明是同一份链上状态；用读到的账户在本地重新报价，
 * 和模拟后代币账户的余额变化比较。用交易所热钱包（有 SOL 和 USDC）的身份模拟
 */
import { writeFileSync } from 'node:fs'
import { gzipSync } from 'node:zlib'

import { base64 } from '@scure/base'
import { beforeEach, describe, expect, it } from 'vitest'

import { getAssociatedTokenAddress } from '../src/address.js'
import { ASSOCIATED_TOKEN_PROGRAM_ID, HttpRpc, NATIVE_MINT, SolanaClient, TOKEN_PROGRAM_ID } from '../src/index.js'
import { parseTokenAccount, type AccountInfo } from '../src/layout.js'
import { buildSwap, type SolanaSwapPlan, type SolanaSwapProtocol } from '../src/subpaths/swap.js'
import { CLOCK_SYSVAR_ID, NeedAccounts, parseClock, type HopQuote } from '../src/swap/common.js'
import { parseSwapPool } from '../src/swap/index.js'
import { setComputeUnitLimit } from '../src/write/instructions.js'
import { compileMessage, serializeTransaction, type AccountMeta } from '../src/write/transaction.js'

const live = process.env.LIVE ? describe : describe.skip
const url = process.env.SOLANA_RPC ?? 'https://api.mainnet-beta.solana.com'
const client = new SolanaClient(new HttpRpc(url, { batch: false, retries: 5 }))
/** 读账户和模拟放进同一个批量请求（大概率落在同一个节点、同一个 slot） */
const pair = new SolanaClient(new HttpRpc(url, { batch: true, retries: 5 }))

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
/** 有 SOL 和 USDC 的系统账户（Coinbase 热钱包，liquidity-live.test.ts 也用） */
const WHALE = 'H8sMJSCQxfKiFTCfDR3DUMLPwcRbM61LGFJ8N4dK3WjS'
const USDT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'
/** Token-2022，转账手续费 2.69%（2026-10） */
const BERN = 'CKfatsPMUf8SkiURsDXs7eK6GWb4Jsd6UDbs7twMCWxo'
const JUP = 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN'
const AMM_POOL = '58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2'
/** Raydium CLMM SOL / USDC（tick spacing 1，tick 上有限价单） */
const RAYDIUM_SOL_USDC = '3ucNos4NbumPLZNWztqGHNFFgkHeRMBQAVemeeomsUxv'
const RAYDIUM_USDC_USDT = 'BZtgQEyS6eXUXicYPHecYQ7PybqodXQMvkjUbP4R8mUU'
const RAYDIUM_SOL_USDT = '3nMFwZXwY1s1M5s8vYAHqd4wGs4iSxXE4LRoUMMYqEgF'
/** Orca SOL / USDC：自适应费率（有 Oracle 账户，tick spacing 1） */
const ORCA_ADAPTIVE = '83v8iPyZihDEjDdY8RdZddyZNyUtXngz69Lgo9Kt5d6d'
const ORCA_SOL_USDC = 'Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE'
/** 有 BERN、没有 SOL 的钱包（2026-10，从池子最近的交易里找到）；模拟时手续费和租金由 WHALE 付 */
const BERN_HOLDER = '2DEYQGxQoRQUWYkWRLWoZy6wSYEMaMsX4afU1gHSMcfL'
const CPMM_SOL_BERN = '2XWXUGtWs5m4Hvxrc978UsmYppw5wg9HaKVT2QMC36rb'

interface RawAccount {
  lamports: number
  owner: string
  data: [string, string]
  executable: boolean
}

const toInfo = (address: string, a: RawAccount | null): AccountInfo | null =>
  a ? { address, lamports: BigInt(a.lamports), owner: a.owner, data: base64.decode(a.data[0]), executable: a.executable } : null
const amountOf = (a: AccountInfo | null | undefined) => (a && a.data.length >= 72 ? parseTokenAccount(a.data).amount : 0n)

export interface Verified {
  label: string
  slot: number
  /** 每一跳：本地报价 */
  hops: Array<{ protocol: string; pool: string; tokenIn: string; amountIn: string; quoted: string; crossed: number | null; orders: number | null }>
  /** 模拟后用户买入代币账户的变化，两跳时还有中间代币账户的变化 */
  simulatedOut: string
  simulatedLeftover: string | null
  planOut: string
  accounts: Record<string, { owner: string; data: string } | null>
}

/** 同一 slot 读账户 + 模拟，本地重新报价；最多重试 attempts 次 */
async function verify(label: string, plan: SolanaSwapPlan, attempts = 20, payer = plan.owner): Promise<Verified> {
  const path = plan.route.path
  // 不关闭 wSOL 账户：才能读到模拟后收到的数量；payer 不是 owner 时（owner 没有 SOL）创建代币账户的租金也由 payer 付
  const instructions = [
    setComputeUnitLimit(1_400_000),
    ...plan.steps
      .flatMap((s) => s.instructions)
      .filter((ix) => !(ix.programId === TOKEN_PROGRAM_ID && ix.data[0] === 9))
      .map((ix) => (ix.programId === ASSOCIATED_TOKEN_PROGRAM_ID && payer !== plan.owner ? { ...ix, keys: [{ ...(ix.keys[0] as AccountMeta), pubkey: payer }, ...ix.keys.slice(1)] } : ix)),
  ]
  const message = compileMessage(payer, instructions, '11111111111111111111111111111111')
  const raw = base64.encode(serializeTransaction(message, message.signers.map(() => null)))
  const mints = await client.accounts(path)
  const atas = path.map((m, i) => getAssociatedTokenAddress(plan.owner, m, (mints[i] as AccountInfo).owner))
  let extra: string[] = []
  for (let attempt = 0; attempt < attempts; attempt++) {
    const base = [CLOCK_SYSVAR_ID, ...path, ...atas, ...plan.route.hops.map((h) => h.pool)]
    const addresses = [...new Set([...base, ...extra])]
    const [snap, sim] = await Promise.all([
      pair.request<{ context: { slot: number }; value: Array<RawAccount | null> }>('getMultipleAccounts', [addresses, { encoding: 'base64', commitment: 'confirmed' }]),
      pair.request<{ context: { slot: number }; value: { err: unknown; logs: string[] | null; accounts: Array<RawAccount | null> | null } }>('simulateTransaction', [
        raw,
        { encoding: 'base64', sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed', accounts: { encoding: 'base64', addresses: atas } },
      ]),
    ])
    const map = new Map(addresses.map((a, i) => [a, toInfo(a, snap.value[i] ?? null)]))
    const get = (a: string) => map.get(a)
    const pools = plan.route.hops.map((h) => parseSwapPool(map.get(h.pool) as AccountInfo))
    const needed = plan.route.hops.flatMap((h, i) => pools[i]?.accounts(pools[i].mint0 === h.tokenIn) ?? [])
    if (needed.some((a) => !map.has(a))) {
      extra = [...new Set([...extra, ...needed])]
      continue
    }
    if (snap.context.slot !== sim.context.slot) continue
    if (sim.value.err) throw new Error(`${label}: simulation failed: ${JSON.stringify(sim.value.err)}\n${(sim.value.logs ?? []).slice(-12).join('\n')}`)
    const env = parseClock((map.get(CLOCK_SYSVAR_ID) as AccountInfo).data)
    let quotes: HopQuote[]
    try {
      quotes = plan.route.hops.map((h, i) => (pools[i] as NonNullable<(typeof pools)[number]>).quote(get, BigInt(h.amountIn), pools[i]?.mint0 === h.tokenIn, env))
    } catch (err) {
      // 兑换走得比预读的 tick 数组远：补读后重来
      if (!(err instanceof NeedAccounts)) throw err
      extra = [...new Set([...extra, ...err.addresses])]
      continue
    }
    const after = (sim.value.accounts ?? []).map((a, i) => toInfo(atas[i] as string, a))
    const delta = (i: number) => amountOf(after[i]) - amountOf(map.get(atas[i] as string))
    const out = delta(path.length - 1)
    const leftover = path.length > 2 ? delta(1) : null
    const accounts: Verified['accounts'] = {}
    for (const [a, info] of map) accounts[a] = info ? { owner: info.owner, data: base64.encode(info.data) } : null
    return {
      label,
      slot: snap.context.slot,
      hops: plan.route.hops.map((h, i) => ({
        protocol: h.protocol,
        pool: h.pool,
        tokenIn: h.tokenIn,
        amountIn: h.amountIn,
        quoted: (quotes[i]?.amountOut ?? 0n).toString(),
        crossed: quotes[i]?.crossed ?? null,
        orders: quotes[i]?.orders ?? null,
      })),
      simulatedOut: out.toString(),
      simulatedLeftover: leftover === null ? null : leftover.toString(),
      planOut: plan.amountOut,
      accounts,
    }
  }
  throw new Error(`${label}: could not read the accounts and simulate at the same slot`)
}

/** 只用一个池子在本地报价（按需补读 tick 数组），测试里找能穿过限价单的数量 */
async function localQuote(pool: string, tokenIn: string, amount: bigint): Promise<HopQuote> {
  const [account] = await client.accounts([pool])
  const p = parseSwapPool(account as AccountInfo)
  if (!p) throw new Error(`not a pool: ${pool}`)
  const zeroForOne = p.mint0 === tokenIn
  let addresses = [CLOCK_SYSVAR_ID, ...p.accounts(zeroForOne)]
  for (;;) {
    const accounts = await client.accounts(addresses)
    const map = new Map(addresses.map((a, i) => [a, accounts[i] ?? null]))
    try {
      return p.quote((a) => map.get(a), amount, zeroForOne, parseClock((map.get(CLOCK_SYSVAR_ID) as AccountInfo).data))
    } catch (err) {
      if (!(err instanceof NeedAccounts)) throw err
      addresses = [...addresses, ...err.addresses]
    }
  }
}

/** 从 start 起按 2 倍加大数量，直到本地报价成交了限价单 */
async function amountFillingOrders(pool: string, tokenIn: string, start: bigint, max: bigint): Promise<bigint> {
  for (let amount = start; amount <= max; amount *= 2n) {
    const q = await localQuote(pool, tokenIn, amount)
    if ((q.orders ?? 0) > 0) return amount
  }
  throw new Error(`no limit order filled up to ${max}`)
}

const recorded: Verified[] = []

function check(v: Verified) {
  const last = v.hops[v.hops.length - 1] as Verified['hops'][number]
  const ticks = v.hops.map((h) => (h.crossed === null ? '-' : `${h.crossed} ticks${h.orders ? ` + ${h.orders} limit orders` : ''}`)).join(' / ')
  console.log(`${v.label} @${v.slot}: quote ${last.quoted} / simulated ${v.simulatedOut} (crossed ${ticks}; plan built earlier: ${v.planOut})${v.simulatedLeftover === null ? '' : `, leftover ${v.simulatedLeftover}`}`)
  expect(last.quoted).toBe(v.simulatedOut)
  if (v.simulatedLeftover !== null) {
    const first = v.hops[0] as Verified['hops'][number]
    expect((BigInt(first.quoted) - BigInt(last.amountIn)).toString()).toBe(v.simulatedLeftover)
  }
  recorded.push(v)
}

live('兑换（主网模拟核对）', { timeout: 300_000 }, () => {
  beforeEach(() => new Promise((resolve) => setTimeout(resolve, process.env.SOLANA_RPC ? 0 : 3000)))

  // 每个协议两个方向，用各协议默认找到的最好的 SOL / USDC 池子
  const cases: Array<{ protocol: SolanaSwapProtocol; pools?: string[] }> = [
    { protocol: 'raydium-clmm' },
    { protocol: 'orca-whirlpool' },
    { protocol: 'raydium-cpmm' },
    { protocol: 'raydium-amm', pools: [AMM_POOL] },
  ]
  for (const c of cases) {
    for (const [tokenIn, tokenOut, amount] of [
      [NATIVE_MINT, USDC, '3'],
      [USDC, NATIVE_MINT, '250'],
    ] as const) {
      it(`${c.protocol}：${tokenIn === NATIVE_MINT ? 'SOL → USDC' : 'USDC → SOL'}`, async () => {
        const plan = await buildSwap(client, WHALE, { tokenIn, tokenOut, amountInFormatted: amount }, { protocols: [c.protocol], intermediates: [], pools: c.pools })
        expect(plan.route.hops[0]?.protocol).toBe(c.protocol)
        check(await verify(`${c.protocol} ${tokenIn === NATIVE_MINT ? 'SOL→USDC' : 'USDC→SOL'} ${plan.route.hops[0]?.pool}`, plan))
      })
    }
  }

  // 指定池子（discover: false）：大额（穿过很多 tick、Raydium 的限价单）、自适应费率、Token-2022 转账手续费、两跳
  const special: Array<{ label: string; tokenIn: string; tokenOut: string; amount: string; pools: string[]; mids?: string[]; hops?: number; owner?: string }> = [
    { label: 'raydium-clmm 大额 SOL→USDC', tokenIn: NATIVE_MINT, tokenOut: USDC, amount: '3000', pools: [RAYDIUM_SOL_USDC] },
    { label: 'raydium-clmm 大额 USDC→SOL', tokenIn: USDC, tokenOut: NATIVE_MINT, amount: '400000', pools: [RAYDIUM_SOL_USDC] },
    { label: 'raydium-clmm USDC→USDT（稳定币池）', tokenIn: USDC, tokenOut: USDT, amount: '300000', pools: [RAYDIUM_USDC_USDT] },
    { label: '两跳 SOL→USDC→USDT（raydium + raydium）', tokenIn: NATIVE_MINT, tokenOut: USDT, amount: '2000', pools: [RAYDIUM_SOL_USDC, RAYDIUM_USDC_USDT], mids: [USDC], hops: 2 },
    { label: 'orca 自适应费率 大额 SOL→USDC', tokenIn: NATIVE_MINT, tokenOut: USDC, amount: '25', pools: [ORCA_ADAPTIVE] },
    { label: 'orca 自适应费率 大额 USDC→SOL', tokenIn: USDC, tokenOut: NATIVE_MINT, amount: '2500', pools: [ORCA_ADAPTIVE] },
    { label: 'orca 大额 SOL→USDC', tokenIn: NATIVE_MINT, tokenOut: USDC, amount: '3000', pools: [ORCA_SOL_USDC] },
    { label: 'orca 大额 USDC→SOL', tokenIn: USDC, tokenOut: NATIVE_MINT, amount: '300000', pools: [ORCA_SOL_USDC] },
    { label: 'cpmm SOL→BERN（Token-2022 转账手续费 2.69%，买入）', tokenIn: NATIVE_MINT, tokenOut: BERN, amount: '2', pools: [CPMM_SOL_BERN] },
    { label: '两跳 USDC→SOL→BERN（raydium + cpmm，买入有转账手续费）', tokenIn: USDC, tokenOut: BERN, amount: '200', pools: [RAYDIUM_SOL_USDC, CPMM_SOL_BERN], mids: [NATIVE_MINT], hops: 2 },
    { label: 'cpmm BERN→SOL（卖出有转账手续费）', tokenIn: BERN, tokenOut: NATIVE_MINT, amount: '20000', pools: [CPMM_SOL_BERN], owner: BERN_HOLDER },
    { label: '两跳 BERN→SOL→USDC（cpmm + raydium，卖出有转账手续费）', tokenIn: BERN, tokenOut: USDC, amount: '20000', pools: [CPMM_SOL_BERN, RAYDIUM_SOL_USDC], mids: [NATIVE_MINT], hops: 2, owner: BERN_HOLDER },
    { label: '两跳 USDC→SOL→USDT（orca + raydium）', tokenIn: USDC, tokenOut: USDT, amount: '5000', pools: [ORCA_SOL_USDC, RAYDIUM_SOL_USDT], mids: [NATIVE_MINT], hops: 2 },
  ]
  for (const c of special) {
    it(c.label, async () => {
      const plan = await buildSwap(client, c.owner ?? WHALE, { tokenIn: c.tokenIn, tokenOut: c.tokenOut, amountInFormatted: c.amount }, { discover: false, pools: c.pools, intermediates: c.mids ?? [] })
      expect(plan.route.hops.length).toBe(c.hops ?? 1)
      check(await verify(c.label, plan, 20, c.owner ? WHALE : plan.owner))
    })
  }

  // Raydium 的限价单：找一个让报价穿过 tick 上限价单的数量，再和模拟核对
  const orderCases: Array<{ label: string; pool: string; tokenIn: string; tokenOut: string; start: bigint; max: bigint }> = [
    { label: 'raydium-clmm 限价单 USDC→JUP', pool: 'Fu5uXjR17rGbUur294Ke3UxCH8JF5nWYYCe9wqNjDuFr', tokenIn: USDC, tokenOut: JUP, start: 10_000_000n, max: 200_000_000_000n },
    { label: 'raydium-clmm 限价单 SOL→JUP', pool: 'EZVkeboWeXygtq8LMyENHyXdF5wpYrtExRNH9UwB1qYw', tokenIn: NATIVE_MINT, tokenOut: JUP, start: 100_000_000n, max: 2_000_000_000_000n },
  ]
  for (const c of orderCases) {
    it(c.label, async () => {
      const amount = await amountFillingOrders(c.pool, c.tokenIn, c.start, c.max)
      const plan = await buildSwap(client, WHALE, { tokenIn: c.tokenIn, tokenOut: c.tokenOut, amountIn: amount }, { discover: false, pools: [c.pool], intermediates: [] })
      const v = await verify(c.label, plan)
      check(v)
      expect(v.hops[0]?.orders).toBeGreaterThan(0)
    })
  }

  it.skipIf(!process.env.RECORD)('写快照', () => {
    // gzip：tick 数组大多是 0，压缩后约为原来的 1 / 7
    writeFileSync(new URL('./fixtures/swap-mainnet.json.gz', import.meta.url), gzipSync(JSON.stringify({ capturedAt: new Date().toISOString().slice(0, 10), owner: WHALE, cases: recorded }), { level: 9 }))
  })
})
