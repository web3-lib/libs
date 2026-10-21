/** 授权管理：代币账户的解析、授权 / 空账户的列出、撤销和关闭的指令，发送（模拟节点 / 假节点，不连网络） */
import { base64 } from '@scure/base'
import { beforeEach, describe, expect, it } from 'vitest'

import { NATIVE_MINT, SolanaClient, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, decodeAddress, getAssociatedTokenAddress, getMetadataAddress } from '../src/index.js'
import { resetNodeHealth } from '../src/rpc.js'
import { resetClientCache } from '../src/shortcuts.js'
import {
  approvals,
  buildCloses,
  buildRevokes,
  closeTokenAccounts,
  getApprovals,
  parseTokenAccountState,
  revokeApprovals,
  type TokenAccountApproval,
} from '../src/subpaths/approvals.js'
import { createFakeSolana, keypair } from './fakeSolana.js'
import { createMockNode, metaplexData, mintData, type MockAccount } from './mock.js'

const OWNER = keypair(1)
const OTHER = keypair(2).address
const SPENDER = keypair(3).address
const MINT = keypair(40).address
const T22_MINT = keypair(41).address
const MINT3 = keypair(42).address

interface AccountOptions {
  amount?: bigint
  delegate?: string
  delegatedAmount?: bigint
  frozen?: boolean
  /** Wrapped SOL：is_native 里的免租额 */
  native?: bigint
  closeAuthority?: string
  /** Token-2022 扩展（TLV） */
  extensions?: Array<{ type: number; data: Uint8Array }>
}

/** 完整的代币账户布局（165 字节；有扩展时补上账户类型 2 和 TLV） */
function accountData(mint: string, owner: string, o: AccountOptions = {}): Uint8Array {
  const out = new Uint8Array(165)
  const view = new DataView(out.buffer)
  out.set(decodeAddress(mint), 0)
  out.set(decodeAddress(owner), 32)
  view.setBigUint64(64, o.amount ?? 0n, true)
  if (o.delegate) {
    view.setUint32(72, 1, true)
    out.set(decodeAddress(o.delegate), 76)
  }
  out[108] = o.frozen ? 2 : 1
  if (o.native !== undefined) {
    view.setUint32(109, 1, true)
    view.setBigUint64(113, o.native, true)
  }
  view.setBigUint64(121, o.delegatedAmount ?? 0n, true)
  if (o.closeAuthority) {
    view.setUint32(129, 1, true)
    out.set(decodeAddress(o.closeAuthority), 133)
  }
  if (!o.extensions) return out
  const tlv = o.extensions.flatMap(({ type, data }) => [type & 0xff, type >> 8, data.length & 0xff, data.length >> 8, ...data])
  return new Uint8Array([...out, 2, ...tlv])
}

const u64 = (v: bigint) => {
  const b = new Uint8Array(8)
  new DataView(b.buffer).setBigUint64(0, v, true)
  return b
}

/** Token-2022 mint：精度 + PermanentDelegate 扩展 */
function t22Mint(decimals: number, permanentDelegate?: string): Uint8Array {
  const base = mintData({ decimals })
  const ext = permanentDelegate ? [12, 0, 32, 0, ...decodeAddress(permanentDelegate)] : [7, 0, 0, 0]
  return new Uint8Array([...base, ...new Uint8Array(165 - 82), 1, ...ext])
}

beforeEach(() => {
  resetNodeHealth()
  resetClientCache()
})

describe('parseTokenAccountState', () => {
  it('delegate、冻结、Wrapped SOL、关闭权限、暂存的转账手续费、机密余额', () => {
    const p = parseTokenAccountState(
      accountData(MINT, OWNER.address, { amount: 5n, delegate: SPENDER, delegatedAmount: 3n, frozen: true, closeAuthority: OTHER, native: 2_039_280n }),
    )
    expect(p).toMatchObject({ mint: MINT, owner: OWNER.address, amount: 5n, delegate: SPENDER, delegatedAmount: 3n, frozen: true, native: true, closeAuthority: OTHER, withheldAmount: 0n })
    const t22 = parseTokenAccountState(
      accountData(T22_MINT, OWNER.address, {
        extensions: [
          { type: 7, data: new Uint8Array() }, // ImmutableOwner
          { type: 2, data: u64(77n) }, // TransferFeeAmount
        ],
      }),
    )
    expect(t22).toMatchObject({ delegate: null, closeAuthority: null, native: false, withheldAmount: 77n, confidentialBalance: false })
    // ConfidentialTransferAccount：可用余额的密文不为 0
    const confidential = new Uint8Array(295)
    confidential[200] = 1
    expect(parseTokenAccountState(accountData(T22_MINT, OWNER.address, { extensions: [{ type: 5, data: confidential }] }))?.confidentialBalance).toBe(true)
    // 未初始化 / 不是代币账户
    expect(parseTokenAccountState(new Uint8Array(165))).toBe(null)
    expect(parseTokenAccountState(mintData({ decimals: 6 }))).toBe(null)
  })
})

