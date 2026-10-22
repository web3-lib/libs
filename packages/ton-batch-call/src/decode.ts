/**
 * 消息体解码（`/simulate` 用）：Jetton 转账 / 销毁、NFT 转账、STON.fi v1 / v2 和 DeDust 的兑换与流动性、
 * 钱包 v4r2 / v5r1 的外部消息（以及里面的内部消息），TVM / 钱包 / Jetton 的退出码 → 可读的错误。
 * 消息格式与 @ston-fi/sdk 2.7 / @dedust/sdk 0.8 相同（见 `/swap`、`/liquidity`）
 */
import { toFriendlyAddress } from './address.js'
import { Cell, Slice, beginCell } from './write/cell.js'

export type DecodedType = 'transfer' | 'swap' | 'liquidity' | 'approve' | 'contract' | 'unknown'

export interface DecodedMessage {
  /** 消息体开头的 op（0x 加 8 位十六进制）；没有消息体或不足 32 位时为 null */
  opcode: string | null
  /** 如 'jetton_transfer'、'stonfi_v2_swap'、'comment'、'empty' */
  name: string
  type: DecodedType
  /** 如 'STON.fi v2'、'DeDust' */
  protocol?: string
  /** 一句话说明（数量是最小单位，没有精度） */
  summary: string
  /** 解出的字段（地址为用户友好格式，数量为最小单位的十进制字符串） */
  args: Record<string, unknown>
  /** 认识这个 op */
  known: boolean
}

const OP = {
  comment: 0,
  jettonTransfer: 0x0f8a7ea5,
  jettonInternalTransfer: 0x178d4519,
  transferNotification: 0x7362d09c,
  burn: 0x595f07bc,
  burnNotification: 0x7bdd97de,
  excess: 0xd53276db,
  nftTransfer: 0x5fcc3d14,
  ownershipAssigned: 0x05138d91,
  stonfiV2Swap: 0x6664de2a,
  stonfiV2CrossSwap: 0x69cf1a5b,
  stonfiV1Swap: 0x25938561,
  stonfiProvideLp: 0x37c096df,
  ptonTransfer: 0x01f3835d,
  dedustSwapNative: 0xea06185d,
  dedustSwapJetton: 0xe3a0d482,
  dedustDepositNative: 0xd55e4686,
  dedustDepositJetton: 0x40e108d6,
  dedustPayoutFromPool: 0xad4eb6f5,
  dedustPayout: 0x474f86cf,
  w5Signed: 0x7369676e,
  w5Internal: 0x73696e74,
  w5Extension: 0x6578746e,
  w5SendMsg: 0x0ec3c86d,
} as const

/** 认识的 op（没有单独解码的只给名字） */
const NAMES: Record<number, { name: string; protocol?: string }> = {
  [OP.jettonInternalTransfer]: { name: 'jetton_internal_transfer' },
  [OP.transferNotification]: { name: 'jetton_transfer_notification' },
  [OP.burnNotification]: { name: 'jetton_burn_notification' },
  [OP.excess]: { name: 'excess' },
  [OP.ownershipAssigned]: { name: 'nft_ownership_assigned' },
  [OP.dedustPayoutFromPool]: { name: 'dedust_payout_from_pool', protocol: 'DeDust' },
  [OP.dedustPayout]: { name: 'dedust_payout', protocol: 'DeDust' },
  [OP.w5Internal]: { name: 'w5_internal_signed' },
  [OP.w5Extension]: { name: 'w5_extension_action' },
}

const hex8 = (op: number) => `0x${op.toString(16).padStart(8, '0')}`
const fr = (a: { workchain: number; hash: Uint8Array } | null) => (a ? toFriendlyAddress(a as never) : null)
const str = (v: bigint) => v.toString()

/** snake 格式的文本（本 Cell 剩下的字节 + 引用里的后续） */
function loadText(s: Slice): string {
  const bytes: number[] = []
  let cur: Slice | null = s
  for (let depth = 0; cur && depth < 16; depth++) {
    bytes.push(...cur.loadBytes(Math.floor(cur.remainingBits / 8)))
    cur = cur.remainingRefs ? cur.loadRef().beginParse() : null
  }
  return new TextDecoder().decode(Uint8Array.from(bytes))
}

/** Either Cell ^Cell：剩下的位放进新 Cell，或取引用 */
function loadEither(s: Slice): Cell {
  return s.loadBit() ? s.loadRef() : beginCell().storeSlice(s).endCell()
}

function skipAsset(s: Slice): void {
  if (s.loadUintNumber(4) !== 0) {
    s.loadInt(8)
    s.loadUint(256)
  }
}

