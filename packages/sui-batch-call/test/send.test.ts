/**
 * 发送流程（假的节点：Coin、地址余额、模拟、执行、按摘要查交易），不连网络
 */
import { describe, expect, it } from 'vitest'

import { SUI_COIN_TYPE, SuiClient, normalizeStructTag, normalizeSuiAddress } from '../src/index.js'
import { GrpcError, HttpError, type GrpcResponse, type GrpcTransport } from '../src/grpc.js'
import { ProtoMessage, ProtoWriter } from '../src/proto.js'
import { decodeKindInputs } from '../src/write/bcs.js'
import { ObjectCache, buildContext } from '../src/write/send.js'
import { batchCollect, batchTransfer, resolveSigner, transactionDigest } from '../src/subpaths/write.js'

const KEY = '0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20'
const KEY2 = '2122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f40'
const TO = normalizeSuiAddress('0x5')
const TOKEN = normalizeStructTag('0xabc::tok::TOK')
const D = '11111111111111111111111111111111'

interface Coin {
  id: string
  owner: string
  type: string
  balance: bigint
  version: bigint
}

const hex32 = (n: number) => normalizeSuiAddress(`0x${n.toString(16)}`)

/** 假的节点：只实现发送流程用到的方法 */
class FakeSui implements GrpcTransport {
  readonly label = 'fake'
  readonly coins: Coin[] = []
  /** owner|coinType → 地址余额 */
  readonly addressBalances = new Map<string, bigint>()
  /** 执行过的交易字节（模拟的不算） */
  readonly executed: Uint8Array[] = []
  readonly simulated: Uint8Array[] = []
  readonly calls: string[] = []
  /** 接下来几次 ExecuteTransaction 抛出的错误 */
  executeErrors: Error[] = []
  /** 执行结果里改变的对象（测试设定） */
  changed: Array<{ objectId: string; version: bigint; digest: string }> = []
  #nextId = 1000

