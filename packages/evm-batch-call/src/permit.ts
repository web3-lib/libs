/**
 * 免 gas 授权（子路径 `@w3lib/evm-batch-call/permit`）：EIP-2612 permit（含 DAI 风格）、Permit2（AllowanceTransfer 的 PermitSingle / PermitBatch、
 * SignatureTransfer 的 permitTransferFrom）。构建 EIP-712 数据、用 ethers Signer 签名（私钥 / 浏览器钱包都行）、本地验证签名、生成上链的 calldata。
 *
 * 安全默认：金额精确（无限额度要显式 allowUnlimited）、有效期默认 30 分钟（超过 24 小时要显式 allowLongDeadline）、
 * 签名前核对 owner = 签名者、chainId、verifyingContract（代币本身 / Permit2）、spender 不是零地址
 */
import { Interface, MaxUint256, TypedDataEncoder, getAddress, hexlify, keccak256, randomBytes, toUtf8Bytes, verifyTypedData, Signature, ZeroAddress, type TypedDataDomain, type TypedDataField } from 'ethers'

import type { Provider } from './provider.js'
import type { WriteSigner } from './write/signer.js'

/** Uniswap 的 Permit2（各 EVM 链上地址相同） */
export const PERMIT2_ADDRESS = '0x000000000022D473030F116dDEE9F6B43aC78BA3'
export const MAX_UINT160 = (1n << 160n) - 1n
/** 默认的签名有效期（秒） */
export const DEFAULT_PERMIT_DEADLINE = 1800
/** 有效期超过这个值（秒）要显式 allowLongDeadline */
export const MAX_PERMIT_DEADLINE = 86_400

export type PermitKind = 'eip2612' | 'dai' | 'permit2-single' | 'permit2-batch' | 'permit2-transfer'

export interface TypedData {
  domain: TypedDataDomain
  types: Record<string, TypedDataField[]>
  primaryType: string
  message: Record<string, any>
}

/** 一个待签名的授权：typedData 是要签的内容，其余是它的摘要（签名前核对用） */
export interface Permit {
  kind: PermitKind
  chainId: number
  owner: string
  spender: string
  /** 代币地址（permit2-batch 为每个代币一项） */
  tokens: string[]
  /** 授权 / 转账的数量（最小单位），与 tokens 一一对应（DAI 风格为 '0' / 无限） */
  amounts: string[]
  /** 签名过期时间（unix 秒） */
  deadline: number
  /** permit2-single / batch：额度本身的过期时间（unix 秒） */
  expiration?: number
  /** 签名要用的 nonce（permit2-batch 为每个代币一项） */
  nonces: string[]
  typedData: TypedData
}

export interface SignedPermit {
  permit: Permit
  signature: string
  /** 紧凑的 v / r / s，给 permit() 的参数用 */
  v: number
  r: string
  s: string
}

export interface PermitOptions {
  /** 签名有效期（秒），默认 1800；也可传 deadlineAt（unix 秒） */
  deadline?: number
  deadlineAt?: number
  /** 允许无限额度（MaxUint256 / MaxUint160，DAI 风格的 permit 本身只能授权无限）。默认拒绝 */
  allowUnlimited?: boolean
  /** 允许超过 24 小时的有效期。默认拒绝 */
  allowLongDeadline?: boolean
}

const now = () => Math.floor(Date.now() / 1000)

function resolveDeadline(options: PermitOptions, label = 'deadline'): number {
  const at = options.deadlineAt ?? now() + Math.floor(options.deadline ?? DEFAULT_PERMIT_DEADLINE)
  if (!Number.isSafeInteger(at) || at <= now() + 10) {
    throw new RangeError(`${label} must be at least 10 seconds in the future`)
  }
  if (at > now() + MAX_PERMIT_DEADLINE + 60 && !options.allowLongDeadline) {
    throw new RangeError(`${label} is more than 24 hours away; pass allowLongDeadline: true if that is intended`)
  }
  return at
}

function checkParty(owner: string, spender: string): [string, string] {
  const s = getAddress(spender)
  if (s === ZeroAddress) throw new Error('spender must not be the zero address')
  return [getAddress(owner), s]
}

