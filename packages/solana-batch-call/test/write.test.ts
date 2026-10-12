import { base58 } from '@scure/base'
import { ed25519 } from '@noble/curves/ed25519.js'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { NATIVE_MINT, SYSTEM_PROGRAM_ID, SolanaClient, TOKEN_PROGRAM_ID, getAssociatedTokenAddress } from '../src/index.js'
import { resetNodeHealth } from '../src/rpc.js'
import { batchCall, batchCollect, batchTransfer, setComputeUnitLimit, setComputeUnitPrice, systemTransfer, transferChecked, type WriteResult } from '../src/subpaths/write.js'
import { resolveSigner, type LocalSigner } from '../src/write/signer.js'
import { RENT_EXEMPT_MIN, TOKEN_ACCOUNT_RENT, createFakeSolana, keypair, type FakeSolanaOptions } from './fakeSolana.js'

const A = keypair(1)
const B = keypair(2)
const C = keypair(3)
const GAS = keypair(9)
const R1 = keypair(21).address
const R2 = keypair(22).address
const R3 = keypair(23).address
const HOT = keypair(30).address
const MINT = keypair(40).address
const SOL = 1_000_000_000n
const fast = { pollInterval: 1, timeout: 5_000, priorityFee: 0 }

function setup(options: FakeSolanaOptions = {}) {
  const chain = createFakeSolana(options)
  chain.addMint(MINT, 6)
  chain.setSol(A.address, 10n * SOL)
  chain.setSol(GAS.address, 10n * SOL)
  chain.setToken(A.address, MINT, 1_000_000_000n)
  const client = new SolanaClient(chain.transport)
  return { chain, client }
}

beforeEach(() => {
  resetNodeHealth()
})

describe('签名器', () => {
  it('各种私钥格式得到同一个地址；签名能被 @noble/curves 验证', async () => {
    const message = new Uint8Array([1, 2, 3])
    const inputs = [
      base58.encode(A.secretKey),
      JSON.stringify([...A.secretKey]),
      A.secretKey,
      A.seed,
      { secretKey: A.secretKey },
      { address: A.address, sign: async (m: Uint8Array) => ed25519.sign(m, A.seed) },
    ]
    for (const input of inputs) {
      const signer = (await resolveSigner(input)) as LocalSigner
      expect(signer.address).toBe(A.address)
      expect(ed25519.verify(await signer.sign(message), message, base58.decode(A.address))).toBe(true)
    }
  })

  it('私钥格式不对时报错，信息里不带私钥', async () => {
    const bad = A.secretKey.slice()
    bad[63] = (bad[63] as number) ^ 1 // 公钥部分对不上
    await expect(resolveSigner(bad)).rejects.toThrow('does not match')
    const text = base58.encode(bad)
    const err = await resolveSigner(text).catch((e: Error) => e)
    expect(String((err as Error).message)).not.toContain(text)
    await expect(resolveSigner('not a key!')).rejects.toThrow('Invalid private key')
    // 32 字节的 base58 字符串（和地址一样）不当成私钥：传错成地址时会悄悄变成另一个钱包
    await expect(resolveSigner(base58.encode(A.seed))).rejects.toThrow('looks like an address')
    await expect(resolveSigner(new Uint8Array(10))).rejects.toThrow('64 or 32 bytes')
  })
})

