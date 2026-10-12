import { ed25519 } from '@noble/curves/ed25519.js'
import { base58 } from '@scure/base'
import { beforeEach, describe, expect, it } from 'vitest'

import { NATIVE_MINT, SolanaClient } from '../src/index.js'
import { resetNodeHealth } from '../src/rpc.js'
import { batchCall, batchCollect, batchTransfer, systemTransfer } from '../src/subpaths/write.js'
import { resolveSigner } from '../src/write/signer.js'
import { messageSigners, serializeTransaction, splitTransaction } from '../src/write/transaction.js'
import { createFakeSolana, keypair, type FakeSolanaOptions } from './fakeSolana.js'

const W = keypair(50) // 浏览器钱包里的账户
const B = keypair(2)
const C = keypair(3)
const LOCAL = keypair(9)
const R1 = keypair(21).address
const HOT = keypair(30).address
const MINT = keypair(40).address
const SOL = 1_000_000_000n
const fast = { pollInterval: 1, timeout: 5_000, priorityFee: 0 }

/** 假的 Wallet Standard 钱包：记录每次确认窗口签了几笔 */
function fakeWallet(kp: ReturnType<typeof keypair>, options: { reject?: boolean; modify?: boolean; accounts?: number; blockhash?: () => Promise<string> } = {}) {
  const prompts: number[] = []
  const chains: Array<string | undefined> = []
  const account = { address: kp.address, publicKey: base58.decode(kp.address), chains: ['solana:mainnet'], features: [] }
  const wallet = {
    name: 'Fake',
    version: '1.0.0' as const,
    accounts: options.accounts === 0 ? [] : [account],
    features: {
      'solana:signTransaction': {
        version: '1.0.0',
        supportedTransactionVersions: ['legacy', 0],
        signTransaction: async (...inputs: Array<{ account: { address: string }; transaction: Uint8Array; chain?: string }>) => {
          prompts.push(inputs.length)
          if (options.reject) throw Object.assign(new Error('User rejected the request.'), { code: 4001 })
          const fresh = options.blockhash ? base58.decode(await options.blockhash()) : null
          return inputs.map(({ account: a, transaction, chain }) => {
            chains.push(chain)
            let { signatures, message } = splitTransaction(transaction)
            if (options.modify) {
              // 像有的钱包那样改计算单元上限（第一条指令：SetComputeUnitLimit）
              message = message.slice()
              const keys = message[3] as number
              const limitAt = 4 + 32 * keys + 32 + 1 + 3 + 1
              const view = new DataView(message.buffer)
              view.setUint32(limitAt, view.getUint32(limitAt, true) + 1000, true)
              signatures = signatures.map(() => new Uint8Array(64))
            }
            if (fresh) {
              // 像有的钱包那样换成新的 blockhash
              message = message.slice()
              message.set(fresh, 4 + 32 * (message[3] as number))
            }
            const signers = messageSigners(message)
            signatures[signers.indexOf(a.address)] = ed25519.sign(message, kp.seed)
            return { signedTransaction: serializeTransaction({ bytes: message, signers }, signatures) }
          })
        },
      },
    },
  }
  return { wallet, prompts, chains }
}

function setup(options: FakeSolanaOptions = {}) {
  const chain = createFakeSolana(options)
  chain.addMint(MINT, 6)
  chain.setSol(W.address, 10n * SOL)
  chain.setSol(LOCAL.address, 10n * SOL)
  const client = new SolanaClient(chain.transport)
  return { chain, client }
}

beforeEach(() => resetNodeHealth())