/** 载荷里还有内容（不是空 Cell） */
const hasContent = (c: Cell) => c.bits > 0 || c.refs.length > 0

/** 文本备注（op 0）；其他 op 返回 null */
function commentOf(body: Cell): string | null {
  if (body.bits < 32) return null
  const s = body.beginParse()
  if (s.loadUintNumber(32) !== 0) return null
  try {
    return loadText(s)
  } catch {
    return null
  }
}

/** 解码一条消息体（Cell 或 BOC 的 base64）；不认识的 op 返回 known: false */
export function decodeMessage(body: Cell | string | null | undefined): DecodedMessage {
  let cell: Cell
  try {
    cell = body == null || body === '' ? Cell.EMPTY : typeof body === 'string' ? Cell.fromBase64(body) : body
  } catch {
    return { opcode: null, name: 'invalid', type: 'unknown', summary: 'Invalid message body (not a BOC)', args: {}, known: false }
  }
  if (!hasContent(cell)) return { opcode: null, name: 'empty', type: 'transfer', summary: 'Plain TON transfer', args: {}, known: true }
  if (cell.bits < 32) return { opcode: null, name: 'unknown', type: 'unknown', summary: 'Message body without an op', args: {}, known: false }
  const s = cell.beginParse()
  const op = s.loadUintNumber(32)
  const opcode = hex8(op)
  try {
    return decodeOp(op, opcode, s, cell)
  } catch {
    // 字段不全（或格式特殊）：只给 op
    const named = NAMES[op]
    return { opcode, name: named?.name ?? 'unknown', type: 'unknown', ...(named?.protocol ? { protocol: named.protocol } : {}), summary: `Message ${named?.name ?? opcode} (could not read its fields)`, args: {}, known: named !== undefined }
  }
}