describe('batchTransfer', () => {
  it('SOL：多个收款人打包进一笔交易', async () => {
    const { chain, client } = setup()
    const updates: WriteResult[] = []
    const results = await batchTransfer(
      client,
      A.secretKey,
      [
        { to: R1, formatted: '0.5' },
        { to: R2, amount: SOL },
        { to: R3, amount: 2n * SOL },
      ],
      { ...fast, onUpdate: (r) => updates.push(r) },
    )
    expect(results.map((r) => r.status)).toEqual(['confirmed', 'confirmed', 'confirmed'])
    expect(new Set(results.map((r) => r.signature)).size).toBe(1)
    expect(results[0]).toMatchObject({ to: R1, native: true, amount: '500000000', formatted: '0.5', fee: '5000', createdAccount: false })
    expect(chain.sol(R1)).toBe(SOL / 2n)
    expect(chain.sol(A.address)).toBe(10n * SOL - SOL / 2n - 3n * SOL - 5000n)
    expect(updates.map((u) => u.status)).not.toContain('skipped')
  })

  it("'tx'：每个收款人一笔交易；同样内容的两笔签名也不同", async () => {
    const { chain, client } = setup()
    const results = await batchTransfer(
      client,
      A.secretKey,
      [
        { to: R1, amount: SOL },
        { to: R1, amount: SOL },
      ],
      { ...fast, mode: 'tx' },
    )
    expect(results.map((r) => r.status)).toEqual(['confirmed', 'confirmed'])
    expect(results[0]?.signature).not.toBe(results[1]?.signature)
    expect(chain.sol(R1)).toBe(2n * SOL)
  })

  it('代币：收款人没有 ATA 时自动创建（租金由手续费支付者付）', async () => {
    const { chain, client } = setup()
    chain.setToken(R2, MINT, 5n)
    const results = await batchTransfer(
      client,
      A.secretKey,
      [
        { to: R1, formatted: '1.5' },
        { to: R2, amount: 100n },
      ],
      { ...fast, token: MINT, feePayer: GAS.secretKey },
    )
    expect(results.map((r) => [r.status, r.createdAccount])).toEqual([
      ['confirmed', true],
      ['confirmed', false],
    ])
    expect(chain.token(R1, MINT)).toBe(1_500_000n)
    expect(chain.token(R2, MINT)).toBe(105n)
    // 手续费和租金都由 GAS 付：两个签名
    expect(chain.sol(A.address)).toBe(10n * SOL)
    expect(chain.sol(GAS.address)).toBe(10n * SOL - 10_000n - TOKEN_ACCOUNT_RENT)
  })

  it('模拟失败的收款项单独失败，其余照常发送', async () => {
    const { chain, client } = setup()
    chain.setToken(R2, MINT, 0n)
    chain.frozen.add(getAssociatedTokenAddress(R2, MINT, TOKEN_PROGRAM_ID))
    const results = await batchTransfer(
      client,
      A.secretKey,
      [
        { to: R1, amount: 1n },
        { to: R2, amount: 2n },
        { to: R3, amount: 3n },
      ],
      { ...fast, token: MINT },
    )
    expect(results.map((r) => r.status)).toEqual(['confirmed', 'failed', 'confirmed'])
    expect(results[1]?.error).toContain('frozen')
    expect(results[1]?.signature).toBeNull()
    expect(results[0]?.signature).toBe(results[2]?.signature)
  })

  it('SOL 转给新账户但低于免租下限：这一项失败', async () => {
    const { client } = setup()
    const results = await batchTransfer(
      client,
      A.secretKey,
      [
        { to: R1, amount: 1000n },
        { to: R2, amount: RENT_EXEMPT_MIN },
      ],
      fast,
    )
    expect(results.map((r) => r.status)).toEqual(['failed', 'confirmed'])
    expect(results[0]?.error).toContain('rent-exempt')
  })

  it('收款人多时按交易大小自动分笔', async () => {
    const { chain, client } = setup()
    const recipients = Array.from({ length: 50 }, (_, i) => ({ to: keypair(100 + i).address, amount: SOL / 100n }))
    const results = await batchTransfer(client, A.secretKey, recipients, fast)
    expect(results.every((r) => r.status === 'confirmed')).toBe(true)
    const txs = new Set(results.map((r) => r.signature))
    expect(txs.size).toBeGreaterThan(1)
    expect(txs.size).toBeLessThan(5)
    expect(chain.sol(recipients[49]!.to)).toBe(SOL / 100n)
  })

  it('余额不够时抛错，一笔都不发；数量参数校验', async () => {
    const { chain, client } = setup()
    await expect(batchTransfer(client, A.secretKey, [{ to: R1, amount: 11n * SOL }], fast)).rejects.toThrow('Insufficient balance')
    await expect(batchTransfer(client, A.secretKey, [{ to: R1 }], fast)).rejects.toThrow('exactly one')
    await expect(batchTransfer(client, A.secretKey, [{ to: R1, formatted: '0.0000000001' }], fast)).rejects.toThrow('decimals')
    await expect(batchTransfer(client, A.secretKey, [{ to: 'xyz', amount: 1n }], fast)).rejects.toThrow('invalid address')
    expect(chain.sent).toHaveLength(0)
  })

  it('优先费用 auto：按最近费用的 75 分位，不超过上限；计入手续费', async () => {
    const { chain, client } = setup({ priorityFees: [0, 0, 1000, 5000] })
    const [result] = await batchTransfer(client, A.secretKey, [{ to: R1, amount: SOL }], { ...fast, priorityFee: 'auto' })
    expect(result?.status).toBe('confirmed')
    expect(BigInt(result!.fee!)).toBeGreaterThan(5000n)
    const [capped] = await batchTransfer(client, A.secretKey, [{ to: R2, amount: SOL }], { ...fast, priorityFee: 'auto', maxPriorityFee: 1 })
    expect(BigInt(capped!.fee!)).toBe(5001n) // 单价 1 × 计算单元上限（不到 1,000,000）向上取整
    expect(chain.sol(R2)).toBe(SOL)
  })
})

