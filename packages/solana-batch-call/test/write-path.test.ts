// 第二阶段写路径：优先费用复核、确认轮询少查区块高度、广播到所有节点 / 单独的发送节点、'auto' 优先费用去掉 0、打包合一
import { sha256 } from '@noble/hashes/sha2.js'
import { base58 } from '@scure/base'
import { beforeEach, describe, expect, it } from 'vitest'

import { SolanaClient, type RpcTransport } from '../src/index.js'
import { packCalls } from '../src/batchPlan.js'
import { resetNodeHealth } from '../src/rpc.js'
import { batchTransfer, setComputeUnitLimit, setComputeUnitPrice } from '../src/subpaths/write.js'
import { autoPriorityFee } from '../src/write/chain.js'
import { MAX_COMPUTE_UNITS } from '../src/write/instructions.js'
import { PLACEHOLDER_BLOCKHASH, packUnits } from '../src/write/pack.js'
import { MAX_ACCOUNT_LOCKS, PACKET_DATA_SIZE, compileMessage, transactionSize, type Instruction } from '../src/write/transaction.js'
import { RENT_EXEMPT_MIN, createFakeSolana, keypair } from './fakeSolana.js'

const P = keypair(51)
const R1 = keypair(21).address
const SOL = 1_000_000_000n
const fast = { pollInterval: 1, timeout: 5_000 }

beforeEach(() => {
  resetNodeHealth()
})

describe('优先费用：付得起就不再模拟第二次', () => {
  /** 一笔 SOL 转账（单价 1 lamport / CU）实际的优先费用：先 dryRun 拿计算单元，按 ×1.1 + 1000 算上限 */
  async function priorityOf(amount: bigint): Promise<bigint> {
    const chain = createFakeSolana()
    chain.setSol(P.address, 100n * SOL)
    const [r] = await batchTransfer(new SolanaClient(chain.transport), P.secretKey, [{ to: R1, amount }], { ...fast, priorityFee: 1_000_000, dryRun: true })
    const limit = Math.min(MAX_COMPUTE_UNITS, Math.ceil((r?.computeUnits as number) * 1.1) + 1000)
    return BigInt(limit) // 单价 1_000_000 micro-lamports = 每个计算单元 1 lamport
  }

  async function send(balance: bigint, amount: bigint) {
    const chain = createFakeSolana()
    chain.setSol(P.address, balance)
    const before = chain.simulations.length
    const [r] = await batchTransfer(new SolanaClient(chain.transport), P.secretKey, [{ to: R1, amount }], { ...fast, priorityFee: 1_000_000 })
    return { result: r, simulations: chain.simulations.length - before }
  }

  it('模拟后余额减去优先费用刚好等于免租下限：只模拟一次；少 1 lamport：再完整模拟一次', async () => {
    const amount = 1_000_000n
    const priority = await priorityOf(amount)
    // 模拟后余额 = 余额 - 5000（基础手续费）- 转出；再减优先费用 = 免租下限
    const exact = RENT_EXEMPT_MIN + priority + 5000n + amount
    const ok = await send(exact, amount)
    expect(ok.simulations).toBe(1)
    expect(ok.result?.status).toBe('confirmed')

    const short = await send(exact - 1n, amount)
    expect(short.simulations).toBe(2)
  })

  it('真的付不起优先费用时第二次模拟照常拦下（不发送）', async () => {
    const amount = 1_000_000n
    const priority = await priorityOf(amount)
    // 能付基础手续费、付不起优先费用：付完手续费后掉到免租下限以下
    const { result, simulations } = await send(RENT_EXEMPT_MIN + 5000n + amount + priority / 2n, amount)
    expect(simulations).toBe(2)
    expect(result?.status).toBe('failed')
  })
})