  coin(owner: string, type: string, balance: bigint): Coin {
    const c = { id: hex32(this.#nextId++), owner: normalizeSuiAddress(owner), type: normalizeStructTag(type), balance, version: 3n }
    this.coins.push(c)
    return c
  }

  async unary(method: string, request: Uint8Array): Promise<GrpcResponse> {
    const name = method.split('/').pop() as string
    this.calls.push(name)
    const req = ProtoMessage.decode(request)
    const w = new ProtoWriter()
    const coinObject = (c: Coin) => new ProtoWriter().string(2, c.id).uint(3, c.version).string(4, D).string(6, `0x2::coin::Coin<${c.type}>`).uint(101, c.balance)
    switch (name) {
      case 'GetServiceInfo':
        w.string(1, 'fake-chain').string(2, 'mainnet').uint(3, 7).uint(4, 100)
        break
      case 'GetEpoch':
        w.message(1, new ProtoWriter().uint(1, 7).uint(8, 1000))
        break
      case 'GetBalance': {
        const owner = req.string(1) as string
        const type = normalizeStructTag(req.string(2) as string)
        const coinBalance = this.coins.filter((c) => c.owner === owner && c.type === type).reduce((s, c) => s + c.balance, 0n)
        const address = this.addressBalances.get(`${owner}|${type}`) ?? 0n
        w.message(1, new ProtoWriter().string(1, type).uint(3, coinBalance + address).uint(4, address).uint(5, coinBalance))
        break
      }
      case 'GetCoinInfo':
        w.string(1, req.string(1) as string).message(2, new ProtoWriter().string(1, '0xmeta').uint(2, 6).string(3, 'Token').string(4, 'TOK'))
        break
      case 'ListOwnedObjects': {
        const owner = req.string(1) as string
        const size = req.number(2) ?? 1000
        const start = req.bytes(3)?.length ? Number(new TextDecoder().decode(req.bytes(3) as Uint8Array)) : 0
        const type = req.string(5) ?? ''
        const inner = /^0x2::coin::Coin<(.+)>$/.exec(type)?.[1]
        const list = this.coins.filter((c) => c.owner === owner && (!inner || c.type === normalizeStructTag(inner)))
        for (const c of list.slice(start, start + size)) w.message(1, coinObject(c))
        if (start + size < list.length) w.bytes(2, new TextEncoder().encode(String(start + size)))
        break
      }
      case 'BatchGetObjects':
        for (const r of req.messages(1)) {
          const c = this.coins.find((x) => x.id === normalizeSuiAddress(r.string(1) as string))
          w.message(1, c ? new ProtoWriter().message(1, coinObject(c)) : new ProtoWriter().message(2, new ProtoWriter().uint(1, 5)))
        }
        break
      case 'SimulateTransaction': {
        this.simulated.push(txBytes(req))
        w.message(1, this.#effects(null))
        break
      }
      case 'ExecuteTransaction': {
        const err = this.executeErrors.shift()
        if (err) throw err
        const bytes = txBytes(req)
        this.executed.push(bytes)
        w.message(1, this.#effects(transactionDigest(bytes)).uint(6, 101))
        break
      }
      case 'GetTransaction': {
        const digest = req.string(1)
        const bytes = this.executed.find((b) => transactionDigest(b) === digest)
        if (!bytes) throw new GrpcError(5, `transaction ${digest} not found`)
        w.message(1, this.#effects(digest).uint(6, 101))
        break
      }
      default:
        throw new GrpcError(12, `unimplemented ${method}`)
    }
    return { message: ProtoMessage.decode(w.finish()), checkpoint: 200, chain: 'mainnet' }
  }

  #effects(digest: string | null): ProtoWriter {
    const effects = new ProtoWriter().message(4, new ProtoWriter().uint(1, 1)).message(6, new ProtoWriter().uint(1, 1_000_000).uint(2, 2_000_000).uint(3, 500_000))
    for (const c of this.changed) effects.message(12, new ProtoWriter().string(1, c.objectId).uint(7, c.version).string(8, c.digest))
    const w = new ProtoWriter().message(4, effects)
    if (digest) w.string(1, digest)
    return w
  }
}

/** ExecuteTransactionRequest / SimulateTransactionRequest 里的交易字节 */
const txBytes = (req: ProtoMessage) => req.message(1)?.message(1)?.bytes(2) as Uint8Array

/** TransactionData（V1）里的 TransactionKind 的输入：跳过开头的版本标记 */
const inputsOf = (bytes: Uint8Array) => decodeKindInputs(bytes.subarray(1))

async function setup() {
  const node = new FakeSui()
  const signer = await resolveSigner(KEY)
  return { node, sui: new SuiClient(node), owner: signer.address }
}

describe('发送流程', () => {
  it('batchSize 最多 500（一条命令最多 512 个参数）', async () => {
    const { node, sui, owner } = await setup()
    node.coin(owner, SUI_COIN_TYPE, 10n ** 12n)
    const recipients = Array.from({ length: 600 }, () => ({ to: TO, amount: 1n }))
    const results = await batchTransfer(sui, KEY, recipients, { batchSize: 1000 })
    expect(results.every((r) => r.status === 'confirmed')).toBe(true)
    expect(node.executed.length).toBe(2)
  })

  it('已经取消的 signal：不签名、不发送', async () => {
    const { node, sui, owner } = await setup()
    node.coin(owner, SUI_COIN_TYPE, 10n ** 12n)
    const results = await batchTransfer(sui, KEY, [{ to: TO, amount: 1n }], { signal: AbortSignal.abort(), checkBalance: false }).catch((err: unknown) => err)
    expect(node.calls).not.toContain('ExecuteTransaction')
    expect(results instanceof Error || (Array.isArray(results) && results.every((r) => r.status === 'skipped'))).toBe(true)
  })

  it('上一次提交可能已经送到节点（超时）、重试时又出错：结果是 sent，不是 failed', async () => {
    const { node, sui, owner } = await setup()
    node.coin(owner, SUI_COIN_TYPE, 10n ** 12n)
    node.executeErrors = [new HttpError('timed out', undefined, true), new GrpcError(9, 'object is locked by another transaction')]
    const [r] = await batchTransfer(sui, KEY, [{ to: TO, amount: 1n }])
    expect(r?.status).toBe('sent')
    expect(r?.digest).toMatch(/^[1-9A-HJ-NP-Za-km-z]+$/)
    // 第一次就是确定的错误：没有发出
    node.executeErrors = [new GrpcError(3, 'invalid signature')]
    const [f] = await batchTransfer(sui, KEY, [{ to: TO, amount: 1n }])
    expect(f?.status).toBe('failed')
  })

  it('Coin 太多一笔用不完、地址余额又不够补：报清楚的错误（不发交易）', async () => {
    const { node, sui, owner } = await setup()
    node.coin(owner, SUI_COIN_TYPE, 10n ** 12n)
    for (let i = 0; i < 1001; i++) node.coin(owner, TOKEN, 1n)
    const [r] = await batchTransfer(sui, KEY, [{ to: TO, token: TOKEN, amount: 1001n }])
    expect(r?.status).toBe('failed')
    expect(r?.error).toMatch(/Cannot gather 1001/)
    expect(node.executed.length).toBe(0)
    // 地址余额够补时照常发送：1000 个 Coin + 从地址余额取 1
    node.addressBalances.set(`${owner}|${TOKEN}`, 5n)
    const [ok] = await batchTransfer(sui, KEY, [{ to: TO, token: TOKEN, amount: 1001n }])
    expect(ok?.status).toBe('confirmed')
    expect(inputsOf(node.executed[0] as Uint8Array).withdrawals).toEqual([{ amount: 1n, coinType: TOKEN, from: 'sender' }])
  })

  it('归集：有地址余额的代币超过 9 种时每笔最多取 9 次（留一次给地址余额付 gas）；重复的钱包只归集一次', async () => {
    const { node, sui, owner } = await setup()
    node.coin(owner, SUI_COIN_TYPE, 10n ** 10n)
    const tokens = Array.from({ length: 11 }, (_, i) => normalizeStructTag(`0xabc::t${i}::T${i}`))
    for (const t of tokens) node.addressBalances.set(`${owner}|${t}`, 7n)
    const results = await batchCollect(sui, [KEY, KEY], TO, { tokens })
    expect(results[0]?.status).toBe('confirmed')
    expect(results[1]).toMatchObject({ status: 'skipped', error: 'skipped: duplicate wallet' })
    expect(node.executed.length).toBe(1)
    expect(inputsOf(node.executed[0] as Uint8Array).withdrawals.length).toBe(9)
  })

  it('归集 SUI（gas 币整个转走）：gas 币只剩零头、地址余额更多时也用 Coin 付 gas', async () => {
    const { node, sui, owner } = await setup()
    const dust = node.coin(owner, SUI_COIN_TYPE, 5_000_000n)
    node.addressBalances.set(`${owner}|${SUI_COIN_TYPE}`, 10n ** 10n)
    const [r] = await batchCollect(sui, [KEY], TO)
    expect(r?.status).toBe('confirmed')
    // gas 币在交易的 gas 数据里（命令里用的是 GasCoin，不在输入里）
    const tx = Buffer.from(node.executed[0] as Uint8Array).toString('hex')
    expect(tx).toContain(dust.id.slice(2))
  })
})

describe('构建交易时读到的 Coin', () => {
  it('本批前面的交易改过、节点还没反映出来的 Coin：按缓存的版本重新读余额，读不到这个版本的跳过', async () => {
    const node = new FakeSui()
    const sui = new SuiClient(node)
    const { address: owner } = await resolveSigner(KEY2)
    const a = node.coin(owner, TOKEN, 150n)
    const b = node.coin(owner, TOKEN, 80n)
    const cache = new ObjectCache()
    // 执行结果：a 变成版本 5（还剩 50），b 变成版本 6
    cache.apply({ digest: null, success: true, error: null, gasUsed: null, checkpoint: null, changedObjects: [{ objectId: a.id, version: 5n, digest: D }, { objectId: b.id, version: 6n, digest: D }] })
    const ctx = buildContext(sui, cache, () => ({}))
    // 列表还是旧的（版本 3、余额 150 / 80）；按 ID 读时 a 已经是新版本，b 还是旧版本
    const listed = { a: { ...a }, b: { ...b } }
    node.coins.splice(0, node.coins.length, listed.a, listed.b)
    const listing = node.unary.bind(node)
    node.unary = async (method, request) => {
      if (method.endsWith('BatchGetObjects')) {
        a.version = 5n
        a.balance = 50n
        node.coins.splice(0, node.coins.length, a, listed.b)
      }
      return listing(method, request)
    }
    const coins = await ctx.coins(owner, TOKEN)
    expect(coins.map((c) => [c.objectId, c.version, c.balance])).toEqual([[a.id, 5n, 50n]])
  })
})
