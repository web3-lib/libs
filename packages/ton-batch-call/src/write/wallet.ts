/**
 * TON 钱包合约 v4r2 / v5r1（W5）：地址、部署用的 StateInit、签名的外部消息体。
 * 编码与 @ton/ton 的 WalletContractV4 / WalletContractV5R1 相同
 */
import { parseTonAddress, type TonAddress } from '../address.js'
import type { TonNetwork } from '../constants.js'
import { Builder, Cell, beginCell } from './cell.js'
import { contractAddress, outMessageCell, type OutMessage, type StateInit } from './message.js'

export type WalletVersion = 'v4r2' | 'v5r1'

const CODE_BOC: Record<WalletVersion, string> = {
  v4r2: 'te6ccgECFAEAAtQAART/APSkE/S88sgLAQIBIAIDAgFIBAUE+PKDCNcYINMf0x/THwL4I7vyZO1E0NMf0x/T//QE0VFDuvKhUVG68qIF+QFUEGT5EPKj+AAkpMjLH1JAyx9SMMv/UhD0AMntVPgPAdMHIcAAn2xRkyDXSpbTB9QC+wDoMOAhwAHjACHAAuMAAcADkTDjDQOkyMsfEssfy/8QERITAubQAdDTAyFxsJJfBOAi10nBIJJfBOAC0x8hghBwbHVnvSKCEGRzdHK9sJJfBeAD+kAwIPpEAcjKB8v/ydDtRNCBAUDXIfQEMFyBAQj0Cm+hMbOSXwfgBdM/yCWCEHBsdWe6kjgw4w0DghBkc3RyupJfBuMNBgcCASAICQB4AfoA9AQw+CdvIjBQCqEhvvLgUIIQcGx1Z4MesXCAGFAEywUmzxZY+gIZ9ADLaRfLH1Jgyz8gyYBA+wAGAIpQBIEBCPRZMO1E0IEBQNcgyAHPFvQAye1UAXKwjiOCEGRzdHKDHrFwgBhQBcsFUAPPFiP6AhPLassfyz/JgED7AJJfA+ICASAKCwBZvSQrb2omhAgKBrkPoCGEcNQICEekk30pkQzmkD6f+YN4EoAbeBAUiYcVnzGEAgFYDA0AEbjJftRNDXCx+AA9sp37UTQgQFA1yH0BDACyMoHy//J0AGBAQj0Cm+hMYAIBIA4PABmtznaiaEAga5Drhf/AABmvHfaiaEAQa5DrhY/AAG7SB/oA1NQi+QAFyMoHFcv/ydB3dIAYyMsFywIizxZQBfoCFMtrEszMyXP7AMhAFIEBCPRR8qcCAHCBAQjXGPoA0z/IVCBHgQEI9FHyp4IQbm90ZXB0gBjIywXLAlAGzxZQBPoCFMtqEssfyz/Jc/sAAgBsgQEI1xj6ANM/MFIkgQEI9Fnyp4IQZHN0cnB0gBjIywXLAlAFzxZQA/oCE8tqyx8Syz/Jc/sAAAr0AMntVA==',
  v5r1: 'te6cckECFAEAAoEAART/APSkE/S88sgLAQIBIAINAgFIAwQC3NAg10nBIJFbj2Mg1wsfIIIQZXh0br0hghBzaW50vbCSXwPgghBleHRuuo60gCDXIQHQdNch+kAw+kT4KPpEMFi9kVvg7UTQgQFB1yH0BYMH9A5voTGRMOGAQNchcH/bPOAxINdJgQKAuZEw4HDiEA8CASAFDAIBIAYJAgFuBwgAGa3OdqJoQCDrkOuF/8AAGa8d9qJoQBDrkOuFj8ACAUgKCwAXsyX7UTQcdch1wsfgABGyYvtRNDXCgCAAGb5fD2omhAgKDrkPoCwBAvIOAR4g1wsfghBzaWduuvLgin8PAeaO8O2i7fshgwjXIgKDCNcjIIAg1yHTH9Mf0x/tRNDSANMfINMf0//XCgAK+QFAzPkQmiiUXwrbMeHywIffArNQB7Dy0IRRJbry4IVQNrry4Ib4I7vy0IgikvgA3gGkf8jKAMsfAc8Wye1UIJL4D95w2zzYEAP27aLt+wL0BCFukmwhjkwCIdc5MHCUIccAs44tAdcoIHYeQ2wg10nACPLgkyDXSsAC8uCTINcdBscSwgBSMLDy0InXTNc5MAGk6GwShAe78uCT10rAAPLgk+1V4tIAAcAAkVvg69csCBQgkXCWAdcsCBwS4lIQseMPINdKERITAJYB+kAB+kT4KPpEMFi68uCR7UTQgQFB1xj0BQSdf8jKAEAEgwf0U/Lgi44UA4MH9Fvy4Iwi1woAIW4Bs7Dy0JDiyFADzxYS9ADJ7VQAcjDXLAgkji0h8uCS0gDtRNDSAFETuvLQj1RQMJExnAGBAUDXIdcKAPLgjuLIygBYzxbJ7VST8sCN4gAQk1vbMeHXTNC01sNe',
}