describe('确认轮询：只在可能过期时查区块高度', () => {
  it('交易要等 12 次轮询才上链：getEpochInfo 只查 1 次（之前每轮都查）', async () => {
    const chain = createFakeSolana({ landAfterPolls: 12 })
    chain.setSol(P.address, 10n * SOL)
    let epochCalls = 0
    let statusCalls = 0
    chain.intercept((method) => {
      if (method === 'getEpochInfo') epochCalls++
      if (method === 'getSignatureStatuses') statusCalls++
      return undefined
    })
    const [r] = await batchTransfer(new SolanaClient(chain.transport), P.secretKey, [{ to: R1, amount: 10_000_000n }], { ...fast, priorityFee: 0 })
    expect(r?.status).toBe('confirmed')
    expect(statusCalls).toBeGreaterThanOrEqual(12)
    expect(epochCalls).toBe(1)
  })

  it('快过期时照常查高度并判断过期、重发', async () => {
    // 第一个 blockhash 只有 3 个块有效、交易被丢弃：要靠过期检测换新 blockhash 重发
    const chain = createFakeSolana({ drop: 1, validBlocks: (call) => (call === 0 ? 3 : 150) })
    chain.setSol(P.address, 10n * SOL)
    let epochCalls = 0
    chain.intercept((method) => {
      if (method === 'getEpochInfo') epochCalls++
      return undefined
    })
    const [r] = await batchTransfer(new SolanaClient(chain.transport), P.secretKey, [{ to: R1, amount: 10_000_000n }], { ...fast, priorityFee: 0 })
    expect(r?.status).toBe('confirmed')
    expect(epochCalls).toBeGreaterThanOrEqual(2)
  })
})

describe('广播', () => {
  function nodes() {
    const chain = createFakeSolana()
    chain.setSol(P.address, 10n * SOL)
    const sends = { a: 0, b: 0, c: 0 }
    const node = (name: keyof typeof sends, fail = false): RpcTransport => ({
      label: name,
      async request<T>(method: string, params?: readonly unknown[]): Promise<T> {
        if (method === 'sendTransaction') {
          sends[name]++
          if (fail) throw new TypeError('fetch failed')
        }
        return chain.transport.request<T>(method, params)
      },
    })
    return { chain, sends, node }
  }

  it("默认只发给第一个节点；broadcast: 'all' 同时发给所有节点", async () => {
    const one = nodes()
    await batchTransfer(new SolanaClient([one.node('a'), one.node('b')]), P.secretKey, [{ to: R1, amount: 10_000_000n }], { ...fast, priorityFee: 0 })
    expect(one.sends).toMatchObject({ a: 1, b: 0 })

    const all = nodes()
    const [r] = await batchTransfer(new SolanaClient([all.node('a'), all.node('b')]), P.secretKey, [{ to: R1, amount: 10_000_000n }], { ...fast, priorityFee: 0, broadcast: 'all' })
    expect(r?.status).toBe('confirmed')
    expect(all.sends).toMatchObject({ a: 1, b: 1 })
  })

  it("broadcast: 'all' 时一个节点连不上不影响（另一个接受即可，不标记 uncertain）", async () => {
    const { node, sends } = nodes()
    const [r] = await batchTransfer(new SolanaClient([node('a', true), node('b')]), P.secretKey, [{ to: R1, amount: 10_000_000n }], { ...fast, priorityFee: 0, broadcast: 'all' })
    expect(r?.status).toBe('confirmed')
    expect(r?.error).toBeNull()
    expect(sends.b).toBe(1)
  })

  it('sendRpc：交易只发给单独配置的节点，模拟 / 查状态仍用 client', async () => {
    const { node, sends } = nodes()
    const [r] = await batchTransfer(new SolanaClient(node('a')), P.secretKey, [{ to: R1, amount: 10_000_000n }], { ...fast, priorityFee: 0, sendRpc: node('c') })
    expect(r?.status).toBe('confirmed')
    expect(sends).toMatchObject({ a: 0, c: 1 })
  })
})