function decodeOp(op: number, opcode: string, s: Slice, cell: Cell): DecodedMessage {
  const mk = (name: string, type: DecodedType, summary: string, args: Record<string, unknown> = {}, protocol?: string): DecodedMessage => ({ opcode, name, type, ...(protocol ? { protocol } : {}), summary, args, known: true })
  switch (op) {
    case OP.comment: {
      const text = loadText(s)
      return mk('comment', 'transfer', `TON transfer with comment ${JSON.stringify(text)}`, { comment: text })
    }
    case OP.jettonTransfer: {
      s.loadUint(64)
      const amount = s.loadCoins()
      const destination = fr(s.loadAddress())
      const response = fr(s.loadAddress())
      if (s.loadBit()) s.loadRef() // custom_payload
      const forwardTon = s.loadCoins()
      const payload = loadEither(s)
      const args: Record<string, unknown> = { amount: str(amount), destination, responseDestination: response, forwardTonAmount: str(forwardTon) }
      const inner = hasContent(payload) ? decodeMessage(payload) : null
      const comment = inner?.name === 'comment' ? (inner.args.comment as string) : null
      if (comment !== null) args.comment = comment
      // 转给 DEX 的 router / 池子，载荷里是兑换 / 存入：按载荷的类型
      if (inner && (inner.type === 'swap' || inner.type === 'liquidity')) {
        return mk('jetton_transfer', inner.type, `Jetton transfer carrying ${inner.summary}`, { ...args, payload: inner }, inner.protocol)
      }
      if (inner && comment === null) args.payload = inner
      return mk('jetton_transfer', 'transfer', `Jetton transfer of ${amount} units to ${destination}${comment ? ` (comment ${JSON.stringify(comment)})` : ''}`, args)
    }
    case OP.burn: {
      s.loadUint(64)
      const amount = s.loadCoins()
      const response = fr(s.loadAddress())
      return mk('jetton_burn', 'contract', `Burn ${amount} jetton units (burning LP tokens removes liquidity)`, { amount: str(amount), responseDestination: response })
    }
    case OP.nftTransfer: {
      s.loadUint(64)
      const newOwner = fr(s.loadAddress())
      const response = fr(s.loadAddress())
      return mk('nft_transfer', 'transfer', `NFT transfer to ${newOwner}`, { newOwner, responseDestination: response })
    }
    case OP.ptonTransfer: {
      // STON.fi v2：TON 先转成 pTON，载荷（兑换 / 存入）在 forward 里
      s.loadUint(64)
      const amount = s.loadCoins()
      const refund = fr(s.loadAddress())
      const payload = s.loadMaybeRef()
      const inner = payload ? decodeMessage(payload) : null
      const args: Record<string, unknown> = { amount: str(amount), refundAddress: refund, ...(inner ? { payload: inner } : {}) }
      if (inner && (inner.type === 'swap' || inner.type === 'liquidity')) return mk('pton_transfer', inner.type, `${amount} nanoTON via pTON: ${inner.summary}`, args, 'STON.fi v2')
      return mk('pton_transfer', 'contract', `pTON transfer of ${amount} nanoTON`, args, 'STON.fi v2')
    }
    case OP.stonfiV2Swap:
    case OP.stonfiV2CrossSwap: {
      const askWallet = fr(s.loadAddress())
      const refund = fr(s.loadAddress())
      s.loadAddress() // excesses
      const deadline = s.loadUint(64)
      const r = s.loadRef().beginParse()
      const minOut = r.loadCoins()
      const receiver = fr(r.loadAddress())
      return mk(op === OP.stonfiV2Swap ? 'stonfi_v2_swap' : 'stonfi_v2_cross_swap', 'swap', `swap on STON.fi v2 (min out ${minOut}, receiver ${receiver})`, { askJettonWallet: askWallet, refundAddress: refund, deadline: Number(deadline), minOut: str(minOut), receiver }, 'STON.fi v2')
    }
    case OP.stonfiV1Swap: {
      const askWallet = fr(s.loadAddress())
      const minOut = s.loadCoins()
      const receiver = fr(s.loadAddress())
      return mk('stonfi_v1_swap', 'swap', `swap on STON.fi v1 (min out ${minOut}, receiver ${receiver})`, { askJettonWallet: askWallet, minOut: str(minOut), receiver }, 'STON.fi v1')
    }
    case OP.stonfiProvideLp: {
      const otherWallet = fr(s.loadAddress())
      s.loadAddress()
      s.loadAddress()
      const deadline = s.loadUint(64)
      const r = s.loadRef().beginParse()
      const minLp = r.loadCoins()
      const receiver = fr(r.loadAddress())
      return mk('stonfi_v2_provide_lp', 'liquidity', `add liquidity on STON.fi v2 (min LP ${minLp}, receiver ${receiver})`, { otherRouterWallet: otherWallet, deadline: Number(deadline), minLpOut: str(minLp), receiver }, 'STON.fi v2')
    }
    case OP.dedustSwapNative:
    case OP.dedustSwapJetton: {
      if (op === OP.dedustSwapNative) {
        s.loadUint(64)
        s.loadCoins() // 卖出的 TON
      }
      const pool = fr(s.loadAddress())
      s.loadBit() // kind
      const limit = s.loadCoins()
      const next = s.loadMaybeRef()
      const params = s.loadRef().beginParse()
      const deadline = params.loadUint(32)
      const receiver = fr(params.loadAddress())
      return mk(op === OP.dedustSwapNative ? 'dedust_swap_native' : 'dedust_swap_jetton', 'swap', `swap on DeDust (pool ${pool}, min out ${limit}${next ? ', 2 hops' : ''}, receiver ${receiver})`, { pool, minOut: str(limit), hops: next ? 2 : 1, deadline: Number(deadline), receiver }, 'DeDust')
    }
    case OP.dedustDepositNative:
    case OP.dedustDepositJetton: {
      if (op === OP.dedustDepositNative) {
        s.loadUint(64)
        s.loadCoins()
      }
      const stable = s.loadBit()
      skipAsset(s)
      skipAsset(s)
      const [minLp, target0, target1] =
        op === OP.dedustDepositNative
          ? (() => {
              const r = s.loadRef().beginParse()
              return [r.loadCoins(), r.loadCoins(), r.loadCoins()]
            })()
          : [s.loadCoins(), s.loadCoins(), s.loadCoins()]
      return mk(op === OP.dedustDepositNative ? 'dedust_deposit_native' : 'dedust_deposit_jetton', 'liquidity', `add liquidity on DeDust (${stable ? 'stable' : 'volatile'} pool, min LP ${minLp})`, { stable, minLpOut: str(minLp), target0: str(target0), target1: str(target1) }, 'DeDust')
    }
    default: {
      const named = NAMES[op]
      if (named) return mk(named.name, 'contract', `Message ${named.name}`, {}, named.protocol)
      return { opcode, name: 'unknown', type: 'unknown', summary: `Unknown message (op ${opcode})`, args: { bodyBits: cell.bits }, known: false }
    }
  }
}

/** 一条内部消息（钱包发出的、或 BOC 里的） */
export interface ParsedInternalMessage {
  to: string
  /** nanoTON */
  value: bigint
  bounce: boolean
  /** StateInit：没有 / 在引用里（Cell）/ 内联（不支持转成 Cell） */
  init: Cell | null | 'inline'
  body: Cell
}