function checkAmount(amount: bigint, max: bigint, options: PermitOptions, label = 'amount'): void {
  if (amount <= 0n) throw new RangeError(`${label} must be greater than 0 (a blank permit is never signed)`)
  if (amount > max) throw new RangeError(`${label} exceeds the maximum`)
  if (amount === max && !options.allowUnlimited) {
    throw new RangeError(`${label} is unlimited; pass allowUnlimited: true to sign an unlimited permit`)
  }
}

// ---------------------------------------------------------------------------------------------
// EIP-2612 / DAI
// ---------------------------------------------------------------------------------------------

const DAI_TYPEHASH = keccak256(toUtf8Bytes('Permit(address holder,address spender,uint256 nonce,uint256 expiry,bool allowed)'))
const PERMIT_TYPES: Record<string, TypedDataField[]> = {
  Permit: [
    { name: 'owner', type: 'address' },
    { name: 'spender', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
}
const DAI_TYPES: Record<string, TypedDataField[]> = {
  Permit: [
    { name: 'holder', type: 'address' },
    { name: 'spender', type: 'address' },
    { name: 'nonce', type: 'uint256' },
    { name: 'expiry', type: 'uint256' },
    { name: 'allowed', type: 'bool' },
  ],
}

const tokenInterface = new Interface([
  'function name() view returns (string)',
  'function version() view returns (string)',
  'function DOMAIN_SEPARATOR() view returns (bytes32)',
  'function nonces(address owner) view returns (uint256)',
  'function PERMIT_TYPEHASH() view returns (bytes32)',
  'function eip712Domain() view returns (bytes1 fields, string name, string version, uint256 chainId, address verifyingContract, bytes32 salt, uint256[] extensions)',
  'function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)',
  'function permit(address holder, address spender, uint256 nonce, uint256 expiry, bool allowed, uint8 v, bytes32 r, bytes32 s)',
])

export interface PermitSupport {
  /** null：不支持（reason 说明原因） */
  kind: 'eip2612' | 'dai' | null
  /** 支持时：EIP-712 domain（已和代币的 DOMAIN_SEPARATOR 核对一致） */
  domain?: TypedDataDomain
  reason?: string
}

/**
 * 检测代币是否支持 permit：读 nonces / DOMAIN_SEPARATOR / name / version / eip712Domain（EIP-5267），
 * 按链 ID 和代币地址重新算 domain，**和代币的 DOMAIN_SEPARATOR 逐位一致**才算支持（不一致说明 domain 参数猜错或代币的实现特殊，签了也会被拒）。
 * 通过 PERMIT_TYPEHASH 区分 DAI 风格（Permit(holder, spender, nonce, expiry, allowed)）
 */
export async function detectPermit(provider: Provider, token: string): Promise<PermitSupport> {
  const address = getAddress(token)
  const chainId = await provider.getChainId()
  const c = provider.contract(address, tokenInterface)
  const [name, version, separator, nonce, domain5267, typehash] = await provider.tryAll([
    c.name(),
    c.version(),
    c.DOMAIN_SEPARATOR(),
    c.nonces(ZeroAddress),
    c.eip712Domain(),
    c.PERMIT_TYPEHASH(),
  ])
  if (separator === null || nonce === null) {
    return { kind: null, reason: 'the token has no nonces() / DOMAIN_SEPARATOR(), so it does not support permit' }
  }
  const candidates: TypedDataDomain[] = []
  if (domain5267) {
    const d = domain5267 as unknown as { name: string; version: string; chainId: bigint; verifyingContract: string }
    candidates.push({ name: d.name, version: d.version, chainId: d.chainId, verifyingContract: d.verifyingContract })
  }
  if (name !== null) {
    for (const v of [version as string | null, '1', '2']) {
      if (v !== null) candidates.push({ name: name as string, version: v, chainId, verifyingContract: address })
    }
  }
  const match = candidates.find((d) => safeDomainHash(d) === (separator as string).toLowerCase() && Number(d.chainId) === chainId && getAddress(d.verifyingContract as string) === address)
  if (!match) {
    return { kind: null, reason: 'the EIP-712 domain computed from name / version / chainId / address does not match the token DOMAIN_SEPARATOR (non-standard permit)' }
  }
  return { kind: typehash !== null && (typehash as string).toLowerCase() === DAI_TYPEHASH ? 'dai' : 'eip2612', domain: match }
}

function safeDomainHash(d: TypedDataDomain): string | null {
  try {
    return TypedDataEncoder.hashDomain(d).toLowerCase()
  } catch {
    return null
  }
}

export interface BuildPermitParams {
  token: string
  owner: string
  spender: string
  /** 授权的数量（最小单位，精确）。DAI 风格的 permit 只能授权无限额度，要 allowUnlimited: true 才会构建 */
  value: bigint | string | number
}

/**
 * 构建 EIP-2612 permit（代币不支持、domain 对不上时抛错）：读 owner 当前的 nonce，默认有效期 30 分钟、精确额度。
 * 返回要签的数据（`signPermit` 签名）
 */
export async function buildPermit(provider: Provider, params: BuildPermitParams, options: PermitOptions = {}): Promise<Permit> {
  const token = getAddress(params.token)
  const [owner, spender] = checkParty(params.owner, params.spender)
  const value = BigInt(params.value)
  const support = await detectPermit(provider, token)
  if (!support.kind || !support.domain) {
    throw new Error(`${token} does not support permit: ${support.reason}`)
  }
  const chainId = await provider.getChainId()
  const deadline = resolveDeadline(options)
  const [nonce] = await provider.all<bigint>([provider.contract(token, tokenInterface).nonces(owner)])
  if (support.kind === 'dai') {
    if (!options.allowUnlimited) {
      throw new RangeError('DAI-style permit can only approve an unlimited allowance; pass allowUnlimited: true or use a normal approve')
    }
    checkAmount(value, MaxUint256, { allowUnlimited: true })
    const message = { holder: owner, spender, nonce: nonce as bigint, expiry: BigInt(deadline), allowed: true }
    return { kind: 'dai', chainId, owner, spender, tokens: [token], amounts: [MaxUint256.toString()], deadline, nonces: [String(nonce)], typedData: { domain: support.domain, types: DAI_TYPES, primaryType: 'Permit', message } }
  }
  checkAmount(value, MaxUint256, options, 'value')
  const message = { owner, spender, value, nonce: nonce as bigint, deadline: BigInt(deadline) }
  return { kind: 'eip2612', chainId, owner, spender, tokens: [token], amounts: [value.toString()], deadline, nonces: [String(nonce)], typedData: { domain: support.domain, types: PERMIT_TYPES, primaryType: 'Permit', message } }
}

/** 代币上的 permit 调用 calldata（任何人都可以提交，不需要是 owner） */
export function permitCalldata(signed: SignedPermit): string {
  const { permit, v, r, s } = signed
  const m = permit.typedData.message
  if (permit.kind === 'eip2612') {
    return tokenInterface.encodeFunctionData('permit(address,address,uint256,uint256,uint8,bytes32,bytes32)', [m.owner, m.spender, m.value, m.deadline, v, r, s])
  }
  if (permit.kind === 'dai') {
    return tokenInterface.encodeFunctionData('permit(address,address,uint256,uint256,bool,uint8,bytes32,bytes32)', [m.holder, m.spender, m.nonce, m.expiry, m.allowed, v, r, s])
  }
  throw new Error(`${permit.kind} is not a token permit; use permit2Calldata / permitTransferFromCalldata`)
}

// ---------------------------------------------------------------------------------------------
// Permit2
// ---------------------------------------------------------------------------------------------

const permit2Interface = new Interface([
  'function allowance(address owner, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)',
  'function permit(address owner, ((address token, uint160 amount, uint48 expiration, uint48 nonce) details, address spender, uint256 sigDeadline) permitSingle, bytes signature)',
  'function permit(address owner, ((address token, uint160 amount, uint48 expiration, uint48 nonce)[] details, address spender, uint256 sigDeadline) permitBatch, bytes signature)',
  'function permitTransferFrom(((address token, uint256 amount) permitted, uint256 nonce, uint256 deadline) permit, (address to, uint256 requestedAmount) transferDetails, address owner, bytes signature)',
])

const PERMIT_DETAILS = [
  { name: 'token', type: 'address' },
  { name: 'amount', type: 'uint160' },
  { name: 'expiration', type: 'uint48' },
  { name: 'nonce', type: 'uint48' },
]

function permit2Domain(chainId: number): TypedDataDomain {
  return { name: 'Permit2', chainId, verifyingContract: PERMIT2_ADDRESS }
}

export interface Permit2AllowanceParams {
  token: string
  owner: string
  /** 被授权方（路由合约等），在 Permit2 里能 transferFrom 的地址 */
  spender: string
  /** 额度（最小单位，精确，≤ 2^160 − 1） */
  amount: bigint | string | number
  /** 额度的过期时间（unix 秒），默认和签名一样 30 分钟（Permit2 的额度过期后自动失效） */
  expirationAt?: number
}

/** 读 Permit2 里 owner 对 spender 的当前 nonce */
async function allowanceNonce(provider: Provider, owner: string, token: string, spender: string): Promise<bigint> {
  const [a] = await provider.all([provider.contract(PERMIT2_ADDRESS, permit2Interface).allowance(owner, token, spender)])
  return BigInt((a as { nonce: bigint }).nonce)
}

/** 构建 Permit2 AllowanceTransfer 的 PermitSingle（owner 签名后任何人可调 permit2.permit，之后 spender 可通过 Permit2 转走额度内的代币） */
export async function buildPermit2Single(provider: Provider, params: Permit2AllowanceParams, options: PermitOptions = {}): Promise<Permit> {
  return buildPermit2Batch(provider, { owner: params.owner, spender: params.spender, items: [{ token: params.token, amount: params.amount }], expirationAt: params.expirationAt }, options, true)
}

export interface Permit2BatchParams {
  owner: string
  spender: string
  items: ReadonlyArray<{ token: string; amount: bigint | string | number }>
  expirationAt?: number
}

/** 构建 Permit2 的 PermitBatch（多个代币一个签名）；items 只有一个且 single 时为 PermitSingle */
export async function buildPermit2Batch(provider: Provider, params: Permit2BatchParams, options: PermitOptions = {}, single = false): Promise<Permit> {
  const [owner, spender] = checkParty(params.owner, params.spender)
  if (!params.items.length) throw new Error('items must not be empty')
  if (new Set(params.items.map((i) => getAddress(i.token))).size !== params.items.length) throw new Error('duplicate tokens in items')
  const chainId = await provider.getChainId()
  const deadline = resolveDeadline(options, 'sigDeadline')
  const expiration = params.expirationAt ?? deadline
  if (expiration <= now() || expiration > now() + 2 ** 32) throw new RangeError('expirationAt is out of range')
  if (expiration > now() + MAX_PERMIT_DEADLINE + 60 && !options.allowLongDeadline) {
    throw new RangeError('expirationAt is more than 24 hours away; pass allowLongDeadline: true if that is intended')
  }
  const tokens = params.items.map((i) => getAddress(i.token))
  const amounts = params.items.map((i, k) => {
    const amount = BigInt(i.amount)
    checkAmount(amount, MAX_UINT160, options, `items[${k}].amount`)
    return amount
  })
  const nonces = await Promise.all(tokens.map((t) => allowanceNonce(provider, owner, t, spender)))
  const details = tokens.map((token, k) => ({ token, amount: amounts[k] as bigint, expiration, nonce: nonces[k] as bigint }))
  const base = { chainId, owner, spender, tokens, amounts: amounts.map(String), deadline, expiration, nonces: nonces.map(String) }
  if (single) {
    return {
      ...base,
      kind: 'permit2-single',
      typedData: {
        domain: permit2Domain(chainId),
        types: { PermitSingle: [{ name: 'details', type: 'PermitDetails' }, { name: 'spender', type: 'address' }, { name: 'sigDeadline', type: 'uint256' }], PermitDetails: PERMIT_DETAILS },
        primaryType: 'PermitSingle',
        message: { details: details[0], spender, sigDeadline: BigInt(deadline) },
      },
    }
  }
  return {
    ...base,
    kind: 'permit2-batch',
    typedData: {
      domain: permit2Domain(chainId),
      types: { PermitBatch: [{ name: 'details', type: 'PermitDetails[]' }, { name: 'spender', type: 'address' }, { name: 'sigDeadline', type: 'uint256' }], PermitDetails: PERMIT_DETAILS },
      primaryType: 'PermitBatch',
      message: { details, spender, sigDeadline: BigInt(deadline) },
    },
  }
}

export interface Permit2TransferParams {
  token: string
  owner: string
  /** 能调 permitTransferFrom 的合约（只有它能用这个签名） */
  spender: string
  /** 最多转走的数量（最小单位，精确） */
  amount: bigint | string | number
  /** 不传时随机生成（SignatureTransfer 的 nonce 是无序位图，随机数不会冲突） */
  nonce?: bigint
}

/** 构建 Permit2 SignatureTransfer 的 PermitTransferFrom：一次性签名，不留下链上额度（spender 合约在同一笔交易里 permitTransferFrom） */
export async function buildPermit2Transfer(provider: Provider, params: Permit2TransferParams, options: PermitOptions = {}): Promise<Permit> {
  const [owner, spender] = checkParty(params.owner, params.spender)
  const token = getAddress(params.token)
  const amount = BigInt(params.amount)
  checkAmount(amount, MaxUint256, options)
  const chainId = await provider.getChainId()
  const deadline = resolveDeadline(options)
  const nonce = params.nonce ?? BigInt(hexlify(randomBytes(7)))
  return {
    kind: 'permit2-transfer',
    chainId,
    owner,
    spender,
    tokens: [token],
    amounts: [amount.toString()],
    deadline,
    nonces: [nonce.toString()],
    typedData: {
      domain: permit2Domain(chainId),
      types: {
        PermitTransferFrom: [{ name: 'permitted', type: 'TokenPermissions' }, { name: 'spender', type: 'address' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }],
        TokenPermissions: [{ name: 'token', type: 'address' }, { name: 'amount', type: 'uint256' }],
      },
      primaryType: 'PermitTransferFrom',
      message: { permitted: { token, amount }, spender, nonce, deadline: BigInt(deadline) },
    },
  }
}

/** Permit2.permit(owner, permitSingle | permitBatch, signature) 的 calldata */
export function permit2Calldata(signed: SignedPermit): string {
  const { permit, signature } = signed
  if (permit.kind !== 'permit2-single' && permit.kind !== 'permit2-batch') throw new Error(`${permit.kind} is not an AllowanceTransfer permit`)
  const m = permit.typedData.message
  const fn = permit.kind === 'permit2-single' ? 'permit(address,((address,uint160,uint48,uint48),address,uint256),bytes)' : 'permit(address,((address,uint160,uint48,uint48)[],address,uint256),bytes)'
  return permit2Interface.encodeFunctionData(fn, [permit.owner, [permit.kind === 'permit2-single' ? tupleOf(m.details) : m.details.map(tupleOf), m.spender, m.sigDeadline], signature])
}

const tupleOf = (d: { token: string; amount: bigint; expiration: bigint | number; nonce: bigint | number }) => [d.token, d.amount, d.expiration, d.nonce]

/** Permit2.permitTransferFrom 的 calldata：把 owner 的代币转给 to（spender 合约调用） */
export function permitTransferFromCalldata(signed: SignedPermit, to: string, requestedAmount?: bigint): string {
  const { permit, signature } = signed
  if (permit.kind !== 'permit2-transfer') throw new Error(`${permit.kind} is not a SignatureTransfer permit`)
  const m = permit.typedData.message
  const amount = requestedAmount ?? m.permitted.amount
  if (amount > m.permitted.amount) throw new RangeError('requestedAmount exceeds the permitted amount')
  return permit2Interface.encodeFunctionData('permitTransferFrom', [[[m.permitted.token, m.permitted.amount], m.nonce, m.deadline], [getAddress(to), amount], permit.owner, signature])
}

// ---------------------------------------------------------------------------------------------
// 签名 / 验证
// ---------------------------------------------------------------------------------------------

/** 签名前的核对：typedData 里的内容要和 permit 摘要一致（防止被替换）、链 / 合约地址正确、签名者就是 owner */
export function assertPermitSafe(permit: Permit, signerAddress?: string, chainId?: number): void {
  const { typedData: t } = permit
  const expectedContract = permit.kind === 'eip2612' || permit.kind === 'dai' ? permit.tokens[0] : PERMIT2_ADDRESS
  if (Number(t.domain.chainId) !== permit.chainId || (chainId !== undefined && chainId !== permit.chainId)) {
    throw new Error(`The permit is for chain ${String(t.domain.chainId)}, expected ${chainId ?? permit.chainId}`)
  }
  if (getAddress(String(t.domain.verifyingContract)) !== getAddress(expectedContract as string)) {
    throw new Error('The permit verifyingContract does not match the expected contract; refusing to sign')
  }
  if (signerAddress && getAddress(signerAddress) !== getAddress(permit.owner)) {
    throw new Error('The signer is not the owner of the permit')
  }
  const m = t.message
  const same = (a: unknown, b: unknown) => String(a).toLowerCase() === String(b).toLowerCase()
  const spender = m.spender
  if (!same(spender, permit.spender) || getAddress(permit.spender) === ZeroAddress) throw new Error('The permit spender is inconsistent or the zero address; refusing to sign')
  const ownerField = m.owner ?? m.holder
  if (permit.kind !== 'permit2-single' && permit.kind !== 'permit2-batch' && permit.kind !== 'permit2-transfer' && !same(ownerField, permit.owner)) {
    throw new Error('The permit owner is inconsistent; refusing to sign')
  }
  const amounts: unknown[] = permit.kind === 'permit2-single' ? [m.details.amount] : permit.kind === 'permit2-batch' ? m.details.map((d: { amount: bigint }) => d.amount) : permit.kind === 'permit2-transfer' ? [m.permitted.amount] : permit.kind === 'dai' ? [MaxUint256] : [m.value]
  if (amounts.length !== permit.amounts.length || amounts.some((a, i) => !same(a, permit.amounts[i])) || amounts.some((a) => BigInt(a as bigint) === 0n)) {
    throw new Error('The permit amounts are inconsistent or blank; refusing to sign')
  }
  // 代币、nonce、额度过期时间、DAI 的 allowed 也要和摘要一致：否则界面上显示的和钱包里实际签的不是同一个授权
  const details: Array<{ token?: unknown; nonce?: unknown; expiration?: unknown }> =
    permit.kind === 'permit2-single' ? [m.details] : permit.kind === 'permit2-batch' ? m.details : permit.kind === 'permit2-transfer' ? [{ token: m.permitted.token }] : []
  if (details.length) {
    if (details.length !== permit.tokens.length || details.some((d, i) => !same(d.token, permit.tokens[i]))) throw new Error('The permit tokens are inconsistent; refusing to sign')
    if (permit.kind !== 'permit2-transfer' && details.some((d, i) => d.nonce !== undefined && permit.nonces[i] !== undefined && !same(d.nonce, permit.nonces[i]))) throw new Error('The permit nonce is inconsistent; refusing to sign')
    if (permit.expiration !== undefined && details.some((d) => d.expiration !== undefined && !same(d.expiration, permit.expiration))) throw new Error('The permit expiration is inconsistent; refusing to sign')
  } else if (permit.kind === 'dai' ? m.allowed !== true : permit.nonces[0] !== undefined && !same(m.nonce, permit.nonces[0])) {
    throw new Error('The permit nonce or allowed flag is inconsistent; refusing to sign')
  }
  if (permit.kind === 'permit2-transfer' && permit.nonces[0] !== undefined && !same(m.nonce, permit.nonces[0])) throw new Error('The permit nonce is inconsistent; refusing to sign')
  const deadline = m.deadline ?? m.expiry ?? m.sigDeadline
  if (!same(deadline, permit.deadline) || permit.deadline <= now()) throw new Error('The permit deadline is inconsistent or already passed; refusing to sign')
}

/**
 * 签名：signer 是 ethers Signer（Wallet、浏览器钱包的 JsonRpcSigner 等，用 signTypedData）或私钥以外的任何有 signTypedData 的对象。
 * 签名前核对（assertPermitSafe），签完本地验证签名确实来自 owner
 */
export async function signPermit(signer: Pick<WriteSigner, 'getAddress' | 'signTypedData'>, permit: Permit, options: { chainId?: number } = {}): Promise<SignedPermit> {
  if (typeof signer.signTypedData !== 'function') throw new Error('The signer does not support signTypedData')
  assertPermitSafe(permit, await signer.getAddress(), options.chainId)
  const { domain, types, message } = permit.typedData
  const signature = await signer.signTypedData(domain, types, message)
  if (!verifyPermitSignature(permit, signature)) {
    throw new Error('The wallet returned a signature that does not recover to the permit owner')
  }
  const sig = Signature.from(signature)
  return { permit, signature, v: sig.v, r: sig.r, s: sig.s }
}

/** 本地验证签名：恢复出的地址是不是 owner（EOA 签名；合约账户的 ERC-1271 签名无法本地验证，返回 false） */
export function verifyPermitSignature(permit: Permit, signature: string): boolean {
  try {
    return verifyTypedData(permit.typedData.domain, permit.typedData.types, permit.typedData.message, signature).toLowerCase() === permit.owner.toLowerCase()
  } catch {
    return false
  }
}