describe('广播（审查修复）', () => {
  it("broadcast: 'all' 第一个节点接受就返回，不等慢节点", async () => {
    const chain = createFakeSolana()
    chain.setSol(P.address, 10n * SOL)
    const slow: RpcTransport = {
      label: 'slow',
      async request<T>(method: string, params?: readonly unknown[]): Promise<T> {
        if (method === 'sendTransaction') await new Promise((r) => setTimeout(r, 2_000))
        return chain.transport.request<T>(method, params)
      },
    }
    const fastNode: RpcTransport = { label: 'fast', request: (method, params) => chain.transport.request(method, params) }
    const started = Date.now()
    const [r] = await batchTransfer(new SolanaClient([fastNode, slow]), P.secretKey, [{ to: R1, amount: 10_000_000n }], { ...fast, priorityFee: 0, broadcast: 'all', wait: false })
    expect(r?.status).toBe('sent')
    expect(Date.now() - started).toBeLessThan(1_500)
  })

  it('sendRpc 按 client 的节点选项（fetch / headers）解析', async () => {
    const chain = createFakeSolana()
    chain.setSol(P.address, 10n * SOL)
    const seen: Array<{ url: string; key: string | null; methods: string[] }> = []
    const fakeFetch = (async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { id: number; method: string; params: unknown[] } | Array<{ id: number; method: string; params: unknown[] }>
      const list = Array.isArray(body) ? body : [body]
      seen.push({ url: String(url), key: new Headers(init.headers).get('x-key'), methods: list.map((c) => c.method) })
      const out = await Promise.all(list.map(async (c) => ({ jsonrpc: '2.0', id: c.id, result: await chain.transport.request(c.method, c.params) })))
      return new Response(JSON.stringify(Array.isArray(body) ? out : out[0]), { status: 200 })
    }) as typeof fetch
    const client = new SolanaClient(chain.transport, { cluster: 'mainnet', fetch: fakeFetch, headers: { 'x-key': 'k' } })
    const [r] = await batchTransfer(client, P.secretKey, [{ to: R1, amount: 10_000_000n }], { ...fast, priorityFee: 0, sendRpc: 'https://send.example' })
    expect(r?.status).toBe('confirmed')
    const sends = seen.filter((s) => s.methods.includes('sendTransaction'))
    expect(sends.length).toBeGreaterThan(0)
    expect(sends.every((s) => s.url === 'https://send.example' && s.key === 'k')).toBe(true)
  })

  it('sendRpc 和 client 不在同一个网络时报 NetworkMismatchError（交易失败、不当成已发出）', async () => {
    const chain = createFakeSolana()
    chain.setSol(P.address, 10n * SOL)
    const devnet: RpcTransport = {
      request: async <T,>(method: string, params?: readonly unknown[]) =>
        (method === 'getGenesisHash' ? ('EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG' as T) : chain.transport.request<T>(method, params)),
    }
    const [r] = await batchTransfer(new SolanaClient(chain.transport, { cluster: 'mainnet' }), P.secretKey, [{ to: R1, amount: 10_000_000n }], { ...fast, priorityFee: 0, sendRpc: devnet })
    expect(r?.status).toBe('failed')
    expect(r?.error).toMatch(/Network mismatch/)
  })
})

describe('computeUnitMargin', () => {
  it('计算单元上限 = 消耗 × ratio + extra（默认 1.1 和 1000）', async () => {
    const run = async (margin?: { ratio?: number; extra?: number }) => {
      const chain = createFakeSolana()
      chain.setSol(P.address, 10n * SOL)
      const [r] = await batchTransfer(new SolanaClient(chain.transport), P.secretKey, [{ to: R1, amount: 10_000_000n }], {
        ...fast,
        priorityFee: 1_000_000, // 每个计算单元 1 lamport：优先费用 = 上限
        dryRun: true,
        computeUnitMargin: margin,
      })
      return { limit: BigInt(r?.fee as string) - 5000n, consumed: r?.computeUnits as number }
    }
    const base = await run()
    expect(base.limit).toBe(BigInt(Math.ceil(base.consumed * 1.1) + 1000))
    const wide = await run({ ratio: 2, extra: 0 })
    expect(wide.limit).toBe(BigInt(base.consumed * 2))
  })
})

