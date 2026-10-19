/**
 * 发送流程（假的 toncenter：收到外部消息后按 seqno 执行，交易链和模拟结果可以设定）
 */
import { describe, expect, it } from 'vitest'

import { ApiError, NATIVE_TON, TonClient, toFriendlyAddress, toRawAddress, type TonTransport } from '../src/index.js'
import { Cell, beginCell, bytesToHex } from '../src/write/cell.js'
import { normalizedMessageHash } from '../src/write/message.js'
import { batchCall, batchCollect, batchTransfer, defaultWalletId, resolveTonSigner, walletAddress, type TonConnectLike, type TonConnectRequest } from '../src/subpaths/write.js'

const USDT = `0:${'b1'.repeat(32)}`
const OTHER = `0:${'0e'.repeat(32)}`

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64')
const randomHash = () => b64(crypto.getRandomValues(new Uint8Array(32)))

interface FakeWallet {
  balance: bigint
  status: string
  seqno: number
  type: 'wallet v4 r2' | 'wallet v5 r1'
}

type Outcome = 'ok' | 'bounce' | 'skip'

/** 假的 toncenter：钱包状态、Jetton 钱包、发送、交易链、模拟 */
class FakeChain implements TonTransport {
  readonly label = 'fake'
  readonly wallets = new Map<string, FakeWallet>()
  readonly jettons = new Map<string, Map<string, { wallet: string; balance: string }>>()
  readonly posted: Cell[] = []
  readonly traces = new Map<string, unknown>()
  /** 模拟的结果 */
  emulation: Outcome | 'reject' = 'ok'
  /** 上链后的结果 */
  execution: Outcome = 'ok'
  /** 接下来几笔上链的结果（用完后用 execution） */
  executions: Outcome[] = []
  /** 发出的消息在链上的金额少这么多（没有 +1 的发送模式：转发手续费从金额里扣） */
  feeFromValue = 0n
  /** 元数据在链下、还没被索引的 Jetton */
  readonly unindexed = new Set<string>()
  /** 丢掉前几条外部消息（模拟没上链、过期） */
  drop = 0
  /** 第一条消息晚到：等下一条（重发的）发来时才执行，重发的因为 seqno 已用掉被拒绝 */
  hold = false
  #held: Cell | null = null

  wallet(raw: string, w: FakeWallet) {
    this.wallets.set(toRawAddress(raw), w)
  }

  async get<T>(path: string, query: Record<string, unknown>): Promise<T> {
    const list = (v: unknown) => (Array.isArray(v) ? v : v === undefined ? [] : [v]).map((x) => toRawAddress(String(x)))
    if (path === 'walletStates') {
      return {
        wallets: list(query.address).flatMap((a) => {
          const w = this.wallets.get(a)
          return w ? [{ address: a.toUpperCase().replace('0X', '0x'), is_wallet: true, wallet_type: w.status === 'active' ? w.type : undefined, seqno: w.status === 'active' ? w.seqno : undefined, balance: w.balance.toString(), status: w.status }] : []
        }),
        address_book: {},
      } as T
    }
    if (path === 'accountStates') {
      return { accounts: list(query.address).flatMap((a) => (this.wallets.has(a) ? [{ address: a, balance: this.wallets.get(a)?.balance.toString(), status: this.wallets.get(a)?.status }] : [])), address_book: {} } as T
    }
    if (path === 'jetton/wallets') {
      const masters = list(query.jetton_address)
      const rows = list(query.owner_address).flatMap((o) =>
        [...(this.jettons.get(o)?.entries() ?? [])].filter(([m]) => !masters.length || masters.includes(m)).map(([m, j]) => ({ address: j.wallet, balance: j.balance, owner: o, jetton: m })),
      )
      return { jetton_wallets: Number(query.offset ?? 0) ? [] : rows, address_book: {}, metadata: {} } as T
    }
    if (path === 'jetton/masters') {
      return {
        jetton_masters: list(query.address).map((a) => ({ address: a, total_supply: '1', jetton_content: this.unindexed.has(a) ? { uri: 'https://example.test/jetton.json' } : { decimals: '6' } })),
        address_book: {},
        metadata: {},
      } as T
    }
    if (path === 'traces') {
      const t = this.traces.get(String(query.msg_hash))
      return { traces: t ? [t] : [] } as T
    }
    throw new Error(`unexpected GET ${path}`)
  }