/** 解析 MessageRelaxed / Message（int_msg_info） */
export function parseInternalMessage(cell: Cell): ParsedInternalMessage {
  const s = cell.beginParse()
  if (s.loadBit()) throw new Error('Not an internal message')
  s.loadBit() // ihr_disabled
  const bounce = s.loadBit()
  s.loadBit() // bounced
  s.loadAddress() // src
  const dest = s.loadAddress()
  if (!dest) throw new Error('Internal message has no destination')
  const value = s.loadCoins()
  if (s.loadBit()) s.loadRef() // 其他币种
  s.loadCoins()
  s.loadCoins()
  s.loadUint(64)
  s.loadUint(32)
  let init: ParsedInternalMessage['init'] = null
  if (s.loadBit()) init = s.loadBit() ? s.loadRef() : 'inline'
  return { to: toFriendlyAddress(dest), value, bounce, init, body: loadEither(s) }
}

export type WalletKind = 'v4r2' | 'v5r1'

export interface DecodedExternal {
  /** 钱包（用户友好格式） */
  wallet: string
  version: WalletKind
  walletId: number
  validUntil: number
  seqno: number
  /** 带了 StateInit（部署钱包） */
  deploy: boolean
  /** 钱包要发出的消息（v4r2 最多 4 条，v5r1 最多 255 条）；mode 是发送模式，decoded 是消息体的解码 */
  messages: Array<{ to: string; value: string; bounce: boolean; mode: number; init: boolean; decoded: DecodedMessage }>
  /** 不是发送消息的操作（v4r2 的插件操作、v5r1 的扩展动作） */
  otherActions: string[]
}

/** 解码发给钱包 v4r2 / v5r1 的外部消息（BOC 的 base64 或 Cell）；其他钱包版本、格式不对时抛错 */
export function decodeExternalMessage(boc: Cell | string): DecodedExternal {
  const root = typeof boc === 'string' ? Cell.fromBase64(boc) : boc
  const s = root.beginParse()
  if (s.loadUintNumber(2) !== 2) throw new Error('Not an external-in message')
  s.loadAddress()
  const dest = s.loadAddress()
  if (!dest) throw new Error('External message has no destination')
  s.loadCoins()
  const deploy = s.loadBit()
  if (deploy) {
    if (s.loadBit()) s.loadRef()
    else {
      // 内联的 StateInit：split_depth、special、code、data、library
      if (s.loadBit()) s.loadUint(5)
      if (s.loadBit()) s.loadUint(2)
      s.loadMaybeRef()
      s.loadMaybeRef()
      s.loadMaybeRef()
    }
  }
  const body = loadEither(s).beginParse()
  const wallet = toFriendlyAddress(dest)
  const messages: DecodedExternal['messages'] = []
  const otherActions: string[] = []
  const add = (mode: number, msg: Cell) => {
    const m = parseInternalMessage(msg)
    messages.push({ to: m.to, value: m.value.toString(), bounce: m.bounce, mode, init: m.init !== null, decoded: decodeMessage(m.body) })
  }
  if (body.clone().loadUintNumber(32) === OP.w5Signed) {
    body.loadUint(32)
    const walletId = body.loadUintNumber(32)
    const validUntil = body.loadUintNumber(32)
    const seqno = body.loadUintNumber(32)
    const list = body.loadMaybeRef()
    // 动作链表：每个动作引用前一个（最后一个动作在最外层），要倒过来才是发送顺序
    const actions: Slice[] = []
    for (let cur = list, n = 0; cur && cur.bits > 0 && n < 256; n++) {
      const a = cur.beginParse()
      const prev = a.loadRef()
      actions.push(a)
      cur = prev
    }
    for (const a of actions.reverse()) {
      if (a.loadUintNumber(32) === OP.w5SendMsg) {
        const mode = a.loadUintNumber(8)
        add(mode, a.loadRef())
      } else otherActions.push('set_code')
    }
    if (body.remainingBits > 512 && body.loadBit()) otherActions.push('extended_actions')
    return { wallet, version: 'v5r1', walletId, validUntil, seqno, deploy, messages, otherActions }
  }
  // v4r2：512 位签名、wallet_id、valid_until、seqno、op（0 = 发送消息），之后每条消息一个 mode + 引用
  if (body.remainingBits < 512 + 104) throw new Error('Unsupported wallet message (only wallet v4r2 / v5r1 are decoded)')
  body.loadBytes(64)
  const walletId = body.loadUintNumber(32)
  const validUntil = body.loadUintNumber(32)
  const seqno = body.loadUintNumber(32)
  const op = body.loadUintNumber(8)
  if (op !== 0) otherActions.push(op === 1 ? 'deploy_and_install_plugin' : op === 2 ? 'install_plugin' : op === 3 ? 'remove_plugin' : `op_${op}`)
  else while (body.remainingRefs > 0 && body.remainingBits >= 8) add(body.loadUintNumber(8), body.loadRef())
  return { wallet, version: 'v4r2', walletId, validUntil, seqno, deploy, messages, otherActions }
}