function setup(extra: Record<string, MockAccount> = {}) {
  const ata = (mint: string, program: string) => getAssociatedTokenAddress(OWNER.address, mint, program)
  const accounts: Record<string, MockAccount> = {
    [MINT]: { owner: TOKEN_PROGRAM_ID, data: mintData({ decimals: 6 }) },
    [getMetadataAddress(MINT)]: { owner: 'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s', data: metaplexData({ mint: MINT, name: 'USD Coin', symbol: 'USDC' }) },
    [T22_MINT]: { owner: TOKEN_2022_PROGRAM_ID, data: t22Mint(9, OTHER) },
    [MINT3]: { owner: TOKEN_PROGRAM_ID, data: mintData({ decimals: 0 }) },
    // 有余额、授权给 SPENDER
    [ata(MINT, TOKEN_PROGRAM_ID)]: { lamports: 2_039_280n, owner: TOKEN_PROGRAM_ID, data: accountData(MINT, OWNER.address, { amount: 1_500_000n, delegate: SPENDER, delegatedAmount: 1_000_000n }) },
    // Token-2022：空账户，有暂存的转账手续费
    [ata(T22_MINT, TOKEN_2022_PROGRAM_ID)]: {
      lamports: 2_074_080n,
      owner: TOKEN_2022_PROGRAM_ID,
      data: accountData(T22_MINT, OWNER.address, { extensions: [{ type: 2, data: u64(12n) }] }),
    },
    // 有余额、没有授权：默认不列出
    [ata(MINT3, TOKEN_PROGRAM_ID)]: { lamports: 2_039_280n, owner: TOKEN_PROGRAM_ID, data: accountData(MINT3, OWNER.address, { amount: 4n }) },
    // Wrapped SOL：空账户
    [ata(NATIVE_MINT, TOKEN_PROGRAM_ID)]: { lamports: 2_039_280n, owner: TOKEN_PROGRAM_ID, data: accountData(NATIVE_MINT, OWNER.address, { native: 2_039_280n }) },
    ...extra,
  }
  const node = createMockNode({ accounts })
  return { node, client: new SolanaClient(node), ata }
}