  async post<T>(path: string, body: { boc: string; address?: string }): Promise<T> {
    if (path === 'runGetMethod') {
      const w = this.wallets.get(toRawAddress(body.address as string))
      return (w?.status === 'active' ? { exit_code: 0, stack: [{ type: 'num', value: `0x${w.seqno.toString(16)}` }] } : { exit_code: -13, stack: [] }) as T
    }
    const ext = Cell.fromBase64(body.boc)
    const { wallet, seqno, messages } = this.#parse(ext)
    const w = this.wallets.get(wallet)
    if (path === '../emulate/v1/emulateTrace') {
      if (this.emulation === 'reject' || !w || (w.status === 'active' ? w.seqno : 0) !== seqno) throw new Error('HTTP 500 from fake: inbound external message rejected by account before smart-contract execution')
      return this.#trace(wallet, messages, this.emulation) as T
    }
    if (path === 'message') {
      this.posted.push(ext)
      if (this.hold) {
        this.hold = false
        this.#held = ext
        return { message_hash: '' } as T
      }
      if (this.#held) {
        const late = this.#held
        this.#held = null
        await this.post('message', { boc: late.toBase64() })
        this.posted.pop()
      }
      if (this.drop > 0) {
        this.drop--
        return { message_hash: '' } as T
      }
      if (!w || (w.status === 'active' ? w.seqno : 0) !== seqno) throw new ApiError('HTTP 500: cannot apply external message to current state', 500)
      w.seqno++
      w.status = 'active'
      this.traces.set(bytesToHex(normalizedMessageHash(ext)), this.#trace(wallet, messages, this.executions.shift() ?? this.execution))
      return { message_hash: '' } as T
    }
    throw new Error(`unexpected POST ${path}`)
  }

  #parse(ext: Cell): { wallet: string; seqno: number; messages: OutInfo[] } {
    const s = ext.beginParse()
    s.loadUint(2)
    s.loadAddress()
    const dest = s.loadAddress()
    s.loadCoins()
    if (s.loadBit()) {
      if (s.loadBit()) s.loadRef()
      else {
        s.loadBit()
        s.loadBit()
        s.loadMaybeRef()
        s.loadMaybeRef()
        s.loadBit()
      }
    }
    const body = s.loadBit() ? s.loadRef().beginParse() : s
    const wallet = toRawAddress(dest as never)
    const type = this.wallets.get(wallet)?.type ?? 'wallet v5 r1'
    const cells: Cell[] = []
    let seqno: number
    if (type === 'wallet v4 r2') {
      body.loadBytes(64)
      body.loadUint(64)
      seqno = body.loadUintNumber(32)
      body.loadUint(8)
      while (body.remainingRefs) {
        body.loadUint(8)
        cells.push(body.loadRef())
      }
    } else {
      body.loadUint(96)
      seqno = body.loadUintNumber(32)
      for (let list = body.loadMaybeRef(); list && list.refs.length; list = list.refs[0] as Cell) cells.unshift(list.refs[1] as Cell)
    }
    return { wallet, seqno, messages: cells.map(parseMessage) }
  }

  #trace(wallet: string, messages: OutInfo[], outcome: Outcome) {
    const root = randomHash()
    const sent = outcome === 'skip' ? messages.slice(0, -1) : messages
    const outs = sent.map((m) => ({ hash: randomHash(), destination: m.dest.toUpperCase().replace('0X', '0x'), value: (BigInt(m.value) - this.feeFromValue).toString(), message_content: { hash: m.bodyHash } }))
    const children = outs.map((o) => ({ tx_hash: randomHash(), in_msg_hash: o.hash }))
    const tx = (hash: string, account: string, ok: boolean, extra = {}) => ({
      hash,
      account,
      total_fees: '1000',
      description: { aborted: !ok, compute_ph: { skipped: false, success: ok, exit_code: ok ? 0 : 709 }, action: { success: true, skipped_actions: 0 } },
      in_msg: { bounce: true, bounced: false },
      ...extra,
    })
    const transactions: Record<string, unknown> = {
      [root]: tx(root, wallet, true, { out_msgs: outs, ...(outcome === 'skip' ? { description: { compute_ph: { success: true }, action: { success: true, skipped_actions: 1 } } } : {}) }),
    }
    children.forEach((c, i) => (transactions[c.tx_hash] = tx(c.tx_hash, sent[i]?.dest ?? OTHER, !(outcome === 'bounce' && i === 0))))
    return { trace: { tx_hash: root, children }, transactions, is_incomplete: false, trace_info: { trace_state: 'complete', pending_messages: 0 } }
  }
}

interface OutInfo {
  dest: string
  value: string
  bodyHash: string
}

