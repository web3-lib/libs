/** 兑换：找路线、报价、消息格式、交易链里收到的数量（假的 toncenter，不连网络） */
import { beforeEach, describe, expect, it } from 'vitest'

import { NATIVE_TON, TonClient, toFriendlyAddress, toRawAddress, type TonTransport } from '../src/index.js'
import { DEDUST_FACTORY, PTON_V2_MASTER, dedustAsset, dedustAssetCell } from '../src/lp.js'
import { resetPoolCache, stonfiRouters } from '../src/pools.js'
import { TON_USDT, buildSwap, receivedInTrace, stonfiV2SwapOut } from '../src/subpaths/swap.js'
import { Cell, beginCell, type Slice } from '../src/write/cell.js'
import type { Trace } from '../src/write/send.js'

const a = (n: number) => `0:${n.toString(16).padStart(64, 'c')}`
const ROUTER = stonfiRouters().routers[1] as string
const OWNER = a(1)
const JET = a(2)
const [W_PTON, W_USDT, W_JET] = [a(10), a(11), a(12)]
/** STON.fi v2 池子：JET/TON、USD₮/TON；DeDust：JET/TON */
const [P_JET_TON, P_USDT_TON, D_JET_TON, D_NONE] = [a(20), a(21), a(22), a(29)]
const [VAULT_TON, VAULT_JET] = [a(30), a(31)]
const [OW_JET, OW_USDT] = [a(40), a(41)]
const E9 = 10n ** 9n
const E6 = 10n ** 6n

const POOLS: Record<string, string> = { [`${W_JET}|${W_PTON}`]: P_JET_TON, [`${W_USDT}|${W_PTON}`]: P_USDT_TON }
/** reserve0, reserve1, wallet0, wallet1 */
const DATA: Record<string, [bigint, bigint, string, string]> = {
  // JET = 50 TON
  [P_JET_TON]: [1000n * E9, 50_000n * E9, W_JET, W_PTON],
  // TON = 3 USD₮
  [P_USDT_TON]: [3_000_000n * E6, 1_000_000n * E9, W_USDT, W_PTON],
}

