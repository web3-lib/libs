/** Jetton 风险检查：钱包代码的哈希、admin / mintable / 诈骗标记、风险标记（假的 toncenter，不连网络） */
import { describe, expect, it } from 'vitest'

import { TonClient, toFriendlyAddress, toRawAddress, type TonTransport } from '../src/index.js'
import { GOVERNED_JETTON_WALLET_CODES, KNOWN_JETTON_WALLET_CODES, codeHashOf, tokenRisks } from '../src/subpaths/risk.js'
import { Cell, beginCell, bytesToBase64, bytesToHex } from '../src/write/cell.js'

const a = (n: number) => `0:${n.toString(16).padStart(64, 'd')}`
const [RENOUNCED, OWNED, SCAM, ODD, MISSING, ZERO, GOVERNED] = [a(1), a(2), a(3), a(4), a(5), a(6), a(7)]
const ADMIN = a(9)

/** 只有一个库 Cell 的 BOC：exotic 类型 2 + 被引用代码的哈希 */
function libraryBoc(hash: Uint8Array): string {
  const cell = [0x08, 66, 2, ...hash]
  return bytesToBase64(Uint8Array.from([0xb5, 0xee, 0x9c, 0x72, 0x01, 0x01, 1, 1, 0, cell.length, 0, ...cell]))
}

const ordinaryCode = beginCell().storeUint(0xdeadbeef, 32).storeRef(beginCell().storeUint(1, 8)).endCell()
const libraryHash = Uint8Array.from({ length: 32 }, (_, i) => i)
const STANDARD = Object.keys(KNOWN_JETTON_WALLET_CODES)[0] as string
const STABLECOIN = [...GOVERNED_JETTON_WALLET_CODES][0] as string
const lib = (hex: string) => libraryBoc(Uint8Array.from(hex.match(/../g) as string[], (h) => parseInt(h, 16)))

describe('codeHashOf', () => {
  it('普通 Cell 是表示哈希；库 Cell 是它引用的代码的哈希；读不出为 null', () => {
    expect(codeHashOf(ordinaryCode.toBase64())).toBe(bytesToHex(ordinaryCode.hash()))
    expect(codeHashOf(libraryBoc(libraryHash))).toBe(bytesToHex(libraryHash))
    expect(codeHashOf('not a boc')).toBeNull()
  })
})

function fakeNode() {
  const addr = (x: string | null) => (x ? beginCell().storeAddress(x).endCell() : beginCell().storeUint(0, 2).endCell())
  const data: Record<string, [bigint, bigint, string | null, string]> = {
    // 已放弃 admin、不能增发、认识的钱包代码（库 Cell）
    [RENOUNCED]: [10n ** 18n, 0n, null, lib(STANDARD)],
    // 有 admin、可以增发
    [OWNED]: [10n ** 15n, -1n, ADMIN, lib(STANDARD)],
    // 诈骗标记
    [SCAM]: [1n, 0n, null, lib(STANDARD)],
    // 不认识的钱包代码
    [ODD]: [1n, 0n, null, ordinaryCode.toBase64()],
    // admin 改成了零地址：算放弃
    [ZERO]: [1n, -1n, `0:${'0'.repeat(64)}`, lib(STANDARD)],
    // 带治理的钱包代码（USD₮）且有 admin
    [GOVERNED]: [1n, -1n, ADMIN, lib(STABLECOIN)],
  }
  const transport: TonTransport = {
    async get(path, query) {
      expect(path).toBe('jetton/masters')
      const list = (query.address as string[]).filter((x) => x !== MISSING)
      return {
        jetton_masters: list.map((x) => ({ address: x, jetton_content: { decimals: '9' } })),
        metadata: Object.fromEntries(list.map((x) => [x.toUpperCase(), { is_indexed: true, token_info: [{ valid: true, type: 'jetton_masters', name: `Token ${x.slice(-1)}`, symbol: x === SCAM ? 'USDT' : 'TKN', is_scam: x === SCAM, extra: { decimals: '9' } }] }])),
      } as never
    },
    async post(path, body) {
      const { address, method } = body as { address: string; method: string }
      expect([path, method]).toEqual(['runGetMethod', 'get_jetton_data'])
      const d = data[toRawAddress(address)]
      if (!d) return { exit_code: -13, stack: [] } as never
      const num = (v: bigint) => ({ type: 'num', value: v < 0n ? `-0x${(-v).toString(16)}` : `0x${v.toString(16)}` })
      return { exit_code: 0, stack: [num(d[0]), num(d[1]), { type: 'cell', value: addr(d[2]).toBase64() }, { type: 'cell', value: Cell.EMPTY.toBase64() }, { type: 'cell', value: d[3] }] } as never
    },
  }
  return new TonClient(transport)
}

describe('tokenRisks', () => {
  it('admin、mintable 读链上的 get_jetton_data，诈骗标记读索引器；钱包代码不认识时标记 unknown-wallet-code', async () => {
    const ton = fakeNode()
    const list = await tokenRisks(ton, [RENOUNCED, toFriendlyAddress(OWNED), SCAM, ODD, MISSING, 'TON', 'junk', ZERO, GOVERNED])
    expect(list.map((r) => [r.token, r.flags])).toEqual([
      [RENOUNCED, []],
      [toFriendlyAddress(OWNED), ['mintable', 'admin']],
      [SCAM, ['scam']],
      [ODD, ['unknown-wallet-code']],
      [MISSING, ['not-found']],
      ['TON', []],
      ['junk', []],
      [ZERO, []],
      [GOVERNED, ['mintable', 'admin', 'governed']],
    ])
    expect(list[7]).toMatchObject({ admin: null, mintable: true })
    expect(list[8]?.walletCode).toBe('stablecoin')
    expect(list[0]).toMatchObject({ address: toFriendlyAddress(RENOUNCED), admin: null, mintable: false, totalSupply: (10n ** 18n).toString(), walletCodeHash: STANDARD, walletCode: KNOWN_JETTON_WALLET_CODES[STANDARD], trade: null })
    expect(list[1]).toMatchObject({ admin: toFriendlyAddress(ADMIN), mintable: true })
    expect(list[2]).toMatchObject({ isScam: true, symbol: 'USDT' })
    expect(list[3]).toMatchObject({ walletCodeHash: bytesToHex(ordinaryCode.hash()), walletCode: null })
    expect(list[4]).toMatchObject({ error: 'not-found', walletCodeHash: null })
    expect(list[5]?.error).toBe('invalid-address')
    // 自己认可的钱包代码
    const [odd] = await tokenRisks(ton, [ODD], { knownWalletCodes: { [bytesToHex(ordinaryCode.hash())]: 'my jetton' } })
    expect(odd).toMatchObject({ walletCode: 'my jetton', flags: [] })
  })
})
