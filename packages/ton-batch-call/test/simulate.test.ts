/** 模拟：消息体解码、钱包外部消息解码、退出码、用录下来的主网 emulateTrace 结果算余额变化（假的 toncenter，不连网络） */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { TonClient, toRawAddress, type TonTransport } from '../src/index.js'
import { decodeExternalMessage, decodeMessage, describeExitCode, parseInternalMessage, simulateTransaction } from '../src/subpaths/simulate.js'
import { beginCell, commentCell, externalMessageCell, jettonTransferBody, outMessageCell, signedBody, walletInit } from '../src/subpaths/write.js'

const a = (n: number) => `0:${n.toString(16).padStart(64, 'a')}`
const OWNER = '0:8763791ed45a49eaba433aaaf1ac8ba8a09d691395c5533d0ffab01782606a58'
const USDT = '0:b113a994b5024a16719f69139328eb759596c38a25f59028b146fecdc3621dfe'
const trace = JSON.parse(readFileSync(new URL('./fixtures/swap-trace.json', import.meta.url), 'utf8'))

describe('消息体解码', () => {
  it('空消息体、备注', () => {
    expect(decodeMessage(null)).toMatchObject({ name: 'empty', type: 'transfer', known: true })
    expect(decodeMessage(commentCell('order 42'))).toMatchObject({ name: 'comment', args: { comment: 'order 42' } })
    expect(decodeMessage(beginCell().storeUint(1, 8).endCell())).toMatchObject({ type: 'unknown', known: false })
    expect(decodeMessage('not a boc')).toMatchObject({ name: 'invalid' })
  })

  it('Jetton 转账：数量、收款人、forward 和备注', () => {
    const d = decodeMessage(jettonTransferBody({ amount: 1_500_000n, destination: a(1), responseDestination: a(2), forwardTonAmount: 7n, forwardPayload: commentCell('hi') }))
    expect(d).toMatchObject({ name: 'jetton_transfer', type: 'transfer', args: { amount: '1500000', forwardTonAmount: '7', comment: 'hi' } })
    expect(toRawAddress(d.args.destination as string)).toBe(a(1))
  })

  it('STON.fi v2：Jetton 转账里带兑换、pTON 转账里带流动性；DeDust 兑换和存入', () => {
    const swap = beginCell()
      .storeUint(0x6664de2a, 32)
      .storeAddress(a(3))
      .storeAddress(a(4))
      .storeAddress(a(4))
      .storeUint(1_800_000_000, 64)
      .storeRef(beginCell().storeCoins(739_000n).storeAddress(a(4)).storeCoins(0).storeMaybeRef(null).storeCoins(0).storeMaybeRef(null).storeUint(10, 16).storeAddress(null))
      .endCell()
    const viaJetton = decodeMessage(jettonTransferBody({ amount: 10n, destination: a(1), responseDestination: a(2), forwardTonAmount: 240_000_000n, forwardPayload: swap }))
    expect(viaJetton).toMatchObject({ type: 'swap', protocol: 'STON.fi v2' })
    expect((viaJetton.args.payload as { args: { minOut: string } }).args.minOut).toBe('739000')

    const provide = beginCell().storeUint(0x37c096df, 32).storeAddress(a(3)).storeAddress(a(4)).storeAddress(a(4)).storeUint(1_800_000_000, 64).storeRef(beginCell().storeCoins(5n).storeAddress(a(4)).storeUint(1, 1).storeCoins(0).storeMaybeRef(null)).endCell()
    const pton = beginCell().storeUint(0x01f3835d, 32).storeUint(0, 64).storeCoins(1_000_000_000n).storeAddress(a(4)).storeMaybeRef(provide).endCell()
    expect(decodeMessage(pton)).toMatchObject({ name: 'pton_transfer', type: 'liquidity', protocol: 'STON.fi v2', args: { amount: '1000000000' } })

    const params = beginCell().storeUint(1_800_000_000, 32).storeAddress(a(4)).storeAddress(null).storeMaybeRef(null).storeMaybeRef(null).endCell()
    const dedust = beginCell().storeUint(0xea06185d, 32).storeUint(0, 64).storeCoins(1n).storeAddress(a(5)).storeUint(0, 1).storeCoins(77n).storeMaybeRef(null).storeRef(params).endCell()
    expect(decodeMessage(dedust)).toMatchObject({ name: 'dedust_swap_native', type: 'swap', protocol: 'DeDust', args: { minOut: '77', hops: 1 } })

    const asset = (b: ReturnType<typeof beginCell>) => b.storeUint(0, 4)
    const deposit = asset(asset(beginCell().storeUint(0xd55e4686, 32).storeUint(0, 64).storeCoins(9n).storeUint(0, 1)))
      .storeRef(beginCell().storeCoins(3n).storeCoins(4n).storeCoins(5n))
      .storeMaybeRef(null)
      .storeMaybeRef(null)
      .endCell()
    expect(decodeMessage(deposit)).toMatchObject({ name: 'dedust_deposit_native', type: 'liquidity', protocol: 'DeDust', args: { minLpOut: '3' } })
  })

  it('销毁、NFT 转账', () => {
    expect(decodeMessage(beginCell().storeUint(0x595f07bc, 32).storeUint(0, 64).storeCoins(5n).storeAddress(a(1)).endCell())).toMatchObject({ name: 'jetton_burn', args: { amount: '5' } })
    expect(decodeMessage(beginCell().storeUint(0x5fcc3d14, 32).storeUint(0, 64).storeAddress(a(1)).storeAddress(a(2)).endCell())).toMatchObject({ name: 'nft_transfer', type: 'transfer' })
  })
})