describe('approvals', () => {
  it('指定 mints：读两个程序的 ATA，返回有授权的和空账户；精度 / symbol / 永久授权来自 mint', async () => {
    const { node, client, ata } = setup()
    const list = await approvals(client, OWNER.address, { mints: [MINT, T22_MINT, MINT3, NATIVE_MINT, 'not-a-mint'] })
    expect(list.map((a) => a.account)).toEqual([ata(MINT, TOKEN_PROGRAM_ID), ata(T22_MINT, TOKEN_2022_PROGRAM_ID), ata(NATIVE_MINT, TOKEN_PROGRAM_ID)])
    expect(list[0]).toEqual({
      account: ata(MINT, TOKEN_PROGRAM_ID),
      mint: MINT,
      owner: OWNER.address,
      tokenProgram: TOKEN_PROGRAM_ID,
      ata: true,
      native: false,
      symbol: 'USDC',
      decimals: 6,
      amount: '1500000',
      formatted: '1.5',
      delegate: SPENDER,
      delegatedAmount: '1000000',
      delegatedFormatted: '1',
      closeAuthority: null,
      permanentDelegate: null,
      frozen: false,
      lamports: '2039280',
      withheldAmount: '0',
      revocable: true,
      closable: false,
      closeBlocker: 'balance',
    } satisfies TokenAccountApproval)
    expect(list[1]).toMatchObject({ tokenProgram: TOKEN_2022_PROGRAM_ID, decimals: 9, permanentDelegate: OTHER, withheldAmount: '12', closable: true, closeBlocker: null, revocable: false })
    expect(list[2]).toMatchObject({ native: true, closable: true, symbol: null })
    // 一次读 ATA，一次读 mint + 元数据
    expect(node.calls.filter((c) => c.method === 'getMultipleAccounts')).toHaveLength(2)

    const all = await approvals(client, OWNER.address, { mints: [MINT3], all: true })
    expect(all.map((a) => [a.amount, a.closeBlocker])).toEqual([['4', 'balance']])
  })

  it('关闭权限是别人：列出、不能关闭；冻结的账户不能撤销；owner 被改过的 ATA 不算', async () => {
    const ata = (mint: string) => getAssociatedTokenAddress(OWNER.address, mint, TOKEN_PROGRAM_ID)
    const m1 = keypair(50).address
    const m2 = keypair(51).address
    const m3 = keypair(52).address
    const extra = {
      [m1]: { owner: TOKEN_PROGRAM_ID, data: mintData({ decimals: 0 }) },
      [m2]: { owner: TOKEN_PROGRAM_ID, data: mintData({ decimals: 0 }) },
      [m3]: { owner: TOKEN_PROGRAM_ID, data: mintData({ decimals: 0 }) },
      [ata(m1)]: { owner: TOKEN_PROGRAM_ID, data: accountData(m1, OWNER.address, { amount: 1n, closeAuthority: OTHER }) },
      [ata(m2)]: { owner: TOKEN_PROGRAM_ID, data: accountData(m2, OWNER.address, { delegate: SPENDER, frozen: true }) },
      [ata(m3)]: { owner: TOKEN_PROGRAM_ID, data: accountData(m3, OTHER, { delegate: SPENDER }) },
    }
    const { client } = setup(extra)
    const list = await approvals(client, OWNER.address, { mints: [m1, m2, m3] })
    expect(list.map((a) => [a.mint, a.closable, a.closeBlocker, a.revocable, a.frozen])).toEqual([
      [m1, false, 'close-authority', false, false],
      [m2, true, null, false, true],
    ])
    expect(buildRevokes(list)).toEqual([])
    expect(buildCloses(list).map((c) => c.approval.mint)).toEqual([m2])
  })

  it('不传 mints：getTokenAccountsByOwner（base64）列出两个程序的账户；节点不支持时提示传 mints', async () => {
    const { node, client, ata } = setup()
    const wrapped = {
      async request<T>(method: string, params: readonly unknown[] = []): Promise<T> {
        if (method !== 'getTokenAccountsByOwner') return node.request<T>(method, params)
        const programId = (params[1] as { programId: string }).programId
        expect(params[2]).toMatchObject({ encoding: 'base64' })
        const value = Object.entries(node.accounts)
          .filter(([, a]) => a.owner === programId && a.data && a.data.length >= 165 && parseTokenAccountState(a.data)?.owner === OWNER.address)
          .map(([pubkey, a]) => ({ pubkey, account: { owner: a.owner, lamports: Number(a.lamports ?? 0n), data: [base64.encode(a.data as Uint8Array), 'base64'] } }))
        return { context: { slot: 1 }, value } as T
      },
    }
    const list = await approvals(new SolanaClient(wrapped), OWNER.address)
    expect(list.map((a) => a.account).sort()).toEqual([ata(MINT, TOKEN_PROGRAM_ID), ata(T22_MINT, TOKEN_2022_PROGRAM_ID), ata(NATIVE_MINT, TOKEN_PROGRAM_ID)].sort())
    expect((await approvals(new SolanaClient(wrapped), OWNER.address, { all: true })).length).toBe(4)

    const publicNode = createMockNode({ errors: { getTokenAccountsByOwner: { code: -32601, message: 'Method not found' } } })
    await expect(approvals(new SolanaClient(publicNode), OWNER.address)).rejects.toThrow(/pass the mints in `mints`/)
    await expect(approvals(client, 'nope')).rejects.toThrow(/Invalid owner/)
  })

  it('getApprovals：节点参数与 getBalances 相同', async () => {
    const { node, ata } = setup()
    const list = await getApprovals(OWNER.address, { provider: node, mints: [MINT] })
    expect(list.map((a) => a.account)).toEqual([ata(MINT, TOKEN_PROGRAM_ID)])
  })
})

