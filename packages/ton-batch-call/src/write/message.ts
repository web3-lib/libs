/**
 * TON 消息：StateInit、内部消息（钱包发出的）、外部消息（发给钱包的）、文本备注、Jetton 转账（TEP-74）。
 * 布局与 @ton/core 的 storeMessageRelaxed / storeMessage 相同（什么时候放进引用的规则也一样）
 */
import type { TonAddress } from '../address.js'
import { Builder, Cell, beginCell } from './cell.js'

export interface StateInit {
  code: Cell
  data: Cell
}

export function stateInitCell(init: StateInit): Cell {
  return beginCell().store(storeStateInit(init)).endCell()
}

function storeStateInit(init: StateInit) {
  // split_depth、special 都没有；library 为空字典
  return (b: Builder) => b.storeBit(0).storeBit(0).storeMaybeRef(init.code).storeMaybeRef(init.data).storeBit(0)
}

/** 合约地址：StateInit 的哈希 */
export function contractAddress(workchain: number, init: StateInit): TonAddress {
  return { workchain, hash: stateInitCell(init).hash(), bounceable: null, testOnly: null }
}

/** 钱包发出的一条内部消息 */
export interface OutMessage {
  to: string | TonAddress
  /** nanoTON */
  value: bigint
  /** 目标出错时退回（发给合约 true，发给钱包、尤其是没部署的钱包 false） */
  bounce: boolean
  body?: Cell | null
  /** 部署合约：{ code, data } 或编码好的 StateInit Cell */
  init?: StateInit | Cell | null
}

/** MessageRelaxed（int_msg_info，src 为 addr_none，由合约填） */
export function storeOutMessage(m: OutMessage) {
  return (b: Builder) => {
    b.storeBit(0) // int_msg_info$0
      .storeBit(1) // ihr_disabled
      .storeBit(m.bounce)
      .storeBit(0) // bounced
      .storeAddress(null)
      .storeAddress(m.to)
      .storeCoins(m.value)
      .storeBit(0) // 没有其他币种
      .storeCoins(0) // ihr_fee
      .storeCoins(0) // fwd_fee
      .storeUint(0, 64) // created_lt
      .storeUint(0, 32) // created_at
    const body = m.body ?? Cell.EMPTY
    if (m.init) {
      b.storeBit(1)
      const init = m.init instanceof Cell ? m.init.asBuilder() : beginCell().store(storeStateInit(m.init))
      if (b.availableBits - 2 >= init.bits) b.storeBit(0).storeBuilder(init)
      else b.storeBit(1).storeRef(init)
    } else b.storeBit(0)
    if (b.availableBits - 1 >= body.bits && b.refs + body.refs.length <= 4) b.storeBit(0).storeBuilder(body.asBuilder())
    else b.storeBit(1).storeRef(body)
  }
}

export function outMessageCell(m: OutMessage): Cell {
  return beginCell().store(storeOutMessage(m)).endCell()
}

/** 发给钱包合约的外部消息（ext_in_msg_info，import_fee 为 0） */
export function externalMessageCell(to: string | TonAddress, body: Cell, init: StateInit | null = null): Cell {
  const b = beginCell().storeUint(2, 2).storeAddress(null).storeAddress(to).storeCoins(0)
  if (init) {
    b.storeBit(1)
    const initBuilder = beginCell().store(storeStateInit(init))
    if (b.availableBits - 2 < initBuilder.bits + body.bits) b.storeBit(1).storeRef(initBuilder)
    else b.storeBit(0).storeBuilder(initBuilder)
  } else b.storeBit(0)
  if (b.availableBits - 1 < body.bits || b.refs + body.refs.length > 4) b.storeBit(1).storeRef(body)
  else b.storeBit(0).storeBuilder(body.asBuilder())
  return b.endCell()
}

/**
 * 外部消息的规范化哈希（TEP-467）：src 为 addr_none、import_fee 为 0、不带 StateInit、body 放进引用。
 * 钱包或中间服务改了外部消息的外层时它也不变，用它查交易
 */
export function normalizedMessageHash(external: Cell): Uint8Array {
  const s = external.beginParse()
  if (s.loadUintNumber(2) !== 2) throw new Error('Not an external-in message')
  s.loadAddress() // src
  const dest = s.loadAddress()
  if (!dest) throw new Error('External message has no destination')
  s.loadCoins()
  if (s.loadBit()) {
    // StateInit：内联或引用，跳过
    if (s.loadBit()) s.loadRef()
    else skipStateInit(s)
  }
  const body = s.loadBit() ? s.loadRef() : beginCell().storeSlice(s).endCell()
  return beginCell().storeUint(2, 2).storeAddress(null).storeAddress(dest).storeCoins(0).storeBit(0).storeBit(1).storeRef(body).endCell().hash()
}

function skipStateInit(s: ReturnType<Cell['beginParse']>): void {
  if (s.loadBit()) s.loadUint(5) // split_depth
  if (s.loadBit()) s.loadUint(2) // special
  s.loadMaybeRef() // code
  s.loadMaybeRef() // data
  s.loadMaybeRef() // library
}

/** 字节串写成 snake 格式：放不下的部分接在引用里（与 @ton/core 的 storeStringTail 相同） */
function storeSnake(b: Builder, bytes: Uint8Array): void {
  const room = Math.floor(b.availableBits / 8)
  if (bytes.length <= room) {
    b.storeBytes(bytes)
    return
  }
  b.storeBytes(bytes.subarray(0, room))
  const tail = beginCell()
  storeSnake(tail, bytes.subarray(room))
  b.storeRef(tail)
}

/** 文本备注：op 0 + UTF-8 文本 */
export function commentCell(text: string): Cell {
  const b = beginCell().storeUint(0, 32)
  storeSnake(b, new TextEncoder().encode(text))
  return b.endCell()
}

export const JETTON_TRANSFER_OP = 0x0f8a7ea5

export interface JettonTransfer {
  queryId?: bigint
  amount: bigint
  /** 收款人（钱包地址，不是它的 Jetton 钱包） */
  destination: string | TonAddress
  /** 多余的 TON 退回哪里 */
  responseDestination: string | TonAddress | null
  /** 给收款人的通知附带的 TON（> 0 时收款人收到 transfer_notification） */
  forwardTonAmount?: bigint
  /** 通知里带的内容（如 commentCell(...)） */
  forwardPayload?: Cell | null
}

/** Jetton 转账（发给发送者自己的 Jetton 钱包） */
export function jettonTransferBody(t: JettonTransfer): Cell {
  const b = beginCell()
    .storeUint(JETTON_TRANSFER_OP, 32)
    .storeUint(t.queryId ?? 0n, 64)
    .storeCoins(t.amount)
    .storeAddress(t.destination)
    .storeAddress(t.responseDestination)
    .storeBit(0) // custom_payload
    .storeCoins(t.forwardTonAmount ?? 0n)
  // forward_payload：Either Cell ^Cell，有内容时放进引用
  if (t.forwardPayload) b.storeBit(1).storeRef(t.forwardPayload)
  else b.storeBit(0)
  return b.endCell()
}