describe("'auto' 优先费用", () => {
  it('去掉 0 再取 75 分位（之前带上 0，不活跃的账户几乎总是 0）', () => {
    const fees = [...Array.from({ length: 135 }, () => 0), ...Array.from({ length: 15 }, (_, i) => 100_000 + i * 10_000)]
    expect(autoPriorityFee(fees, 1_000_000n)).toBe(210_000n)
    expect(autoPriorityFee(fees, 50_000n)).toBe(50_000n) // 上限
    expect(autoPriorityFee([0, 0, 0], 1_000_000n)).toBe(0n)
    expect(autoPriorityFee([], 1_000_000n)).toBe(0n)
  })

  it('发送时按去掉 0 的分位数设单价', async () => {
    const chain = createFakeSolana({ priorityFees: [0, 0, 0, 0, 0, 0, 0, 0, 300, 400] })
    chain.setSol(P.address, 10n * SOL)
    const [r] = await batchTransfer(new SolanaClient(chain.transport), P.secretKey, [{ to: R1, amount: 10_000_000n }], { ...fast, dryRun: true })
    // 单价 400（去掉 0 后的 75 分位），费用 = 5000 + ceil(400 × 上限 / 1e6) > 5000
    expect(BigInt(r?.fee as string)).toBeGreaterThan(5000n)
  })
})

// ---- 打包：与旧实现对照 ----

/** 旧实现（0.6.0 的 send.ts fits / nextBatch 和 batchPlan.packCalls），逐条完整编译 */
function oldFits(payer: string, list: readonly Instruction[]): boolean {
  const m = compileMessage(payer, [setComputeUnitLimit(MAX_COMPUTE_UNITS), setComputeUnitPrice(0n), ...list], PLACEHOLDER_BLOCKHASH)
  return transactionSize(m) <= PACKET_DATA_SIZE && m.accountKeys.length <= MAX_ACCOUNT_LOCKS
}

function oldNextBatches(payer: string, units: ReadonlyArray<{ instructions: Instruction[]; fixed?: boolean }>, batchSize: number) {
  const out: Array<{ indices: number[]; tooLarge: boolean }> = []
  let next = 0
  while (next < units.length) {
    const first = units[next]!
    const start = next++
    if (!oldFits(payer, first.instructions)) {
      out.push({ indices: [start], tooLarge: true })
      continue
    }
    const batch = [start]
    while (!first.fixed && next < units.length && batch.length < batchSize) {
      const candidate = units[next]!
      if (candidate.fixed || !oldFits(payer, [...batch, next].flatMap((i) => units[i]!.instructions))) break
      batch.push(next++)
    }
    out.push({ indices: batch, tooLarge: false })
  }
  return out
}

function oldPackCalls(payer: string, calls: ReadonlyArray<{ instructions: Instruction[] }>, batchSize = Number.POSITIVE_INFINITY): number[][] {
  const packs: number[][] = []
  let current: number[] = []
  let instructions: Instruction[] = []
  calls.forEach((call, i) => {
    const next = [...instructions, ...call.instructions]
    if (current.length && (current.length >= batchSize || !oldFits(payer, next))) {
      packs.push(current)
      current = []
      instructions = []
    }
    current.push(i)
    instructions.push(...call.instructions)
  })
  if (current.length) packs.push(current)
  return packs
}