// ---------------------------------------------------------------------------
// 退出码
// ---------------------------------------------------------------------------

const TVM: Record<number, string> = {
  2: 'stack underflow',
  3: 'stack overflow',
  4: 'integer overflow',
  5: 'integer out of range',
  6: 'invalid opcode',
  7: 'type check error',
  8: 'cell overflow',
  9: 'cell underflow (the message body is shorter than the contract expects)',
  10: 'dictionary error',
  11: 'unknown error',
  12: 'fatal error',
  13: 'out of gas (not enough TON attached to pay for execution)',
  [-14]: 'out of gas (not enough TON attached to pay for execution)',
  [-13]: 'out of gas (not enough TON to pay the compute fee)',
}

/** 动作阶段的结果码 */
const ACTION: Record<number, string> = {
  32: 'the action list is invalid',
  33: 'the action list is too long',
  34: 'an action is invalid or not supported',
  35: 'invalid source address in an outgoing message',
  36: 'invalid destination address in an outgoing message (e.g. wrong workchain)',
  37: 'not enough TON to send the outgoing messages',
  38: 'not enough extra currencies',
  40: 'not enough funds to pay the message fees',
  43: 'too many cells in a message or the account state',
}

/** 钱包合约自己的错误码（v4r2；v5r1 另有 132 ~ 140） */
const WALLET: Record<number, string> = {
  33: 'wrong seqno (the wallet has already sent a newer transaction)',
  34: 'wrong wallet id (subwallet / network)',
  35: 'invalid signature or the message has expired',
  36: 'the message has expired',
  132: 'signature authentication is disabled',
  133: 'wrong seqno (the wallet has already sent a newer transaction)',
  134: 'wrong wallet id (subwallet / network)',
  135: 'invalid signature',
  136: 'the message has expired',
  137: 'an external message must use send mode +2 (ignore errors)',
  138: 'invalid message operation',
}

/** 标准 Jetton 钱包（TEP-74 参考实现、USD₮ 的 stablecoin）的错误码 */
const JETTON: Record<number, string> = {
  47: 'not enough jettons in the wallet (stablecoin wallet balance error)',
  48: 'not enough TON attached to pay the jetton transfer fees (stablecoin wallet)',
  73: 'the sender is not the owner of the jetton wallet (stablecoin wallet)',
  705: 'the sender is not the owner of the jetton wallet',
  706: 'not enough jettons in the wallet',
  707: 'the incoming jetton transfer is not from a valid jetton wallet',
  708: 'invalid forward payload / not enough TON to forward',
  709: 'not enough TON attached to pay the jetton transfer fees',
  710: 'burn is not authorized or the burn parameters are invalid',
  0xffff: 'unknown operation (the contract does not handle this message)',
}

export type ExitContext = 'compute' | 'action' | 'wallet' | 'jetton'

/**
 * 退出码 → 可读的说明（如 `exit code 706: not enough jettons in the wallet`）。
 * compute：计算阶段（标准 TVM 码，加上合约的码）；action：动作阶段；wallet：钱包合约；jetton：Jetton 钱包
 */
export function describeExitCode(code: number, context: ExitContext = 'compute'): string {
  const text = (context === 'action' ? ACTION[code] : undefined) ?? (context === 'wallet' ? WALLET[code] : undefined) ?? TVM[code] ?? (context !== 'action' ? JETTON[code] : undefined) ?? (code >= 32 && code < 64 ? ACTION[code] : undefined)
  return `${context === 'action' ? 'action result code' : 'exit code'} ${code}${text ? `: ${text}` : ' (contract-specific code)'}`
}

/** 计算阶段跳过的原因 */
export function describeSkipReason(reason: string | undefined): string {
  switch (reason) {
    case 'no_state':
      return 'the account has no code (not deployed), nothing was executed'
    case 'bad_state':
      return 'the StateInit does not match the account address'
    case 'no_gas':
      return 'not enough TON to pay for execution'
    case 'suspended':
      return 'the account is suspended'
    default:
      return reason ? `skipped (${reason})` : 'skipped'
  }
}