describe('batchCall', () => {
  it('feePayer：不同钱包的调用打包进同一笔交易，各自签名', async () => {
    const { chain, client } = setup()
    chain.setSol(B.address, SOL)
    const results = await batchCall(
      client,
      [
        { from: A.secretKey, instructions: systemTransfer(A.address, R1, 1_000_000n) },
        { from: B.secretKey, instructions: [systemTransfer(B.address, R1, 2_000_000n)] },
      ],
      { ...fast, feePayer: GAS.secretKey },
    )
    expect(results.map((r) => r.status)).toEqual(['confirmed', 'confirmed'])
    expect(results[0]?.signature).toBe(results[1]?.signature)
    expect(results[0]?.fee).toBe('15000') // 3 个签名
    expect(chain.sol(R1)).toBe(3_000_000n)
    expect(chain.sol(B.address)).toBe(SOL - 2_000_000n)
  })

  it('支持 web3.js / @solana/kit 格式的指令；缺少签名者时发送前报错', async () => {
    const { chain, client } = setup()
    const pk = (address: string) => ({ toBase58: () => address })
    const web3 = { programId: pk(SYSTEM_PROGRAM_ID), keys: [{ pubkey: pk(A.address), isSigner: true, isWritable: true }, { pubkey: pk(R1), isSigner: false, isWritable: true }], data: systemTransfer(A.address, R1, SOL).data }
    const kit = { programAddress: SYSTEM_PROGRAM_ID, accounts: [{ address: A.address, role: 3 }, { address: R2, role: 1 }], data: systemTransfer(A.address, R2, SOL).data }
    const results = await batchCall(client, [{ from: A.secretKey, instructions: [web3, kit] }], fast)
    expect(results[0]?.status).toBe('confirmed')
    expect(chain.sol(R1)).toBe(SOL)
    expect(chain.sol(R2)).toBe(SOL)
    await expect(batchCall(client, [{ from: A.secretKey, instructions: systemTransfer(B.address, R1, 1n) }], fast)).rejects.toThrow(`signature of ${B.address}`)
  })

  it('continueOnError 为 false：失败调用之后的调用跳过，之前的照常发送', async () => {
    const { chain, client } = setup()
    const results = await batchCall(
      client,
      [
        { from: A.secretKey, instructions: systemTransfer(A.address, R1, SOL) },
        { from: A.secretKey, instructions: systemTransfer(A.address, R2, 100n * SOL) }, // 余额不够
        { from: A.secretKey, instructions: systemTransfer(A.address, R3, SOL) },
      ],
      fast,
    )
    expect(results.map((r) => r.status)).toEqual(['confirmed', 'failed', 'skipped'])
    expect(results[1]?.error).toContain('insufficient lamports')
    expect(chain.sol(R3)).toBe(0n)
  })

  it('依赖前一笔的调用：模拟失败时先等前一笔确认再模拟', async () => {
    const { chain, client } = setup({ landAfterPolls: 2 })
    chain.setSol(B.address, 0n)
    const results = await batchCall(
      client,
      [
        { from: A.secretKey, instructions: systemTransfer(A.address, B.address, SOL) },
        { from: A.secretKey, instructions: systemTransfer(B.address, R1, SOL / 2n), signers: [B.secretKey] }, // B 的钱来自上一笔
      ],
      { ...fast, mode: 'tx' },
    )
    expect(results.map((r) => r.status)).toEqual(['confirmed', 'confirmed'])
    expect(chain.sol(R1)).toBe(SOL / 2n)
  })

  it('交易过期没上链：换新 blockhash 重发；retries 用完时 failed', async () => {
    const { chain, client } = setup({ drop: 1, validBlocks: 2 })
    const [ok] = await batchCall(client, [{ from: A.secretKey, instructions: systemTransfer(A.address, R1, SOL) }], fast)
    expect(ok?.status).toBe('confirmed')
    expect(new Set(chain.sent).size).toBe(2)
    expect(chain.sol(R1)).toBe(SOL)

    const { client: client2 } = setup({ drop: 5, validBlocks: 2 })
    const [failed] = await batchCall(client2, [{ from: A.secretKey, instructions: systemTransfer(A.address, R1, SOL) }], { ...fast, retries: 1 })
    expect(failed?.status).toBe('failed')
    expect(failed?.error).toContain('expired')
  })

  it('过期重发时模拟失败、同一支付者还有交易在等确认：直接失败，不会互相等待（死锁）', async () => {
    // 第一笔被丢弃、很快过期；第二笔换了新 blockhash、迟迟不上链；第一笔重发时余额已被清空，模拟失败
    const { chain, client } = setup({ drop: 1, validBlocks: (call) => (call === 0 ? 2 : 30), landAfterPolls: 20 })
    let offset = 0
    const now = Date.now.bind(Date)
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => now() + offset)
    try {
      const results = await batchCall(
        client,
        [
          { from: A.secretKey, instructions: systemTransfer(A.address, R1, SOL) },
          { from: A.secretKey, instructions: systemTransfer(A.address, R2, SOL) },
        ],
        {
          ...fast,
          timeout: 600_000, // 测试里把时钟往前拨了，等待上限放宽
          mode: 'tx',
          onUpdate: (r) => {
            if (r.status !== 'sent') return
            offset += 11_000 // blockhash 缓存过期：第二笔用新的 blockhash
            if (r.index === 1) chain.setSol(A.address, 0n)
          },
        },
      )
      expect(results.map((r) => r.status)).toEqual(['failed', 'failed'])
      expect(results[0]?.error).toContain('fee')
    } finally {
      spy.mockRestore()
    }
  })

  it('上链后才失败：没有日志时翻译常见程序的错误码', async () => {
    const { chain, client } = setup({ landAfterPolls: 1 })
    const target = chain.setToken(R1, MINT, 0n)
    const source = getAssociatedTokenAddress(A.address, MINT, TOKEN_PROGRAM_ID)
    const [result] = await batchCall(client, [{ from: A.secretKey, instructions: transferChecked(source, MINT, target, A.address, 1n, 6, TOKEN_PROGRAM_ID) }], {
      ...fast,
      onUpdate: (r) => r.status === 'sent' && chain.frozen.add(target), // 模拟通过之后、上链之前账户被冻结
    })
    expect(result).toMatchObject({ status: 'reverted', error: 'account is frozen' })
    expect(result?.slot).not.toBeNull()
  })

  it('状态查询落到落后的节点、交易看起来过期了：等节点追上再判断，不会重发（重复转账）', async () => {
    // 交易已上链，但状态查询总是落后 3 个 slot；blockhash 很快过期
    const { chain, client } = setup({ statusLag: 3, validBlocks: 1 })
    const [result] = await batchCall(client, [{ from: A.secretKey, instructions: systemTransfer(A.address, R1, SOL) }], fast)
    expect(result?.status).toBe('confirmed')
    expect(new Set(chain.sent).size).toBe(1)
    expect(chain.sol(R1)).toBe(SOL)
  })

  it('付款方余额少、优先费用高：模拟不按 140 万计算单元预扣手续费', async () => {
    const { chain, client } = setup({ priorityFees: [1_000_000] })
    chain.setSol(B.address, 10_000_000n) // 0.01 SOL
    const [result] = await batchCall(client, [{ from: B.secretKey, instructions: systemTransfer(B.address, R1, RENT_EXEMPT_MIN) }], { ...fast, priorityFee: 'auto' })
    expect(result?.status).toBe('confirmed')
    expect(chain.sol(R1)).toBe(RENT_EXEMPT_MIN)
  })

  it('付款方余额会低于免租下限时剔除最后的转账，而不是第一笔', async () => {
    const { chain, client } = setup()
    chain.setSol(A.address, 3n * SOL + 500_000n + 5000n)
    const results = await batchTransfer(
      client,
      A.secretKey,
      [R1, R2, R3].map((to) => ({ to, amount: SOL })),
      { ...fast, checkBalance: false },
    )
    expect(results.map((r) => r.status)).toEqual(['confirmed', 'confirmed', 'failed'])
    expect(results[2]?.error).toContain('rent-exempt')
  })

  it('调用里自带的计算单元上限 / 优先费用指令会去掉（不和库自动加的重复）', async () => {
    const { chain, client } = setup()
    const [result] = await batchCall(client, [{ from: A.secretKey, instructions: [setComputeUnitLimit(5000), setComputeUnitPrice(7n), systemTransfer(A.address, R1, SOL)] }], fast)
    expect(result?.status).toBe('confirmed')
    expect(chain.sol(R1)).toBe(SOL)
  })

  it('dryRun 只模拟，不发送；wait: false 广播后返回', async () => {
    const { chain, client } = setup({ landAfterPolls: 3 })
    const [simulated] = await batchCall(client, [{ from: A.secretKey, instructions: systemTransfer(A.address, R1, SOL) }], { ...fast, dryRun: true })
    expect(simulated).toMatchObject({ status: 'simulated', fee: '5000' })
    expect(simulated?.computeUnits).toBeGreaterThan(0)
    expect(chain.sent).toHaveLength(0)
    const [sent] = await batchCall(client, [{ from: A.secretKey, instructions: systemTransfer(A.address, R1, SOL) }], { ...fast, wait: false })
    expect(sent?.status).toBe('sent')
    expect(chain.sent).toHaveLength(1)
  })

  it('代币指令（TransferChecked）', async () => {
    const { chain, client } = setup()
    const target = chain.setToken(R1, MINT, 0n)
    const source = getAssociatedTokenAddress(A.address, MINT, TOKEN_PROGRAM_ID)
    const [result] = await batchCall(client, [{ from: A.secretKey, instructions: transferChecked(source, MINT, target, A.address, 42n, 6, TOKEN_PROGRAM_ID) }], fast)
    expect(result?.status).toBe('confirmed')
    expect(chain.token(R1, MINT)).toBe(42n)
  })
})