/** 钱包发出的 MessageRelaxed：目标、金额、消息体哈希 */
function parseMessage(cell: Cell): OutInfo {
  const s = cell.beginParse()
  s.loadUint(4) // int_msg_info$0、ihr_disabled、bounce、bounced
  s.loadAddress()
  const dest = toRawAddress(s.loadAddress() as never)
  const value = s.loadCoins().toString()
  s.loadBit()
  s.loadCoins()
  s.loadCoins()
  s.loadUint(96)
  if (s.loadBit()) {
    if (s.loadBit()) s.loadRef()
    else {
      s.loadBit()
      s.loadBit()
      s.loadMaybeRef()
      s.loadMaybeRef()
      s.loadBit()
    }
  }
  const body = s.loadBit() ? s.loadRef() : beginCell().storeSlice(s).endCell()
  return { dest, value, bodyHash: b64(body.hash()) }
}

const KEY = Uint8Array.from({ length: 32 }, (_, i) => i + 1)
const fast = { pollInterval: 1, timeout: 2000 }

async function setup(type: FakeWallet['type'] = 'wallet v5 r1', balance = 100n * 10n ** 9n) {
  const chain = new FakeChain()
  const signer = await resolveTonSigner(KEY)
  if (signer.kind !== 'key') throw new Error()
  const version = type === 'wallet v4 r2' ? 'v4r2' : 'v5r1'
  const address = toRawAddress(walletAddress(version, signer.publicKey, defaultWalletId(version, 'mainnet')))
  chain.wallet(address, { balance, status: 'active', seqno: 5, type })
  chain.jettons.set(address, new Map([[USDT, { wallet: `0:${'aa'.repeat(32)}`, balance: '50000000' }]]))
  return { chain, ton: new TonClient(chain), address, key: { key: KEY, version } as const }
}