const codes = new Map<WalletVersion, Cell>()
export function walletCode(version: WalletVersion): Cell {
  let code = codes.get(version)
  if (!code) {
    code = Cell.fromBase64(CODE_BOC[version])
    codes.set(version, code)
  }
  return code
}

/** 一笔交易最多几条消息 */
export const MAX_MESSAGES: Record<WalletVersion, number> = { v4r2: 4, v5r1: 255 }

/** 网络的 global_id：W5 的 wallet_id 里要用 */
const GLOBAL_ID: Record<TonNetwork, number> = { mainnet: -239, testnet: -3 }

/**
 * 默认的 wallet_id（subwallet 0、工作链 0）：
 * - v4r2：698983191 + 工作链
 * - v5r1：global_id XOR 上下文（1 位客户端标志、8 位工作链、8 位版本 0、15 位 subwallet）
 */
export function defaultWalletId(version: WalletVersion, network: TonNetwork, workchain = 0): number {
  if (version === 'v4r2') return 698983191 + workchain
  const context = (1 << 31) | ((workchain & 0xff) << 23)
  return (GLOBAL_ID[network] ^ context) >>> 0
}

export function walletData(version: WalletVersion, publicKey: Uint8Array, walletId: number): Cell {
  const b = beginCell()
  if (version === 'v5r1') b.storeBit(1) // 允许签名
  b.storeUint(0, 32) // seqno
  b.storeUint(walletId >>> 0, 32)
  b.storeBytes(publicKey)
  b.storeBit(0) // 插件 / 扩展为空
  return b.endCell()
}

export function walletInit(version: WalletVersion, publicKey: Uint8Array, walletId: number): StateInit {
  return { code: walletCode(version), data: walletData(version, publicKey, walletId) }
}

export function walletAddress(version: WalletVersion, publicKey: Uint8Array, walletId: number, workchain = 0): TonAddress {
  return contractAddress(workchain, walletInit(version, publicKey, walletId))
}

export interface WalletTransfer {
  walletId: number
  seqno: number
  /** 过期时间（unix 秒） */
  validUntil: number
  messages: ReadonlyArray<{ message: OutMessage; mode: number }>
}

const V5_SIGNED_EXTERNAL = 0x7369676e
const ACTION_SEND_MSG = 0x0ec3c86d
/** 发送模式：+2 忽略错误（W5 的外部消息必须带） */
export const IGNORE_ERRORS = 2

/** 要签名的部分（对它的哈希签名） */
export function signingMessage(version: WalletVersion, t: WalletTransfer): Builder {
  if (t.messages.length > MAX_MESSAGES[version]) throw new Error(`A ${version} wallet sends at most ${MAX_MESSAGES[version]} messages per transaction`)
  if (version === 'v4r2') {
    const b = beginCell().storeUint(t.walletId >>> 0, 32).storeUint(t.validUntil, 32).storeUint(t.seqno, 32).storeUint(0, 8)
    for (const m of t.messages) b.storeUint(m.mode, 8).storeRef(outMessageCell(m.message))
    return b
  }
  // W5：动作列表是链表（每个动作引用前一个），外部消息的发送模式都要带 +2
  const list = t.messages.reduce(
    (prev, m) => beginCell().storeRef(prev).storeUint(ACTION_SEND_MSG, 32).storeUint(m.mode | IGNORE_ERRORS, 8).storeRef(outMessageCell(m.message)).endCell(),
    Cell.EMPTY,
  )
  return beginCell()
    .storeUint(V5_SIGNED_EXTERNAL, 32)
    .storeUint(t.walletId >>> 0, 32)
    .storeUint(t.validUntil, 32)
    .storeUint(t.seqno, 32)
    .storeMaybeRef(t.messages.length ? list : null)
    .storeBit(0) // 没有扩展动作
}

/** 签名后的外部消息体：v4 签名在前，W5 签名在后 */
export async function signedBody(version: WalletVersion, t: WalletTransfer, sign: (hash: Uint8Array) => Promise<Uint8Array>): Promise<Cell> {
  const message = signingMessage(version, t)
  const signature = await sign(message.endCell().hash())
  if (signature.length !== 64) throw new Error('Invalid signature: expected 64 bytes')
  return version === 'v4r2' ? beginCell().storeBytes(signature).storeBuilder(message).endCell() : beginCell().storeBuilder(message).storeBytes(signature).endCell()
}

/** 地址的工作链和哈希 */
export function addressOf(value: string | TonAddress): TonAddress {
  const a = typeof value === 'string' ? parseTonAddress(value) : value
  if (!a) throw new Error(`Invalid TON address: ${String(value)}`)
  return a
}