describe('钱包外部消息', () => {
  const key = new Uint8Array(32).fill(7)
  const messages = [
    { message: { to: a(1), value: 5n, bounce: false }, mode: 3 },
    { message: { to: a(2), value: 6n, bounce: true, body: commentCell('x') }, mode: 3 },
  ]
  for (const version of ['v4r2', 'v5r1'] as const) {
    it(`${version}：钱包、seqno、里面的消息`, async () => {
      const body = await signedBody(version, { walletId: 123, seqno: 9, validUntil: 1_800_000_000, messages }, async () => new Uint8Array(64))
      const d = decodeExternalMessage(externalMessageCell(a(9), body, walletInit(version, key, 123)))
      expect(d).toMatchObject({ version, walletId: 123, seqno: 9, validUntil: 1_800_000_000, deploy: true })
      expect(d.messages.map((m) => [toRawAddress(m.to), m.value, m.bounce, m.decoded.name])).toEqual([
        [a(1), '5', false, 'empty'],
        [a(2), '6', true, 'comment'],
      ])
    })
  }
  it('内部消息单独解码', () => {
    const m = parseInternalMessage(outMessageCell({ to: a(1), value: 12n, bounce: true, body: commentCell('x') }))
    expect(m).toMatchObject({ value: 12n, bounce: true, init: null })
    expect(decodeMessage(m.body).name).toBe('comment')
  })
})

describe('退出码', () => {
  it('标准、钱包、Jetton、动作阶段', () => {
    expect(describeExitCode(13)).toMatch(/out of gas/)
    expect(describeExitCode(133, 'wallet')).toMatch(/seqno/)
    expect(describeExitCode(47, 'jetton')).toMatch(/not enough jettons/)
    expect(describeExitCode(37, 'action')).toMatch(/not enough TON/)
    expect(describeExitCode(999)).toBe('exit code 999 (contract-specific code)')
  })
})

