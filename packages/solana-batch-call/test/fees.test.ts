/** 手续费估算：三档优先费的取法、一笔交易的花费（模拟结果 → 计算单元上限、优先费、新建账户的押金），模拟节点，不连网络 */
import { base64 } from '@scure/base'
import { beforeEach, describe, expect, it } from 'vitest'

import { SYSTEM_PROGRAM_ID, SolanaClient, TOKEN_PROGRAM_ID, encodeAddress, getAssociatedTokenAddress } from '../src/index.js'
import { resetNodeHealth } from '../src/rpc.js'
import { resetClientCache } from '../src/shortcuts.js'
import { estimateCost, estimateFees, getCostEstimate, getFeeEstimate } from '../src/subpaths/fees.js'
import { createAssociatedTokenAccountIdempotent, setComputeUnitLimit, setComputeUnitPrice, systemTransfer } from '../src/subpaths/write.js'
import { compileMessage, parseMessage, serializeTransaction } from '../src/write/transaction.js'
import { keypair } from './fakeSolana.js'
import { createMockNode, type MockAccount } from './mock.js'

const PAYER = keypair(1).address
const NEW = keypair(2).address
const POOL = keypair(3).address
const MINT = keypair(40).address

interface Sim {
  err?: unknown
  logs?: string[]
  unitsConsumed?: number
  /** 模拟后的账户（按请求里的 addresses 顺序） */
  accounts?: Record<string, { lamports: number; owner: string; space: number }>
}

function node(options: { fees?: number[]; sim?: Sim; accounts?: Record<string, MockAccount> } = {}) {
  const base = createMockNode({ accounts: { [PAYER]: { lamports: 10n ** 9n, owner: SYSTEM_PROGRAM_ID }, ...options.accounts } })
  const calls: Array<{ method: string; params: readonly unknown[] }> = []
  return {
    calls,
    async request<T>(method: string, params: readonly unknown[] = []): Promise<T> {
      calls.push({ method, params })
      switch (method) {
        case 'getRecentPrioritizationFees':
          return (options.fees ?? [0]).map((prioritizationFee, slot) => ({ slot, prioritizationFee })) as T
        case 'getMinimumBalanceForRentExemption':
          return ((128 + (params[0] as number)) * 5080) as T
        case 'simulateTransaction': {
          const sim = options.sim ?? {}
          const addresses = (params[1] as { accounts?: { addresses: string[] } }).accounts?.addresses ?? []
          const accounts = addresses.map((a) => {
            const post = sim.accounts?.[a]
            return post ? { lamports: post.lamports, owner: post.owner, data: [base64.encode(new Uint8Array(post.space)), 'base64'], executable: false } : null
          })
          return { context: { slot: 1 }, value: { err: sim.err ?? null, logs: sim.logs ?? [], unitsConsumed: sim.unitsConsumed ?? 0, accounts } } as T
        }
        default:
          return base.request<T>(method, params)
      }
    },
  }
}

beforeEach(() => {
  resetNodeHealth()
  resetClientCache()
})

describe('estimateFees', () => {
  it('三档取最近各 slot 最低费用的第 50 / 75 / 90 百分位（排序后第 ⌊n × p⌋ 个），只看传入的可写账户', async () => {
    const n = node({ fees: [0, 0, 100, 200, 300, 400, 500, 600, 700, 800] })
    expect(await estimateFees(new SolanaClient(n), { accounts: [POOL, POOL] })).toEqual({ slow: '400', normal: '600', fast: '800', slots: 10 })
    expect(n.calls.at(-1)).toEqual({ method: 'getRecentPrioritizationFees', params: [[POOL]] })
    // 不传账户：看全网；自定义百分位；三档不递减
    expect(await estimateFees(new SolanaClient(n), { percentiles: [90, 10, 0] })).toEqual({ slow: '800', normal: '800', fast: '800', slots: 10 })
    expect(n.calls.at(-1)?.params).toEqual([])
    expect(await estimateFees(new SolanaClient(node({ fees: [] })))).toEqual({ slow: '0', normal: '0', fast: '0', slots: 0 })
  })

  it('getFeeEstimate：节点参数与 getBalances 相同', async () => {
    expect((await getFeeEstimate({ provider: node({ fees: [5] }) })).normal).toBe('5')
  })
})