function fakeChain() {
  const calls: string[] = []
  const stack = (entries: Array<bigint | Cell>) => entries.map((e) => (typeof e === 'bigint' ? { type: 'num', value: `0x${e.toString(16)}` } : { type: 'cell', value: e.toBase64() }))
  const addr = (x: string) => beginCell().storeAddress(x).endCell()
  const argAddress = (v: { value: string }) => toRawAddress(Cell.fromBase64(v.value).beginParse().loadAddress() as never)
  const transport: TonTransport = {
    async get(path, query) {
      calls.push(path)
      if (path === 'jetton/masters') return { jetton_masters: (query.address as string[]).map((x) => ({ address: x, jetton_content: { decimals: x === TON_USDT ? '6' : '9', symbol: x === TON_USDT ? 'USD₮' : 'JET' } })) } as never
      if (path === 'jetton/wallets') {
        const wallets: Record<string, string> = { [PTON_V2_MASTER]: W_PTON, [TON_USDT]: W_USDT, [JET]: W_JET }
        const hit = wallets[query.jetton_address as string]
        return { jetton_wallets: hit && (query.owner_address as string[]).includes(ROUTER) ? [{ address: hit, owner: ROUTER, balance: '1000' }] : [] } as never
      }
      if (path === 'accountStates') return { accounts: (query.address as string[]).map((x) => ({ address: x, balance: '1', status: x === D_NONE ? 'nonexist' : 'active' })) } as never
      throw new Error(`unexpected ${path}`)
    },
    async post(_path, body) {
      const { address, method, stack: args } = body as { address: string; method: string; stack: Array<{ value: string }> }
      calls.push(method)
      if (address === ROUTER && method === 'get_router_data') return { exit_code: 0, stack: stack([1n, beginCell().storeBytes(new TextEncoder().encode('constant_product')).endCell()]) } as never
      if (address === ROUTER && method === 'get_pool_address') {
        const [x, y] = args.map(argAddress)
        const pool = POOLS[`${x}|${y}`] ?? POOLS[`${y}|${x}`]
        return pool ? ({ exit_code: 0, stack: stack([addr(pool)]) } as never) : ({ exit_code: 9, stack: [] } as never)
      }
      const d = DATA[address]
      if (d && method === 'get_pool_data') return { exit_code: 0, stack: stack([0n, addr(ROUTER), 10n ** 15n, d[0], d[1], addr(d[2]), addr(d[3]), 20n, 10n]) } as never
      if (address === DEDUST_FACTORY && method === 'get_pool_address') {
        const [, x, y] = args.map((v) => (v.value.startsWith('0x') ? '' : dedustAsset(Cell.fromBase64(v.value))))
        return { exit_code: 0, stack: stack([addr([x, y].sort().join('|') === [JET, NATIVE_TON].sort().join('|') ? D_JET_TON : D_NONE)]) } as never
      }
      if (address === DEDUST_FACTORY && method === 'get_vault_address') return { exit_code: 0, stack: stack([addr(dedustAsset(Cell.fromBase64((args[0] as { value: string }).value)) === NATIVE_TON ? VAULT_TON : VAULT_JET)]) } as never
      if (address === D_JET_TON && method === 'estimate_swap_out') {
        // DeDust 比 STON.fi 少给 1%
        const assetIn = dedustAsset(Cell.fromBase64((args[0] as { value: string }).value))
        const amount = BigInt((args[1] as { value: string }).value)
        const out = assetIn === NATIVE_TON ? (amount * 99n) / 5000n : (amount * 50n * 99n) / 100n
        return { exit_code: 0, stack: stack([dedustAssetCell(assetIn === NATIVE_TON ? JET : NATIVE_TON), out, 0n]) } as never
      }
      if (method === 'get_wallet_address') return { exit_code: 0, stack: stack([addr(address === JET ? OW_JET : OW_USDT)]) } as never
      return { exit_code: 11, stack: [] } as never
    },
  }
  return { ton: new TonClient(transport), calls }
}

const addressOf = (s: Slice) => {
  const x = s.loadAddress()
  return x ? toRawAddress(x) : null
}
const bodyOf = (plan: { messages: Array<{ body: string }> }) => Cell.fromBase64((plan.messages[0] as { body: string }).body).beginParse()

/** STON.fi v2 的 swap / cross_swap：op、ask 钱包、退款、多余 TON、deadline 和引用里的参数 */
function readStonfi(s: Slice) {
  const op = Number(s.loadUint(32))
  const ask = addressOf(s)
  const refund = addressOf(s)
  const excess = addressOf(s)
  const deadline = Number(s.loadUint(64))
  const r = s.loadRef().beginParse()
  const minOut = r.loadCoins()
  const receiver = addressOf(r)
  const fwdGas = r.loadCoins()
  const custom = r.loadMaybeRef()
  r.loadCoins()
  r.loadMaybeRef()
  const refFee = Number(r.loadUint(16))
  const ref = addressOf(r)
  return { op, ask, refund, excess, deadline, minOut, receiver, fwdGas, custom, refFee, ref }
}

/** 跳过 Jetton 转账的头，返回 [数量, 目标, forward TON, forward payload] */
function readTransfer(s: Slice): [bigint, string | null, bigint, Cell] {
  expect(Number(s.loadUint(32))).toBe(0x0f8a7ea5)
  s.loadUint(64)
  const amount = s.loadCoins()
  const to = addressOf(s)
  expect(addressOf(s)).toBe(OWNER)
  expect(s.loadBit()).toBe(false)
  const forward = s.loadCoins()
  expect(s.loadBit()).toBe(true)
  return [amount, to, forward, s.loadRef()]
}

beforeEach(() => resetPoolCache())