describe('buildRevokes / buildCloses', () => {
  it('Revoke（标签 5）；CloseAccount（9）租金退给 owner 或 destination，有暂存手续费时先 HarvestWithheldTokensToMint（26, 4）', async () => {
    const { client, ata } = setup()
    const list = await approvals(client, OWNER.address, { mints: [MINT, T22_MINT, NATIVE_MINT] })
    const [revoke] = buildRevokes(list)
    expect(revoke?.kind).toBe('revoke')
    expect(revoke?.instructions).toEqual([
      {
        programId: TOKEN_PROGRAM_ID,
        keys: [
          { pubkey: ata(MINT, TOKEN_PROGRAM_ID), isSigner: false, isWritable: true },
          { pubkey: OWNER.address, isSigner: true, isWritable: false },
        ],
        data: new Uint8Array([5]),
      },
    ])
    const closes = buildCloses(list, { destination: OTHER })
    expect(closes.map((c) => c.account)).toEqual([ata(T22_MINT, TOKEN_2022_PROGRAM_ID), ata(NATIVE_MINT, TOKEN_PROGRAM_ID)])
    const [harvest, close] = closes[0]?.instructions ?? []
    expect(harvest).toEqual({
      programId: TOKEN_2022_PROGRAM_ID,
      keys: [
        { pubkey: T22_MINT, isSigner: false, isWritable: true },
        { pubkey: ata(T22_MINT, TOKEN_2022_PROGRAM_ID), isSigner: false, isWritable: true },
      ],
      data: new Uint8Array([26, 4]),
    })
    expect(close?.data).toEqual(new Uint8Array([9]))
    expect(close?.keys.map((k) => k.pubkey)).toEqual([ata(T22_MINT, TOKEN_2022_PROGRAM_ID), OTHER, OWNER.address])
    expect(closes[1]?.instructions.map((ix) => ix.data[0])).toEqual([9])
    expect(buildCloses(list)[1]?.instructions[0]?.keys[1]?.pubkey).toBe(OWNER.address)
    expect(() => buildCloses(list, { destination: 'bad' })).toThrow(/Invalid destination/)
  })
})

describe('revokeApprovals / closeTokenAccounts', () => {
  it('发送：多个账户打包进一笔交易，撤销后 delegate 清空，关闭后租金退回 owner', async () => {
    const chain = createFakeSolana({
      programs: {
        // 假节点没有实现 Revoke：清掉 delegate
        [TOKEN_PROGRAM_ID]: (ix, state) => {
          if (ix.data[0] !== 5) throw new Error('unsupported')
          const account = state[ix.keys[0] as string] as MockAccount
          const p = parseTokenAccountState(account.data as Uint8Array)
          if (!p || !ix.signers[1] || p.owner !== ix.keys[1]) throw new Error('owner does not match')
          account.data = accountData(p.mint, p.owner, { amount: p.amount })
        },
      },
    })
    const mintB = keypair(43).address
    chain.addMint(MINT, 6)
    chain.addMint(mintB, 6)
    chain.setSol(OWNER.address, 1_000_000_000n)
    const ataA = chain.setToken(OWNER.address, MINT, 5n)
    const ataB = chain.setToken(OWNER.address, mintB, 7n)
    for (const a of [ataA, ataB]) {
      const p = parseTokenAccountState(chain.accounts[a]?.data as Uint8Array)
      ;(chain.accounts[a] as MockAccount).data = accountData(p?.mint as string, OWNER.address, { amount: p?.amount, delegate: SPENDER, delegatedAmount: 5n })
    }
    const emptyMint = keypair(44).address
    chain.addMint(emptyMint, 6)
    const ataEmpty = chain.setToken(OWNER.address, emptyMint, 0n)
    const client = new SolanaClient(chain.transport)
    const fast = { pollInterval: 1, timeout: 5_000, priorityFee: 0 }

    const list = await approvals(client, OWNER.address, { mints: [MINT, mintB, emptyMint] })
    const revoked = await revokeApprovals(client, OWNER.secretKey, list, fast)
    expect(revoked.map((r) => [r.kind, r.account, r.status])).toEqual([
      ['revoke', ataA, 'confirmed'],
      ['revoke', ataB, 'confirmed'],
    ])
    expect(revoked[0]?.signature).toBe(revoked[1]?.signature) // 同一笔交易
    expect((await approvals(client, OWNER.address, { mints: [MINT, mintB] })).length).toBe(0)

    const before = chain.sol(OWNER.address)
    const closed = await closeTokenAccounts(client, OWNER.secretKey, list, fast)
    expect(closed.map((r) => [r.kind, r.account, r.status])).toEqual([['close', ataEmpty, 'confirmed']])
    expect(chain.accounts[ataEmpty]).toBeUndefined()
    expect(chain.sol(OWNER.address)).toBe(before + 2_039_280n - 5000n)

    // 不是 owner 签名：报错，不发送
    await expect(revokeApprovals(client, keypair(9).secretKey, list, fast)).rejects.toThrow(/belongs to/)
    expect(await revokeApprovals(client, OWNER.secretKey, [], fast)).toEqual([])
  })
})