describe('Solana 浏览器钱包', () => {
  it('多笔交易一次确认：先全部模拟，钱包一次签完，再发送', async () => {
    const { chain, client } = setup()
    const { wallet, prompts, chains } = fakeWallet(W)
    const recipients = Array.from({ length: 50 }, (_, i) => ({ to: keypair(100 + i).address, amount: SOL / 100n }))
    const results = await batchTransfer(client, wallet, recipients, fast)
    expect(results.every((r) => r.status === 'confirmed')).toBe(true)
    const txs = new Set(results.map((r) => r.signature)).size
    expect(txs).toBeGreaterThan(1)
    expect(prompts).toEqual([txs]) // 只弹了一次
    expect(chains.every((c) => c === 'solana:mainnet')).toBe(true)
    expect(chain.sol(recipients[49]!.to)).toBe(SOL / 100n)
  })

  it('钱包当 feePayer 和本地私钥一起签：归集子钱包，手续费由浏览器钱包付', async () => {
    const { chain, client } = setup()
    const { wallet, prompts } = fakeWallet(W)
    chain.setToken(B.address, MINT, 5n)
    chain.setToken(C.address, MINT, 7n)
    const { results } = await batchCollect(client, [B.secretKey, C.secretKey], HOT, { ...fast, tokens: [MINT], feePayer: wallet })
    expect(results.map((r) => r.status)).toEqual(['confirmed', 'confirmed'])
    expect(prompts).toEqual([1])
    expect(chain.token(HOT, MINT)).toBe(12n)
    expect(chain.sol(W.address)).toBeLessThan(10n * SOL)
  })

  it('用户在钱包里拒绝：全部 failed，什么都不发', async () => {
    const { chain, client } = setup()
    const { wallet } = fakeWallet(W, { reject: true })
    const results = await batchTransfer(client, wallet, [{ to: R1, amount: SOL }], fast)
    expect(results[0]).toMatchObject({ status: 'failed', error: 'rejected by user' })
    expect(chain.sent).toHaveLength(0)
  })

  it('钱包改了交易：只有它一个签名者时接受；还有其他签名者时不让本地私钥签', async () => {
    const { chain, client } = setup()
    const { wallet } = fakeWallet(W, { modify: true })
    const [alone] = await batchTransfer(client, wallet, [{ to: R1, amount: SOL }], fast)
    expect(alone).toMatchObject({ status: 'confirmed', fee: null })
    expect(chain.sol(R1)).toBe(SOL)

    const [mixed] = await batchCall(client, [{ from: LOCAL.secretKey, instructions: systemTransfer(LOCAL.address, R1, SOL) }], { ...fast, feePayer: wallet })
    expect(mixed?.status).toBe('failed')
    expect(mixed?.error).toContain('modified')
    expect(chain.sol(R1)).toBe(SOL)
  })

  it('wallet-adapter 的 adapter / useWallet() / { wallet, account } / @solana/kit 签名器（每种都实际签名发送）', async () => {
    const { chain, client } = setup()
    const { wallet, prompts } = fakeWallet(W)
    const publicKey = { toBase58: () => W.address }
    const adapter = { publicKey, wallet }
    const context = { publicKey, wallet: { adapter } }
    let kitCalls = 0
    const kit = {
      address: W.address,
      signTransactions: async (txs: ReadonlyArray<{ messageBytes: Uint8Array }>) => {
        kitCalls++
        return txs.map((t) => ({ [W.address]: ed25519.sign(t.messageBytes, W.seed) }))
      },
    }
    let modifyingCalls = 0
    const modifying = {
      address: W.address,
      modifyAndSignTransactions: async (txs: ReadonlyArray<{ messageBytes: Uint8Array; signatures: Readonly<Record<string, Uint8Array | null>> }>) => {
        modifyingCalls++
        return txs.map((t) => ({ messageBytes: t.messageBytes, signatures: { ...t.signatures, [W.address]: ed25519.sign(t.messageBytes, W.seed) } }))
      },
    }
    const signers = [adapter, context, { wallet, account: W.address }, kit, modifying]
    for (const signer of signers) {
      expect((await resolveSigner(signer)).address).toBe(W.address)
      // 每种单独发一次（同一个付款方的调用会被分到同一组、由第一个签名器签）
      const [result] = await batchCall(client, [{ from: signer, instructions: systemTransfer(W.address, R1, SOL) }], fast)
      expect(result?.status).toBe('confirmed')
    }
    expect(prompts).toEqual([1, 1, 1])
    expect(kitCalls).toBe(1)
    expect(modifyingCalls).toBe(1)
    expect(chain.sol(R1)).toBe(5n * SOL)
  })

  it('钱包换了 blockhash：原 blockhash 过期也不重发（新交易还在有效期内，重发可能两笔都上链）', async () => {
    const { chain, client } = setup({ validBlocks: (call) => (call === 0 ? 1 : 50), landAfterPolls: 4 })
    const { wallet, prompts } = fakeWallet(W, {
      blockhash: async () => (await chain.transport.request<{ value: { blockhash: string } }>('getLatestBlockhash', [{}])).value.blockhash,
    })
    const [result] = await batchTransfer(client, wallet, [{ to: R1, amount: SOL }], fast)
    expect(result?.status).toBe('confirmed')
    expect(prompts).toEqual([1])
    expect(chain.sol(R1)).toBe(SOL)
  })

  it('钱包没连接、adapter 不支持 Wallet Standard 时报错', async () => {
    await expect(resolveSigner(fakeWallet(W, { accounts: 0 }).wallet)).rejects.toThrow('not connected')
    await expect(resolveSigner({ publicKey: null, wallet: null })).rejects.toThrow('not connected')
    await expect(resolveSigner({ publicKey: { toBase58: () => W.address }, signAllTransactions: async () => [] } as never)).rejects.toThrow('Wallet Standard')
  })

  it('dryRun 不会请求钱包签名', async () => {
    const { client } = setup()
    const { wallet, prompts } = fakeWallet(W)
    const [r] = await batchTransfer(client, wallet, [{ to: R1, amount: SOL, token: NATIVE_MINT }], { ...fast, dryRun: true })
    expect(r?.status).toBe('simulated')
    expect(prompts).toEqual([])
  })
})