describe('stonfiV2SwapOut', () => {
  it('与合约的 get_swap_out 相同：先扣 LP 手续费，协议费向上取整', () => {
    // 1 JET 卖进 1000 JET / 50000 TON 的池子，LP 费 0.2%、协议费 0.1%
    expect(stonfiV2SwapOut(E9, 1000n * E9, 50_000n * E9, 20n, 10n)).toBe(49_850_249_451n - 49_850_250n)
    expect(stonfiV2SwapOut(E9, 1000n * E9, 50_000n * E9, 20n, 0n)).toBe(49_850_249_451n)
  })
})

describe('buildSwap', () => {
  it('TON → Jetton：STON.fi v2 和 DeDust 都报价，选输出多的；pTON 的 ton_transfer 带 swap，最少收到按滑点', async () => {
    const { ton } = fakeChain()
    const before = Math.floor(Date.now() / 1000)
    const plan = await buildSwap(ton, OWNER, { tokenIn: NATIVE_TON, tokenOut: JET, amountInFormatted: '10' }, { intermediates: [] })
    const expected = stonfiV2SwapOut(10n * E9, 50_000n * E9, 1000n * E9, 20n, 10n)
    expect(plan.route).toMatchObject({ protocol: 'stonfi-v2', path: [NATIVE_TON, toFriendlyAddress(JET)], pools: [toFriendlyAddress(P_JET_TON)], routers: [toFriendlyAddress(ROUTER)], amountOut: expected.toString() })
    expect(plan.routes.map((r) => r.protocol)).toEqual(['stonfi-v2', 'dedust'])
    expect(plan.amountOutMin).toBe(((expected * 995n) / 1000n).toString())
    expect(plan.tokenOut).toMatchObject({ symbol: 'JET', decimals: 9 })
    expect(plan.priceImpact).toBeGreaterThan(0)
    expect(plan.priceImpact).toBeLessThan(0.001)
    expect(plan.messages[0]).toMatchObject({ to: toFriendlyAddress(W_PTON), value: (10n * E9 + 310_000_000n).toString(), bounce: true })
    expect(plan.tonAttached).toBe(plan.messages[0]?.value)
    const s = bodyOf(plan)
    expect(Number(s.loadUint(32))).toBe(0x01f3835d)
    s.loadUint(64)
    expect(s.loadCoins()).toBe(10n * E9)
    expect(addressOf(s)).toBe(OWNER)
    const swap = readStonfi((s.loadMaybeRef() as Cell).beginParse())
    expect(swap).toMatchObject({ op: 0x6664de2a, ask: W_JET, refund: OWNER, excess: OWNER, minOut: BigInt(plan.amountOutMin), receiver: OWNER, fwdGas: 0n, custom: null, refFee: 10, ref: null })
    expect(swap.deadline - before).toBeGreaterThanOrEqual(900)
    expect(swap.deadline - before).toBeLessThan(905)
  })

  it('Jetton → Jetton 两跳（经过 TON）：第一跳的 custom_payload 是 cross_swap，最后一跳按 amountOutMin；多带一跳的 gas', async () => {
    const { ton } = fakeChain()
    const plan = await buildSwap(ton, OWNER, { tokenIn: JET, tokenOut: TON_USDT, amountIn: 2n * E9 }, { slippage: 0.01, recipient: a(5) })
    const ton1 = stonfiV2SwapOut(2n * E9, 1000n * E9, 50_000n * E9, 20n, 10n)
    const expected = stonfiV2SwapOut(ton1, 1_000_000n * E9, 3_000_000n * E6, 20n, 10n)
    expect(plan.route).toMatchObject({ protocol: 'stonfi-v2', path: [toFriendlyAddress(JET), NATIVE_TON, toFriendlyAddress(TON_USDT)], amountOut: expected.toString() })
    expect(plan.amountOutMin).toBe(((expected * 99n) / 100n).toString())
    expect(plan.recipient).toBe(toFriendlyAddress(a(5), { bounceable: false }))
    // 卖出 Jetton：发给 owner 自己的 Jetton 钱包，转给 router
    expect(plan.messages[0]).toMatchObject({ to: toFriendlyAddress(OW_JET), value: '400000000' })
    const [amount, to, forward, payload] = readTransfer(bodyOf(plan))
    expect([amount, to, forward]).toEqual([2n * E9, ROUTER, 340_000_000n])
    const hop1 = readStonfi(payload.beginParse())
    expect(hop1).toMatchObject({ op: 0x6664de2a, ask: W_PTON, minOut: 1n, receiver: a(5) })
    const hop2 = readStonfi((hop1.custom as Cell).beginParse())
    expect(hop2).toMatchObject({ op: 0x69cf1a5b, ask: W_USDT, refund: OWNER, minOut: BigInt(plan.amountOutMin), receiver: a(5), custom: null })
  })

  it('DeDust：TON 卖给 TON vault（swap 带池子、limit、deadline、收款人），Jetton 卖给 Jetton vault', async () => {
    const { ton } = fakeChain()
    const plan = await buildSwap(ton, OWNER, { tokenIn: NATIVE_TON, tokenOut: JET, amountInFormatted: '5' }, { protocols: ['dedust'] })
    expect(plan.route).toMatchObject({ protocol: 'dedust', routers: [], amountOut: ((5n * E9 * 99n) / 5000n).toString() })
    expect(plan.messages[0]).toMatchObject({ to: toFriendlyAddress(VAULT_TON), value: (5n * E9 + 200_000_000n).toString() })
    const s = bodyOf(plan)
    expect(Number(s.loadUint(32))).toBe(0xea06185d)
    s.loadUint(64)
    expect(s.loadCoins()).toBe(5n * E9)
    expect(addressOf(s)).toBe(D_JET_TON)
    expect(s.loadBit()).toBe(false)
    expect(s.loadCoins()).toBe(BigInt(plan.amountOutMin))
    expect(s.loadMaybeRef()).toBeNull()
    const params = s.loadRef().beginParse()
    expect(Number(params.loadUint(32))).toBeGreaterThan(Date.now() / 1000)
    expect(addressOf(params)).toBe(OWNER)
    expect(addressOf(params)).toBeNull()

    const sell = await buildSwap(ton, OWNER, { tokenIn: JET, tokenOut: NATIVE_TON, amountInFormatted: '1' }, { protocols: ['dedust'] })
    expect(sell.messages[0]).toMatchObject({ to: toFriendlyAddress(OW_JET), value: '300000000' })
    const [amount, to, forward, payload] = readTransfer(bodyOf(sell))
    expect([amount, to, forward]).toEqual([E9, VAULT_JET, 250_000_000n])
    const p = payload.beginParse()
    expect(Number(p.loadUint(32))).toBe(0xe3a0d482)
    expect(addressOf(p)).toBe(D_JET_TON)
    p.loadBit()
    expect(p.loadCoins()).toBe(BigInt(sell.amountOutMin))
  })

  it('route：指定 routes 里的某一条（不选最好的）；对不上的路线报错', async () => {
    const { ton } = fakeChain()
    const best = await buildSwap(ton, OWNER, { tokenIn: NATIVE_TON, tokenOut: JET, amountInFormatted: '10' }, { intermediates: [] })
    const other = best.routes[1]
    if (!other) throw new Error('no second route')
    const plan = await buildSwap(ton, OWNER, { tokenIn: NATIVE_TON, tokenOut: JET, amountInFormatted: '10' }, { intermediates: [], route: other })
    expect(plan.route).toEqual(other)
    expect(plan.routes).toEqual([other])
    await expect(buildSwap(ton, OWNER, { tokenIn: NATIVE_TON, tokenOut: JET, amountInFormatted: '10' }, { route: { ...other, pools: [toFriendlyAddress(D_NONE)] } })).rejects.toThrow(/given route/)
  })

  it('报错：同一个代币、找不到路线、数量为 0、测试网', async () => {
    const { ton } = fakeChain()
    await expect(buildSwap(ton, OWNER, { tokenIn: JET, tokenOut: toFriendlyAddress(JET), amountIn: 1n })).rejects.toThrow(/same/)
    await expect(buildSwap(ton, OWNER, { tokenIn: JET, tokenOut: NATIVE_TON, amountIn: 1n }, { protocols: ['stonfi-v1'] })).rejects.toThrow(/No route/)
    await expect(buildSwap(ton, OWNER, { tokenIn: JET, tokenOut: NATIVE_TON, amountIn: 0n })).rejects.toThrow(/greater than 0/)
    const testnet = new TonClient({ get: () => Promise.reject(new Error('x')), post: () => Promise.reject(new Error('x')) }, { network: 'testnet' })
    await expect(buildSwap(testnet, OWNER, { tokenIn: JET, tokenOut: NATIVE_TON, amountIn: 1n })).rejects.toThrow(/mainnet/)
  })
})

