import { beforeEach, describe, expect, it } from 'vitest'

import { decodeAddress } from '../src/address.js'
import { NATIVE_MINT, SolanaClient, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '../src/index.js'
import { resetNodeHealth } from '../src/rpc.js'
import { parseRisk, tokenRisks, tradeChecks } from '../src/subpaths/risk.js'
import { CLOCK_SYSVAR_ID } from '../src/swap/common.js'
import { SOL, TKN, TKN_SOL, USER, blocked, setupCpmmChain } from './fakeCpmm.js'
import { createFakeSolana, keypair } from './fakeSolana.js'
import { mintData } from './mock.js'

const AUTH = keypair(70).address
const HOOK = keypair(71).address
const DELEGATE = keypair(72).address

/** Token-2022 mint：基础 82 字节 → 补齐到 165 + 账户类型 1（Mint）→ TLV 扩展 */
function token2022Mint(extensions: Array<[number, Uint8Array]>, base: Uint8Array = mintData({ decimals: 6, supply: 1000n })): Uint8Array {
  const out: number[] = [...base.slice(0, 82), ...new Array(165 - 82).fill(0), 1]
  for (const [type, data] of extensions) {
    out.push(type & 0xff, type >> 8, data.length & 0xff, data.length >> 8, ...data)
  }
  return new Uint8Array(out)
}
const pubkey = (a: string | null) => (a ? decodeAddress(a) : new Uint8Array(32))
const concat = (...parts: Uint8Array[]) => new Uint8Array(parts.flatMap((p) => [...p]))
const account = (owner: string, data: Uint8Array) => ({ address: 'm', lamports: 1n, owner, data, executable: false })

function transferFeeExt(older: [bigint, bigint, number], newer: [bigint, bigint, number], authority: string | null): Uint8Array {
  const b = new Uint8Array(108)
  const v = new DataView(b.buffer)
  b.set(pubkey(authority), 0)
  ;[older, newer].forEach(([epoch, max, bps], i) => {
    v.setBigUint64(72 + i * 18, epoch, true)
    v.setBigUint64(80 + i * 18, max, true)
    v.setUint16(88 + i * 18, bps, true)
  })
  return b
}

describe('parseRisk：mint 权限和 Token-2022 扩展', () => {
  it('SPL Token：增发 / 冻结权限', () => {
    const risk = parseRisk('m', account(TOKEN_PROGRAM_ID, mintData({ decimals: 6, supply: 5n, mintAuthority: AUTH, freezeAuthority: AUTH })), 700n)
    expect(risk).toMatchObject({ exists: true, program: 'spl-token', decimals: 6, supply: '5', mintAuthority: AUTH, freezeAuthority: AUTH, flags: ['mintable', 'freezable'] })
    expect(parseRisk('m', account(TOKEN_PROGRAM_ID, mintData({ decimals: 9 })), 700n).flags).toEqual([])
  })

  it('不存在、不是 mint', () => {
    expect(parseRisk('m', null, null)).toMatchObject({ exists: false, flags: ['not-found'] })
    expect(parseRisk('m', account('11111111111111111111111111111111', new Uint8Array(82)), null).flags).toEqual(['not-found'])
    expect(parseRisk('m', account(TOKEN_PROGRAM_ID, new Uint8Array(165)), null).flags).toEqual(['not-found'])
  })

  it('Token-2022 的各个扩展', () => {
    const data = token2022Mint([
      [1, transferFeeExt([0n, 100n, 50], [800n, 10n ** 12n, 1500], AUTH)],
      [3, pubkey(AUTH)],
      [4, concat(pubkey(AUTH), new Uint8Array([1]), new Uint8Array(32))],
      [6, new Uint8Array([2])],
      [9, new Uint8Array()],
      [10, concat(pubkey(AUTH), new Uint8Array(20))],
      [12, pubkey(DELEGATE)],
      [14, concat(pubkey(AUTH), pubkey(HOOK))],
      [26, concat(pubkey(AUTH), new Uint8Array([1]))],
      [28, pubkey(AUTH)],
    ])
    const risk = parseRisk('m', account(TOKEN_2022_PROGRAM_ID, data), 700n)
    expect(risk).toMatchObject({
      program: 'token-2022',
      // epoch 700 < 800：现在是旧配置 0.5%，800 起 15%
      transferFee: { basisPoints: 50, maximumFee: '100', authority: AUTH, next: { basisPoints: 1500, maximumFee: String(10n ** 12n), epoch: '800' } },
      mintCloseAuthority: AUTH,
      confidentialTransfer: { authority: AUTH, autoApprove: true },
      defaultFrozen: true,
      nonTransferable: true,
      uiAmountAuthority: AUTH,
      permanentDelegate: DELEGATE,
      transferHook: { authority: AUTH, program: HOOK },
      pausable: { authority: AUTH, paused: true },
      burnAuthority: AUTH,
    })
    expect(risk.flags).toEqual([
      'transfer-fee',
      'high-transfer-fee',
      'fee-changeable',
      'permanent-delegate',
      'transfer-hook',
      'non-transferable',
      'default-frozen',
      'pausable',
      'paused',
      'confidential-transfer',
      'closable',
      'ui-amount-changes',
      'permissioned-burn',
    ])
  })

  it('扩展里的权限为空（全 0）时不算；费率 0 不算 transfer-fee', () => {
    const data = token2022Mint([
      [1, transferFeeExt([0n, 0n, 0], [0n, 0n, 0], null)],
      [3, pubkey(null)],
      [6, new Uint8Array([1])],
      [12, pubkey(null)],
      [14, concat(pubkey(null), pubkey(null))],
      [26, concat(pubkey(null), new Uint8Array([0]))],
    ])
    const risk = parseRisk('m', account(TOKEN_2022_PROGRAM_ID, data), 700n)
    expect(risk).toMatchObject({ transferFee: { basisPoints: 0, authority: null, next: null }, mintCloseAuthority: null, permanentDelegate: null, defaultFrozen: false })
    // 可暂停的扩展在（权限为空也算 pausable：扩展存在说明发行时打开了）
    expect(risk.flags).toEqual(['pausable'])
  })
})

beforeEach(() => {
  resetNodeHealth()
})

describe('tokenRisks（假的链）', () => {
  it('一次读完；原生 SOL 按 Wrapped SOL；顺序与输入一致', async () => {
    const chain = createFakeSolana()
    chain.addMint(NATIVE_MINT, 9)
    chain.accounts[TKN] = { lamports: 1n, owner: TOKEN_2022_PROGRAM_ID, data: token2022Mint([[12, pubkey(DELEGATE)]]) }
    const clock = new Uint8Array(40)
    new DataView(clock.buffer).setBigUint64(16, 700n, true)
    chain.accounts[CLOCK_SYSVAR_ID] = { lamports: 1n, owner: 'Sysvar1111111111111111111111111111111111111', data: clock }
    const client = new SolanaClient(chain.transport)
    const missing = keypair(80).address
    const risks = await tokenRisks(client, [TKN, '11111111111111111111111111111111', missing])
    expect(risks.map((r) => [r.mint, r.flags])).toEqual([
      [TKN, ['permanent-delegate']],
      ['11111111111111111111111111111111', []],
      [missing, ['not-found']],
    ])
    await expect(tokenRisks(client, ['not-an-address'])).rejects.toThrow(/Invalid mint/)
  })

  it('持币集中度：getTokenLargestAccounts；节点不支持时为 null', async () => {
    const chain = createFakeSolana()
    chain.accounts[TKN] = { lamports: 1n, owner: TOKEN_PROGRAM_ID, data: mintData({ decimals: 6, supply: 1000n }) }
    const client = new SolanaClient(chain.transport)
    chain.intercept((method) => (method === 'getTokenLargestAccounts' ? { context: { slot: 1 }, value: [{ address: AUTH, amount: '600' }, { address: HOOK, amount: '100' }] } : undefined))
    const [risk] = await tokenRisks(client, [TKN], { concentration: true })
    expect(risk?.topHolders).toEqual({ top10Share: 0.7, accounts: [{ address: AUTH, amount: '600', share: 0.6 }, { address: HOOK, amount: '100', share: 0.1 }] })
    expect(risk?.flags).toEqual(['concentrated'])
    chain.intercept((method) => {
      if (method === 'getTokenLargestAccounts') throw new Error('Method not found')
      return undefined
    })
    const [unsupported] = await tokenRisks(client, [TKN], { concentration: true })
    expect(unsupported?.topHolders).toBe(null)
  })
})

describe('tradeChecks（假的链：模拟买入再卖出）', () => {
  beforeEach(() => {
    blocked.buy.clear()
    blocked.sell.clear()
  })
  const options = { owner: USER.address, amountFormatted: '1', discover: false, pools: [TKN_SOL.address] }

  it('能买能卖：来回损失 ≈ 两次 0.25% 手续费 + 价格影响', async () => {
    const { client } = setupCpmmChain()
    const [check] = await tradeChecks(client, [TKN], options)
    expect(check).toMatchObject({ stage: 'ok', honeypot: false, buyRoute: [{ protocol: 'raydium-cpmm', pool: TKN_SOL.address }], spent: String(SOL), flags: [] })
    expect(check?.roundTripLoss).toBeGreaterThan(0.004)
    expect(check?.roundTripLoss).toBeLessThan(0.006)
  })

  it('卖不出：honeypot；买不进：cannot-buy；找不到池子：no-pool', async () => {
    const { client } = setupCpmmChain()
    blocked.sell.add(TKN)
    const [honeypot] = await tradeChecks(client, [TKN], options)
    expect(honeypot).toMatchObject({ stage: 'sell-failed', honeypot: true, flags: ['honeypot'] })
    expect(honeypot?.error).toMatch(/custom program error/)
    blocked.sell.clear()
    blocked.buy.add(TKN)
    const [cannotBuy] = await tradeChecks(client, [TKN], options)
    expect(cannotBuy).toMatchObject({ stage: 'buy-failed', honeypot: null, flags: ['cannot-buy'] })
    const [noPool] = await tradeChecks(client, [TKN], { ...options, pools: [] })
    expect(noPool).toMatchObject({ stage: 'no-pool', flags: ['no-pool'] })
  })

  it('模拟用的钱包要有足够的 SOL', async () => {
    const { client } = setupCpmmChain()
    await expect(tradeChecks(client, [TKN], { ...options, amountFormatted: '100' })).rejects.toThrow(/does not have enough SOL/)
    await expect(tradeChecks(client, [TKN], { ...options, owner: 'x' })).rejects.toThrow(/Invalid owner/)
  })
})