/** 可重复的伪随机地址和调用：转账、多签名者、大数据、重复账户 */
function randomUnits(seed: number, count: number) {
  let state = seed
  const rand = (n: number) => {
    state = (state * 1103515245 + 12345) % 2147483648
    return state % n
  }
  const addr = (i: number) => base58.encode(sha256(new TextEncoder().encode(`k-${seed}-${i}`)))
  const pool = Array.from({ length: 40 }, (_, i) => addr(i))
  const programs = Array.from({ length: 4 }, (_, i) => addr(1000 + i))
  return Array.from({ length: count }, () => {
    const n = 1 + rand(3)
    const instructions: Instruction[] = Array.from({ length: n }, () => {
      const keys = Array.from({ length: 1 + rand(6) }, () => ({ pubkey: pool[rand(pool.length)]!, isSigner: rand(20) === 0, isWritable: rand(2) === 0 }))
      // 同一账户在一条指令里以签名者重复出现（之前可能以非签名者出现过）：覆盖“非签名者升级为签名者”的计数
      if (rand(3) === 0) {
        const dup = pool[rand(pool.length)]!
        keys.push({ pubkey: dup, isSigner: true, isWritable: false }, { pubkey: dup, isSigner: true, isWritable: true })
      }
      return { programId: programs[rand(programs.length)]!, keys, data: new Uint8Array(rand(10) === 0 ? 300 + rand(400) : rand(40)) }
    })
    return { instructions, fixed: rand(15) === 0 }
  })
}

describe('packUnits 与旧实现分组一致', () => {
  it('随机调用（多种 batchSize）：发送的分组和 packCalls 的分组都和旧实现相同', () => {
    const payer = keypair(60).address
    for (let seed = 1; seed <= 80; seed++) {
      const units = randomUnits(seed, 60)
      for (const batchSize of [Number.POSITIVE_INFINITY, 1, 3, 7]) {
        expect(packUnits(payer, units, { batchSize, alone: (i) => Boolean(units[i]!.fixed) })).toEqual(oldNextBatches(payer, units, batchSize))
        expect(packCalls(payer, units.map((u) => ({ owner: payer, instructions: u.instructions })), batchSize)).toEqual(oldPackCalls(payer, units, batchSize))
      }
    }
  }, 30_000) // 80 组 × 4 种 batchSize 反复编译消息，CI 上和其他包并行跑时超过默认的 5 秒

  it('审查复现：已有的非签名账户在后面的调用里以签名者出现两次，三个调用正好放进一笔', () => {
    const payer = keypair(62).address
    const x = keypair(63).address
    const program = keypair(64).address
    const units = (dataLength: number) => [
      { instructions: [{ programId: program, keys: [{ pubkey: x, isSigner: false, isWritable: true }], data: new Uint8Array(dataLength) }] },
      { instructions: [{ programId: program, keys: [{ pubkey: keypair(65).address, isSigner: false, isWritable: false }], data: new Uint8Array(8) }] },
      {
        instructions: [
          { programId: program, keys: [{ pubkey: x, isSigner: true, isWritable: true }], data: new Uint8Array(1) },
          { programId: program, keys: [{ pubkey: x, isSigner: true, isWritable: false }], data: new Uint8Array(1) },
        ],
      },
    ]
    // 找到三个调用完整编译刚好放得下的最大数据长度（离上限不到 64 字节）
    let length = 0
    while (oldFits(payer, units(length + 1).flatMap((u) => u.instructions))) length++
    const list = units(length)
    expect(oldFits(payer, list.flatMap((u) => u.instructions))).toBe(true)
    expect(packUnits(payer, list)).toEqual([{ indices: [0, 1, 2], tooLarge: false }])
    expect(packUnits(payer, list)).toEqual(oldNextBatches(payer, list, Number.POSITIVE_INFINITY))
  })

  it('500 条 SOL 转账：分组相同', () => {
    const payer = keypair(61).address
    const units = Array.from({ length: 500 }, (_, i) => ({
      instructions: [{ programId: '11111111111111111111111111111111', keys: [{ pubkey: payer, isSigner: true, isWritable: true }, { pubkey: keypair(100 + (i % 150)).address, isSigner: false, isWritable: true }], data: new Uint8Array(12) }],
    }))
    expect(packUnits(payer, units).map((p) => p.indices)).toEqual(oldPackCalls(payer, units))
  })
})