describe('receivedInTrace', () => {
  const coinsBody = (op: number, amount: bigint) => beginCell().storeUint(op, 32).storeUint(0, 64).storeCoins(amount).endCell().toBase64()
  const tx = (hash: string, account: string, source: string | null, opcode: number, body: string | null, ok = true) => ({
    hash,
    account,
    description: { aborted: !ok, compute_ph: { success: ok } },
    in_msg: { hash: `m${hash}`, source, destination: account, value: '1', opcode: `0x${opcode.toString(16).padStart(8, '0')}`, bounced: false, message_content: { body } },
  })
  const traceOf = (...txs: ReturnType<typeof tx>[]): Trace => ({ trace: { tx_hash: 'root' }, transactions: Object.fromEntries(txs.map((t) => [t.hash, t])) })

  it('Jetton：收款人的 Jetton 钱包收到的 internal_transfer；失败的不算', () => {
    const t = traceOf(tx('1', OW_JET, a(9), 0x178d4519, coinsBody(0x178d4519, 123n)), tx('2', OW_JET, a(9), 0x178d4519, coinsBody(0x178d4519, 999n), false))
    expect(receivedInTrace(t, { kind: 'jetton', wallet: toFriendlyAddress(OW_JET) })).toBe(123n)
    expect(receivedInTrace(t, { kind: 'jetton', wallet: OW_USDT })).toBeNull()
  })

  it('TON：STON.fi 按 pTON 钱包发来的 ton_transfer 里的数量（不含多余的 gas），DeDust 按池子给 vault 的 payout_from_pool', () => {
    const ston = traceOf(tx('1', OWNER, W_PTON, 0x01f3835d, coinsBody(0x01f3835d, 72n)), tx('2', OWNER, a(9), 0x01f3835d, coinsBody(0x01f3835d, 5n)))
    expect(receivedInTrace(ston, { kind: 'pton', recipient: OWNER, payer: W_PTON })).toBe(72n)
    const payout = beginCell().storeUint(0xad4eb6f5, 32).storeUint(0, 64).storeRef(Cell.EMPTY).storeCoins(1473n).storeAddress(OWNER).endCell().toBase64()
    const dedust = traceOf(tx('1', VAULT_TON, D_JET_TON, 0xad4eb6f5, payout), tx('2', OWNER, VAULT_TON, 0x474f86cf, null))
    expect(receivedInTrace(dedust, { kind: 'dedust', recipient: OWNER, vault: VAULT_TON, pool: D_JET_TON })).toBe(1473n)
    // vault 没把 TON 发出去
    expect(receivedInTrace(traceOf(tx('1', VAULT_TON, D_JET_TON, 0xad4eb6f5, payout)), { kind: 'dedust', recipient: OWNER, vault: VAULT_TON, pool: D_JET_TON })).toBeNull()
  })
})