describe('estimateCost', () => {
  it('指令：模拟（上限最大、单价 0、不验签），上限 = 消耗 × 1.1 + 1000，优先费按可写账户的建议；新建的代币账户算押金', async () => {
    const ata = getAssociatedTokenAddress(NEW, MINT, TOKEN_PROGRAM_ID)
    const n = node({ fees: [10_000], sim: { unitsConsumed: 20_000, accounts: { [ata]: { lamports: 1_488_440, owner: TOKEN_PROGRAM_ID, space: 165 }, [NEW]: { lamports: 1_000_000, owner: SYSTEM_PROGRAM_ID, space: 0 } } } })
    const cost = await estimateCost(new SolanaClient(n), {
      feePayer: PAYER,
      // 自带的计算预算指令会被去掉
      instructions: [setComputeUnitPrice(1n), createAssociatedTokenAccountIdempotent(PAYER, ata, NEW, MINT, TOKEN_PROGRAM_ID), systemTransfer(PAYER, NEW, 1_000_000n)],
    })
    expect(cost).toEqual({
      computeUnits: 20_000,
      computeUnitLimit: 23_000,
      priorityFee: '10000',
      signatures: 1,
      baseFee: '5000',
      priorityFeeLamports: '230',
      fee: '5230',
      rent: '1488440',
      // 转 SOL 给新地址（System、没有数据）不算押金
      createdAccounts: [{ address: ata, owner: TOKEN_PROGRAM_ID, space: 165, rent: '1488440' }],
      total: '1493670',
      totalFormatted: '0.00149367',
      symbol: 'SOL',
    })
    const sim = n.calls.find((c) => c.method === 'simulateTransaction')
    const config = sim?.params[1] as { sigVerify: boolean; replaceRecentBlockhash: boolean; accounts: { addresses: string[] } }
    expect(config).toMatchObject({ encoding: 'base64', sigVerify: false, replaceRecentBlockhash: true })
    // 只读回交易前不存在的可写账户
    expect(config.accounts.addresses.sort()).toEqual([ata, NEW].sort())
    const message = parseMessage(base64.decode(sim?.params[0] as string).slice(65))
    const budget = message.instructions.filter((ix) => ix.programId === 'ComputeBudget111111111111111111111111111111').map((ix) => [...ix.data])
    expect(budget).toEqual([
      [2, 0xc0, 0x5c, 0x15, 0], // 1,400,000
      [3, 0, 0, 0, 0, 0, 0, 0, 0],
    ])
    const feeRequest = n.calls.find((c) => c.method === 'getRecentPrioritizationFees')
    expect((feeRequest?.params[0] as string[]).sort()).toEqual([PAYER, ata, NEW].sort())
  })

  it('指定单价 / 档位 / 共用的建议；模拟失败时抛出日志里的原因', async () => {
    const client = new SolanaClient(node({ fees: [1, 2, 3, 4], sim: { unitsConsumed: 450 } }))
    const call = { feePayer: PAYER, instructions: systemTransfer(PAYER, POOL, 1n) }
    expect((await estimateCost(client, call, { priorityFee: 1_000_000 })).priorityFeeLamports).toBe('1496')
    expect((await estimateCost(client, call, { level: 'fast' })).priorityFee).toBe('4')
    expect((await estimateCost(client, call, { fees: { slow: '7', normal: '8', fast: '9', slots: 1 } })).priorityFee).toBe('8')
    const failing = new SolanaClient(node({ sim: { err: { InstructionError: [2, { Custom: 1 }] }, logs: ['Transfer: insufficient lamports 0, need 1'] } }))
    await expect(estimateCost(failing, call)).rejects.toThrow('Simulation failed: Transfer: insufficient lamports 0, need 1')
  })

  it('构建好的交易：按自带的计算预算指令算；没有单价时优先费为 0；v1 等新格式报错', async () => {
    const n = node({ fees: [999], sim: { unitsConsumed: 3000 } })
    const client = new SolanaClient(n)
    const message = compileMessage(PAYER, [setComputeUnitLimit(10_000), setComputeUnitPrice(50_000n), systemTransfer(PAYER, POOL, 1n)], SYSTEM_PROGRAM_ID)
    const raw = serializeTransaction(message, [null])
    const cost = await estimateCost(client, { transaction: base64.encode(raw) })
    expect(cost).toMatchObject({ computeUnits: 3000, computeUnitLimit: 10_000, priorityFee: '50000', fee: '5500', total: '5500' })
    expect(n.calls.some((c) => c.method === 'getRecentPrioritizationFees')).toBe(false)
    // 模拟的是原交易
    expect(n.calls.find((c) => c.method === 'simulateTransaction')?.params[0]).toBe(base64.encode(raw))

    const plain = compileMessage(PAYER, [systemTransfer(PAYER, POOL, 1n), systemTransfer(PAYER, POOL, 2n)], SYSTEM_PROGRAM_ID)
    expect(await getCostEstimate({ transaction: serializeTransaction(plain, [null]) }, { provider: n })).toMatchObject({ computeUnitLimit: 400_000, priorityFee: '0', fee: '5000' })

    const v1 = new Uint8Array([0x81, 1, 0, 4, ...new Uint8Array(100)])
    await expect(estimateCost(client, { transaction: v1 })).rejects.toThrow(/version 1/)
  })
})

describe('parseMessage', () => {
  it('legacy：签名数、可写账户、指令', () => {
    const message = compileMessage(PAYER, [systemTransfer(PAYER, POOL, 5n)], SYSTEM_PROGRAM_ID)
    const parsed = parseMessage(message.bytes)
    expect(parsed).toMatchObject({ version: 'legacy', signatures: 1, staticKeys: message.accountKeys, writable: [PAYER, POOL], lookups: [] })
    expect(parsed.instructions).toEqual([{ programId: SYSTEM_PROGRAM_ID, accounts: [0, 1], data: systemTransfer(PAYER, POOL, 5n).data }])
  })

  it('v0：地址查找表的可写 / 只读下标', () => {
    const legacy = compileMessage(PAYER, [systemTransfer(PAYER, POOL, 5n)], SYSTEM_PROGRAM_ID).bytes
    const table = new Uint8Array(32).fill(7)
    // 0x80 版本前缀 + legacy 消息 + 1 个查找表（地址、2 个可写下标 3 / 4、1 个只读下标 9）
    const parsed = parseMessage(new Uint8Array([0x80, ...legacy, 1, ...table, 2, 3, 4, 1, 9]))
    expect(parsed).toMatchObject({ version: 0, signatures: 1, writable: [PAYER, POOL] })
    expect(parsed.lookups).toEqual([{ table: encodeAddress(table), writable: [3, 4], readonly: [9] }])
    expect(() => parseMessage(new Uint8Array([0x81, ...legacy]))).toThrow(/version 1/)
  })
})