describe('发送流程', () => {
  it('300 个收款人：v5r1 分两笔（255 + 45），seqno 依次递增，结果对应到每个收款人', async () => {
    const { chain, ton, key } = await setup()
    const recipients = Array.from({ length: 300 }, (_, i) => (i % 3 ? { to: OTHER, amount: 1000n } : { to: OTHER, token: USDT, formatted: '0.01' }))
    const results = await batchTransfer(ton, key, recipients, fast)
    expect(results.every((r) => r.status === 'confirmed' && r.fee === '1000')).toBe(true)
    expect(chain.posted.length).toBe(2)
    expect(new Set(results.map((r) => r.hash)).size).toBe(2)
    expect(results[0]?.hash).toBe(results[254]?.hash)
    expect(results[255]?.hash).not.toBe(results[254]?.hash)
    expect(results[0]?.formatted).toBe('0.01')
    expect(chain.wallets.get(results[0] ? toRawAddress(results[0].from) : '')?.seqno).toBe(7)
  })

  it('v4r2 每笔最多 4 条', async () => {
    const { chain, ton, key } = await setup('wallet v4 r2')
    const results = await batchTransfer(ton, key, Array.from({ length: 9 }, () => ({ to: OTHER, amount: 1n })), fast)
    expect(results.map((r) => r.status)).toEqual(Array(9).fill('confirmed'))
    expect(chain.posted.length).toBe(3)
  })

  it('没上链、过期：确认 seqno 没变后重新签名发送', async () => {
    const { chain, ton, key } = await setup()
    chain.drop = 1
    // validFor 为负：一发出就已经过期（检查过期要等 valid_until 之后 15 秒）
    const [r] = await batchTransfer(ton, key, [{ to: OTHER, amount: 1n }], { ...fast, validFor: -30 })
    expect(r?.status).toBe('confirmed')
    expect(chain.posted.length).toBe(2)
    chain.drop = 5
    const [r2] = await batchTransfer(ton, key, [{ to: OTHER, amount: 1n }], { ...fast, validFor: -30, retries: 1 })
    expect([r2?.status, r2?.error]).toEqual(['failed', 'expired: the transaction was not included before valid_until'])
  })

  it('重发后原来那条才上链：按两个哈希都查，结果是原来那条', async () => {
    const { chain, ton, key } = await setup()
    chain.hold = true
    const [r] = await batchTransfer(ton, key, [{ to: OTHER, amount: 1n }], { ...fast, validFor: -40 })
    expect(r?.status).toBe('confirmed')
    expect(chain.posted.length).toBe(2)
    expect(r?.hash).toBe(bytesToHex(normalizedMessageHash(chain.posted[0] as Cell)))
  })

  it('上链后有一条没发出（TON 不够）：逐条给结果', async () => {
    const { chain, ton, key } = await setup()
    chain.execution = 'skip'
    const results = await batchTransfer(ton, key, [{ to: OTHER, amount: 1n }, { to: OTHER, amount: 2n }], fast)
    expect(results.map((r) => [r.status, r.error])).toEqual([
      ['confirmed', null],
      ['reverted', 'the message was not sent (not enough TON?)'],
    ])
  })

  it('测试网节点：按 URL 判断网络', () => {
    expect(new TonClient('https://testnet.toncenter.com/api/v3').network).toBe('testnet')
    expect(new TonClient().network).toBe('mainnet')
  })

  it('上链后消息被退回：reverted，同一钱包后面的交易跳过', async () => {
    const { chain, ton, key } = await setup('wallet v4 r2')
    chain.execution = 'bounce'
    const results = await batchTransfer(ton, key, Array.from({ length: 5 }, () => ({ to: OTHER, token: USDT, amount: 1n })), fast)
    // 只有第一条退回：同一笔里其他的照样成功；这笔有失败，同一钱包后面的跳过
    expect(results[0]?.status).toBe('reverted')
    expect(results[0]?.error).toMatch(/bounced/)
    expect(results.slice(1, 4).map((r) => [r.status, r.error])).toEqual(Array(3).fill(['confirmed', null]))
    expect(results[4]?.status).toBe('skipped')
    expect(chain.posted.length).toBe(1)
  })

  it('模拟失败的不发送；消息被跳过（TON 不够）也算失败', async () => {
    const { chain, ton, key } = await setup()
    chain.emulation = 'reject'
    const [r] = await batchTransfer(ton, key, [{ to: OTHER, amount: 1n }], fast)
    expect(r?.status).toBe('failed')
    expect(r?.error).toMatch(/rejected the message/)
    // TON 不够：最后一条没发出，模拟失败（整笔不发），各自的原因
    chain.emulation = 'skip'
    const r2 = await batchTransfer(ton, key, [{ to: OTHER, amount: 1n }, { to: OTHER, amount: 2n }], fast)
    expect(r2.map((r) => [r.status, r.error])).toEqual([
      ['failed', 'not sent: another message in the same transaction failed (simulation failed: the message was not sent (not enough TON?))'],
      ['failed', 'the message was not sent (not enough TON?)'],
    ])
    expect(chain.posted.length).toBe(0)
  })

  it('wait: false 只发每个钱包的第一笔', async () => {
    const { chain, ton, key } = await setup('wallet v4 r2')
    const results = await batchTransfer(ton, key, Array.from({ length: 5 }, () => ({ to: OTHER, amount: 1n })), { ...fast, wait: false })
    expect(results.map((r) => r.status)).toEqual(['sent', 'sent', 'sent', 'sent', 'skipped'])
    expect(chain.posted.length).toBe(1)
  })

  it('TON Connect 钱包：请求里的地址、金额、payload，按返回的 BOC 查结果', async () => {
    const { chain, ton, address } = await setup()
    const requests: TonConnectRequest[] = []
    const connector: TonConnectLike = {
      wallet: { account: { address: toFriendlyAddress(address, { bounceable: false }) }, device: { features: ['SendTransaction', { name: 'SendTransaction', maxMessages: 4 }] } },
      sendTransaction: async (req) => {
        requests.push(req)
        // 钱包自己签名、发送：这里用同一个私钥代签
        const [r] = await batchCall(ton, [{ from: { key: KEY, version: 'v5r1' }, messages: req.messages.map((m) => ({ to: m.address, value: m.amount, body: m.payload, bounce: toFriendlyAddress(m.address) === m.address })) }], { ...fast, wait: false })
        return { boc: chain.posted.at(-1)?.toBase64() ?? String(r?.status) }
      },
    }
    const results = await batchTransfer(ton, connector, [{ to: OTHER, amount: 5n, comment: 'x' }, { to: OTHER, token: USDT, amount: 1n }], fast)
    expect(results.map((r) => r.status)).toEqual(['confirmed', 'confirmed'])
    expect(requests[0]?.messages.map((m) => [m.amount, typeof m.payload])).toEqual([
      ['5', 'string'],
      ['50000001', 'string'],
    ])
    expect(requests[0]?.network).toBe('-239')
    // 用户拒绝
    const [rejected] = await batchTransfer(ton, { ...connector, sendTransaction: async () => Promise.reject(new Error('User rejected the request')) }, [{ to: OTHER, amount: 5n }], fast)
    expect([rejected?.status, rejected?.error]).toEqual(['failed', 'rejected by user'])
  })

  it('归集：先给 TON 不够的钱包补 gas，再转走 Jetton 和剩下的 TON', async () => {
    const { chain, ton, key, address } = await setup()
    const poorKey = Uint8Array.from({ length: 32 }, (_, i) => 100 + i)
    const poor = await resolveTonSigner(poorKey)
    if (poor.kind !== 'key') throw new Error()
    const poorAddress = toRawAddress(walletAddress('v5r1', poor.publicKey, defaultWalletId('v5r1', 'mainnet')))
    // 只收过 Jetton、从没部署过的钱包
    chain.wallet(poorAddress, { balance: 0n, status: 'uninit', seqno: 0, type: 'wallet v5 r1' })
    chain.jettons.set(poorAddress, new Map([[USDT, { wallet: `0:${'cc'.repeat(32)}`, balance: '7' }]]))
    const results = await batchCollect(ton, [poorKey, key], OTHER, { ...fast, tokens: [USDT, NATIVE_TON], gasFunder: key })
    expect(results.map((r) => [r.status, r.tokens])).toEqual([
      ['confirmed', [toFriendlyAddress(USDT), NATIVE_TON]],
      ['confirmed', [toFriendlyAddress(USDT), NATIVE_TON]],
    ])
    expect(results[0]?.funding?.status).toBe('confirmed')
    expect(results[1]?.funding).toBe(null)
    // 补 gas 1 笔 + 两个钱包各 1 笔
    expect(chain.posted.length).toBe(3)
    expect(chain.wallets.get(poorAddress)?.status).toBe('active')
    expect(chain.wallets.get(address)?.seqno).toBe(7)
  })

  it('发送模式没有 +1（手续费从金额里扣）：链上金额少一些也对应得上', async () => {
    const { chain, ton, key } = await setup()
    chain.feeFromValue = 400n
    const [plain, separate] = await batchCall(
      ton,
      [
        { from: key, messages: [{ to: OTHER, value: 10_000n, mode: 0 }] },
        { from: key, messages: [{ to: OTHER, value: 10_000n }] },
      ],
      fast,
    )
    expect([plain?.status, plain?.error]).toEqual(['confirmed', null])
    // 默认模式（3，手续费另付）金额应该一点不少：少了说明不是这条消息
    expect(separate?.status).toBe('failed')
  })

  it('归集补 gas：同一笔里有的消息没发出时，按各自的消息给结果', async () => {
    const { chain, ton, key } = await setup()
    const poorKeys = [100, 140].map((b) => Uint8Array.from({ length: 32 }, (_, i) => b + i))
    for (const k of poorKeys) {
      const s = await resolveTonSigner(k)
      if (s.kind !== 'key') throw new Error()
      const a = toRawAddress(walletAddress('v5r1', s.publicKey, defaultWalletId('v5r1', 'mainnet')))
      chain.wallet(a, { balance: 0n, status: 'uninit', seqno: 0, type: 'wallet v5 r1' })
      chain.jettons.set(a, new Map([[USDT, { wallet: `0:${(k[0] as number).toString(16).padStart(2, '0').repeat(32)}`, balance: '7' }]]))
    }
    // 补 gas 那笔上链后最后一条消息没发出（TON 不够）
    chain.executions = ['skip']
    const results = await batchCollect(ton, poorKeys, OTHER, { ...fast, tokens: [USDT], gasFunder: key })
    expect(results[0]?.funding?.status).toBe('confirmed')
    expect(results[1]?.funding?.status).toBe('reverted')
    expect(results[0]?.status).toBe('confirmed')
    expect(results[1]?.status).not.toBe('confirmed')
  })

  it('链下元数据还没索引的 Jetton：不知道精度，不接受 formatted', async () => {
    const { chain, ton, key, address } = await setup()
    // 元数据是进程内缓存的：用一个别的测试没读过的 Jetton
    const fresh = `0:${'f1'.repeat(32)}`
    chain.jettons.get(address)?.set(fresh, { wallet: `0:${'f2'.repeat(32)}`, balance: '5' })
    chain.unindexed.add(fresh)
    await expect(batchTransfer(ton, key, [{ to: OTHER, token: fresh, formatted: '1' }], fast)).rejects.toThrow(/decimals .* not known/)
    const [r] = await batchTransfer(ton, key, [{ to: OTHER, token: fresh, amount: 1n }], fast)
    expect(r?.status).toBe('confirmed')
  })

  it('已经取消的 signal：不发出任何请求', async () => {
    const { chain, ton, key } = await setup()
    const results = await batchTransfer(ton, key, [{ to: OTHER, amount: 1n }], { ...fast, signal: AbortSignal.abort() }).catch((err: unknown) => err)
    expect(chain.posted.length).toBe(0)
    expect(results instanceof Error || (Array.isArray(results) && results.every((r) => r.status === 'skipped'))).toBe(true)
  })
})