describe('simulateTransaction（录下来的 USD₮ → TON 兑换）', () => {
  const requests: string[] = []
  const transport: TonTransport = {
    async get(path, query) {
      requests.push(path)
      if (path === 'walletStates') return { wallets: [{ address: OWNER, is_wallet: true, wallet_type: 'wallet v5 r1', seqno: 42, wallet_id: 2147483409, balance: '1097880743', status: 'active' }] } as never
      if (path === 'jetton/masters') return { jetton_masters: (query.address as string[]).map((x) => ({ address: x, jetton_content: { decimals: '6', symbol: 'USD₮' } })) } as never
      throw new Error(`unexpected ${path}`)
    },
    async post(path, body) {
      requests.push(path)
      expect(path).toBe('../emulate/v1/emulateTrace')
      expect(body).toMatchObject({ ignore_chksig: true, with_actions: true })
      return trace as never
    },
  }
  const ton = new TonClient(transport)

  it('余额变化只列钱包，手续费加起来对得上，解码为兑换', async () => {
    const sim = await simulateTransaction(ton, { from: OWNER, messages: [{ to: a(1), value: 300_000_000n }] })
    expect(sim).toMatchObject({ simulated: true, success: true, decoded: { type: 'swap', protocol: 'STON.fi v2', method: 'jetton_swap' }, incomplete: false })
    expect(sim.decoded.summary).toBe('Swap 1 USD₮ for 0.743854486 TON on STON.fi v2')
    const usdt = sim.balanceChanges.find((c) => c.symbol === 'USD₮')
    expect(usdt).toMatchObject({ delta: '-1000000', formatted: '-1', decimals: 6, address: 'UQCHY3ke1FpJ6rpDOqrxrIuooJ1pE5XFUz0P-rAXgmBqWBEW' })
    expect(sim.balanceChanges).toHaveLength(2)
    expect(BigInt(sim.balanceChanges.find((c) => c.asset === 'native')?.delta ?? 0)).toBeGreaterThan(400_000_000n)
    const f = sim.fees
    expect(BigInt(f?.total ?? 0)).toBe(BigInt(f?.gas ?? 0) + BigInt(f?.storage ?? 0) + BigInt(f?.forward ?? 0) + BigInt(f?.other ?? 0))
    expect(sim.warnings).toEqual([])
    expect(requests).toContain('jetton/masters')
  })

  it('includeContracts 时也列路由器、池子的变化；usd 价格源不可用时为 null', async () => {
    const sim = await simulateTransaction(ton, { from: OWNER, messages: [{ to: a(1), value: 300_000_000n }] }, { includeContracts: true })
    expect(sim.balanceChanges.length).toBeGreaterThan(4)
  })

  it('失败的交易链：可回弹的消息失败 → 错误里有账户、退出码、可读说明', async () => {
    const broken = structuredClone(trace)
    const stonfi = Object.values(broken.transactions).find((t) => (t as { in_msg: { decoded_opcode?: string } }).in_msg.decoded_opcode === 'stonfi_swap_v2') as { description: { aborted: boolean; compute_ph: { success: boolean; exit_code: number } } }
    stonfi.description.aborted = true
    stonfi.description.compute_ph.success = false
    stonfi.description.compute_ph.exit_code = 13
    const t2: TonTransport = { get: transport.get, post: async () => broken as never }
    const sim = await simulateTransaction(new TonClient(t2), { from: OWNER, messages: [{ to: a(1), value: 300_000_000n }] })
    expect(sim.success).toBe(false)
    expect(sim.error).toMatch(/exit code 13: out of gas.*stonfi_swap_v2.*bounced/)
    expect(sim.failures).toHaveLength(1)
  })

  it('钱包拒绝外部消息（toncenter 的 500）→ simulated: false，错误里有钱包的退出码', async () => {
    const { HttpError } = await import('../src/index.js')
    const t3: TonTransport = { get: transport.get, post: async () => Promise.reject(new HttpError('HTTP 500 from toncenter.com: failed to emulate shard block: EmulationExternalNotAccepted: 133', 500)) }
    const sim = await simulateTransaction(new TonClient(t3), { from: OWNER, messages: [{ to: a(1), value: 1n }] })
    expect(sim).toMatchObject({ simulated: false, success: false })
    expect(sim.error).toMatch(/133: wrong seqno/)
  })
})