describe('batchCollect', () => {
  it('feePayer：子钱包不需要 SOL，代币归集 + 关闭代币账户 + 扫空 SOL', async () => {
    const { chain, client } = setup()
    chain.setToken(B.address, MINT, 5_000_000n)
    chain.setToken(C.address, MINT, 7_000_000n)
    chain.setSol(C.address, SOL)
    const { results } = await batchCollect(client, [B.secretKey, C.secretKey], HOT, { ...fast, tokens: [MINT, NATIVE_MINT], feePayer: GAS.secretKey, closeAccounts: true })
    expect(results.map((r) => [r.from, r.token, r.status])).toEqual([
      [B.address, MINT, 'confirmed'],
      [B.address, NATIVE_MINT, 'confirmed'], // 关闭代币账户退回的租金
      [C.address, MINT, 'confirmed'],
      [C.address, NATIVE_MINT, 'confirmed'],
    ])
    expect(results[0]).toMatchObject({ to: HOT, amount: '5000000', formatted: '5' })
    expect(results[0]?.close?.status).toBe('confirmed')
    expect(chain.token(HOT, MINT)).toBe(12_000_000n)
    expect(chain.token(B.address, MINT)).toBeNull() // 已关闭
    expect(results[1]?.amount).toBe(TOKEN_ACCOUNT_RENT.toString())
    expect(chain.sol(B.address)).toBe(0n)
    expect(chain.sol(C.address)).toBe(0n)
    expect(chain.sol(HOT)).toBe(SOL + 2n * TOKEN_ACCOUNT_RENT)
  })

  it('不传 feePayer：没有 SOL 的钱包失败并提示，有 SOL 的扣掉手续费后扫空', async () => {
    const { chain, client } = setup()
    chain.setToken(B.address, MINT, 5_000_000n)
    chain.setToken(C.address, MINT, 7_000_000n)
    chain.setSol(C.address, SOL)
    chain.setToken(HOT, MINT, 0n)
    const { results } = await batchCollect(client, [B.secretKey, C.secretKey], HOT, { ...fast, tokens: [MINT, NATIVE_MINT] })
    expect(results.map((r) => r.status)).toEqual(['failed', 'skipped', 'confirmed', 'confirmed'])
    expect(results[0]?.error).toContain('pass feePayer')
    expect(results[1]?.error).toContain('did not succeed')
    expect(chain.sol(C.address)).toBe(0n)
    expect(chain.sol(HOT)).toBe(SOL - 5000n - 5000n)
  })

  it('不传 feePayer、归集地址没有 ATA：先由一个钱包单独创建，其他钱包只需付得起手续费', async () => {
    const { chain, client } = setup()
    chain.setToken(B.address, MINT, 5n)
    chain.setToken(C.address, MINT, 7n)
    chain.setSol(B.address, SOL)
    chain.setSol(C.address, 100_000n) // 付不起租金（约 0.002 SOL），只够手续费
    const { results } = await batchCollect(client, [B.secretKey, C.secretKey], HOT, { ...fast, tokens: [MINT] })
    expect(results.map((r) => r.status)).toEqual(['confirmed', 'confirmed'])
    expect(chain.token(HOT, MINT)).toBe(12n)
    expect(chain.sol(B.address)).toBe(SOL - TOKEN_ACCOUNT_RENT - 10_000n)
  })

  it('余额为 0、低于 minAmount、重复钱包的项跳过；dryRun 不发交易', async () => {
    const { chain, client } = setup()
    chain.setToken(B.address, MINT, 10n)
    const { results } = await batchCollect(client, [B.secretKey, C.secretKey, B.secretKey], HOT, { ...fast, tokens: [MINT], feePayer: GAS.secretKey, minAmount: { [MINT]: 100n } })
    expect(results.map((r) => r.error)).toEqual(['skipped: below minAmount', 'skipped: zero balance', 'skipped: duplicate wallet'])
    chain.setToken(C.address, MINT, 1000n)
    const dry = await batchCollect(client, [C.secretKey], HOT, { ...fast, tokens: [MINT], feePayer: GAS.secretKey, dryRun: true })
    expect(dry.results[0]?.status).toBe('simulated')
    expect(chain.sent).toHaveLength(0)
  })
})
