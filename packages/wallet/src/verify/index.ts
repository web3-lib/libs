/**
 * 后端验证钱包登录（子路径 `@w3lib/wallet/verify`）：解析 `@w3lib/wallet/auth` 的登录消息，核对域名 / nonce / 时间，按链验签：
 * - evm：personal_sign（secp256k1 恢复地址）；合约钱包（EIP-1271）交给 verifyContract
 * - solana：ed25519
 * - sui：signPersonalMessage（ed25519 / secp256k1 / secp256r1；zkLogin、多签不支持）
 * - tron：signMessageV2（secp256k1 恢复地址）
 * - ton：TON Connect signData 的 text 格式（ed25519），钱包公钥由 tonPublicKey 提供（如调用钱包合约的 get_public_key）
 *
 * 依赖 @noble/curves、@noble/hashes，只在这个子路径里用到
 */
import { ed25519 } from '@noble/curves/ed25519.js'
import { p256 } from '@noble/curves/nist.js'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { blake2b } from '@noble/hashes/blake2.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { keccak_256 } from '@noble/hashes/sha3.js'

import { parseSignInMessage, type SignInMessage, type SignInProof } from '../auth/index.js'
import type { Namespace } from '../core/types.js'

export interface VerifyOptions {
  /** 期望的域名（与登录消息的 domain 一致才通过；TON 还要和钱包签名里的域名一致） */
  domain: string
  /**
   * 期望的 nonce（必填）：后端发给这次登录、还没用过的随机串；也可以传函数自己检查。
   * 验证通过后要把它作废（传函数时在函数里作废，如从数据库删除），否则同一份签名可以重复登录
   */
  nonce: string | ((nonce: string) => boolean | Promise<boolean>)
  /** 期望的链（EVM 是数字 chainId，其他链是网络名，如 'mainnet'）；传了就要求消息里的 Chain ID 一致。用 verifyContract 时必填 */
  chainId?: string | number
  /** 当前时间，默认 new Date() */
  now?: Date
  /** Issued At 最多是多久之前（毫秒），默认 10 分钟；有 Expiration Time 时两个限制都要满足 */
  maxAge?: number
  /** 允许的时钟误差（毫秒），默认 60 秒 */
  clockSkew?: number
  /**
   * EVM 合约钱包（Safe、智能账户等，EIP-1271）：恢复出的地址不是登录地址时调用（需要连节点，由应用实现），要同时传 chainId。
   * 实现时要确认 address 上有合约代码，并且 isValidSignature(hash, signature) 的返回值正好是 0x1626ba7e——
   * 对普通账户的 eth_call 也会“成功”（返回空数据），只看调用成没成功会让任何人都能登录
   */
  verifyContract?: (input: { address: string; chainId: string; hash: string; signature: string }) => Promise<boolean>
  /**
   * TON：钱包的 ed25519 公钥（32 字节十六进制）。签名只能用公钥验证，公钥要从链上读（钱包合约的 get_public_key，
   * 没部署的钱包从 stateInit 里取），由应用实现
   */
  tonPublicKey?: (address: string) => Promise<string | Uint8Array>
}

/** address：规范化的地址（EVM 是 EIP-55 校验和格式，TON 是原始格式 0:…，其他链同消息里的），用它作为账户的键 */
export type VerifyResult = { ok: true; message: SignInMessage; address: string } | { ok: false; error: string; message?: SignInMessage }

/**
 * 验证登录：消息格式、链、地址、域名、nonce、时间、签名都对才通过。不会抛错，失败时返回原因
 *
 * ```ts
 * const r = await verifySignIn(proof, { domain: 'example.com', nonce: session.nonce })
 * if (!r.ok) return res.status(401).send(r.error)
 * login(r.message.address)
 * ```
 */
export async function verifySignIn(proof: SignInProof, options: VerifyOptions): Promise<VerifyResult> {
  let message: SignInMessage
  try {
    message = parseSignInMessage(proof.message)
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
  const fail = (error: string): VerifyResult => ({ ok: false, error, message })
  if (message.namespace !== proof.namespace) return fail(`message is for ${message.namespace}, proof is for ${proof.namespace}`)
  if (message.address !== proof.address) return fail('address in the message does not match the proof')
  if (message.domain !== options.domain) return fail(`domain mismatch: ${message.domain}`)
  if (options.chainId !== undefined && String(options.chainId) !== message.chainId) return fail(`chain mismatch: ${message.chainId}`)
  if (options.verifyContract && message.namespace === 'evm' && options.chainId === undefined) return fail('chainId is required when verifyContract is used')
  const time = checkTime(message, options)
  if (time) return fail(time)
  let address: string
  try {
    const valid = await verifySignature(proof, message, options)
    if (valid !== true) return fail(valid === false ? 'invalid signature' : valid)
    address = canonicalAddress(message)
  } catch (err) {
    return fail(`invalid signature: ${err instanceof Error ? err.message : String(err)}`)
  }
  // nonce 放在签名之后：验证通过才会作废（传函数时），伪造的签名不会消耗掉别人的 nonce
  try {
    const ok = typeof options.nonce === 'string' ? options.nonce === message.nonce : await options.nonce(message.nonce)
    if (!ok) return fail('nonce mismatch')
  } catch (err) {
    return fail(`nonce check failed: ${err instanceof Error ? err.message : String(err)}`)
  }
  return { ok: true, message, address }
}

/** 账户的键：EVM 用 EIP-55，TON 用原始格式 */
function canonicalAddress(m: SignInMessage): string {
  if (m.namespace === 'evm') return checksum(m.address)
  if (m.namespace === 'ton') {
    const t = tonAddress(m.address) as { workchain: number; hash: Uint8Array }
    return `${t.workchain}:${hex(t.hash)}`
  }
  if (m.namespace === 'sui') return normalizeSui(m.address)
  return m.address
}

function checksum(address: string): string {
  const lower = address.slice(2).toLowerCase()
  const hash = hex(keccak_256(utf8(lower)))
  return `0x${[...lower].map((c, i) => (parseInt(hash[i] as string, 16) >= 8 ? c.toUpperCase() : c)).join('')}`
}

function checkTime(m: SignInMessage, options: VerifyOptions): string | null {
  const now = (options.now ?? new Date()).getTime()
  if (!Number.isFinite(now)) return 'invalid options.now'
  const skew = options.clockSkew ?? 60_000
  const at = (s: string | undefined) => (s === undefined ? undefined : Date.parse(s))
  const issued = at(m.issuedAt)
  const expires = at(m.expirationTime)
  const notBefore = at(m.notBefore)
  if (issued === undefined || Number.isNaN(issued) || Number.isNaN(expires ?? 0) || Number.isNaN(notBefore ?? 0)) return 'invalid timestamp'
  if (issued > now + skew) return 'issued in the future'
  if (now - issued > (options.maxAge ?? 10 * 60_000) || (expires !== undefined && now - skew > expires)) return 'message expired'
  if (notBefore !== undefined && now + skew < notBefore) return 'message not yet valid'
  return null
}

/** true：通过；false：签名不对；字符串：其他原因 */
async function verifySignature(proof: SignInProof, m: SignInMessage, options: VerifyOptions): Promise<boolean | string> {
  const text = utf8(proof.message)
  switch (proof.namespace as Namespace) {
    case 'evm': {
      const hash = keccak_256(concat(utf8(`\x19Ethereum Signed Message:\n${text.length}`), text))
      const sig = hexBytes(proof.signature)
      // 恢复不出地址（长度不对、恢复字节是 31 / 32 等合约钱包的格式、r 不在曲线上）时交给 verifyContract
      let recovered: string | null = null
      try {
        recovered = sig.length === 65 ? evmAddress(recover(sig, hash)) : null
      } catch {
        recovered = null
      }
      if (recovered && recovered === m.address.toLowerCase()) return true
      if (!options.verifyContract) return false
      return options.verifyContract({ address: m.address, chainId: m.chainId.toString(), hash: `0x${hex(hash)}`, signature: proof.signature })
    }
    case 'tron': {
      const hash = keccak_256(concat(utf8(`\x19TRON Signed Message:\n${text.length}`), text))
      const sig = hexBytes(proof.signature)
      if (sig.length !== 65) return false
      const evm = evmAddress(recover(sig, hash))
      const decoded = base58check(m.address)
      return !!decoded && decoded.length === 21 && decoded[0] === 0x41 && hex(decoded.slice(1)) === evm.slice(2)
    }
    case 'solana': {
      const pubkey = base58Decode(m.address)
      const sig = base58Decode(proof.signature)
      if (pubkey?.length !== 32 || sig?.length !== 64) return false
      return ed25519.verify(sig, text, pubkey, { zip215: false })
    }
    case 'sui':
      return verifySui(proof.signature, text, m.address)
    case 'ton':
      return verifyTon(proof, text, m, options)
    default:
      return `unsupported namespace: ${String(proof.namespace)}`
  }
}

function recover(sig: Uint8Array, hash: Uint8Array): Uint8Array {
  const v = sig[64] as number
  const recovery = v >= 27 ? v - 27 : v
  if (recovery !== 0 && recovery !== 1) throw new Error('bad recovery byte')
  const signature = secp256k1.Signature.fromBytes(sig.slice(0, 64), 'compact')
  // 拒绝 high-S（同一个签名的另一种写法）：签名被拿来做去重键时不会被绕过
  if (signature.hasHighS()) throw new Error('high-S signature')
  return signature.addRecoveryBit(recovery).recoverPublicKey(hash).toBytes(false)
}

/** 未压缩公钥（65 字节）→ 小写 0x 地址 */
const evmAddress = (pubkey: Uint8Array) => `0x${hex(keccak_256(pubkey.slice(1)).slice(12))}`

const SUI_SCHEMES: Record<number, { pk: number; verify: (sig: Uint8Array, digest: Uint8Array, pk: Uint8Array) => boolean }> = {
  0: { pk: 32, verify: (sig, digest, pk) => ed25519.verify(sig, digest, pk, { zip215: false }) },
  // secp256k1 / secp256r1：对 digest 做 sha256 后验签（noble 的 prehash 默认就是 sha256）
  1: { pk: 33, verify: (sig, digest, pk) => secp256k1.verify(sig, digest, pk) },
  2: { pk: 33, verify: (sig, digest, pk) => p256.verify(sig, digest, pk) },
}

/** Sui 个人消息：blake2b256([3, 0, 0] ‖ BCS vector<u8>)；地址 = blake2b256(flag ‖ 公钥) */
function verifySui(signature: string, text: Uint8Array, address: string): boolean | string {
  const bytes = base64Decode(signature)
  const flag = bytes[0] as number
  const scheme = SUI_SCHEMES[flag]
  if (!scheme) return flag === 5 ? 'zkLogin signatures are not supported' : flag === 3 ? 'multisig signatures are not supported' : `unknown signature scheme ${flag}`
  if (bytes.length !== 1 + 64 + scheme.pk) return false
  const sig = bytes.slice(1, 65)
  const pk = bytes.slice(65)
  const digest = blake2b(concat(Uint8Array.from([3, 0, 0]), uleb128(text.length), text), { dkLen: 32 })
  const derived = `0x${hex(blake2b(concat(Uint8Array.from([flag]), pk), { dkLen: 32 }))}`
  if (derived !== normalizeSui(address)) return false
  return scheme.verify(sig, digest, pk)
}

const normalizeSui = (a: string) => `0x${a.replace(/^0x/i, '').toLowerCase().padStart(64, '0')}`

/** TON Connect signData（text）：sha256(0xffff ‖ "ton-connect/sign-data/" ‖ workchain ‖ hash ‖ len ‖ domain ‖ timestamp ‖ "txt" ‖ len ‖ text) */
async function verifyTon(proof: SignInProof, text: Uint8Array, m: SignInMessage, options: VerifyOptions): Promise<boolean | string> {
  const t = proof.ton
  if (!t) return 'ton proof needs the signData result (address, timestamp, domain)'
  if (!options.tonPublicKey) return 'tonPublicKey is required to verify TON signatures'
  if (t.domain !== options.domain) return `signed domain mismatch: ${t.domain}`
  // 钱包签名时的时间（与官方示例后端一样核对新鲜度）
  const now = (options.now ?? new Date()).getTime()
  const skew = options.clockSkew ?? 60_000
  if (t.timestamp * 1000 > now + skew || now - t.timestamp * 1000 > (options.maxAge ?? 10 * 60_000)) return 'signed timestamp is too old or in the future'
  const raw = /^(-?\d+):([0-9a-fA-F]{64})$/.exec(t.address)
  const friendly = tonAddress(m.address)
  if (!friendly) return 'invalid TON address (checksum)'
  if (friendly.testOnly !== undefined && friendly.testOnly !== (m.chainId === 'testnet')) return `TON address network flag does not match chain ${m.chainId}`
  if (!raw || Number(raw[1]) !== friendly.workchain || (raw[2] as string).toLowerCase() !== hex(friendly.hash)) return 'signed address does not match the login address'
  const workchain = new Uint8Array(4)
  new DataView(workchain.buffer).setInt32(0, Number(raw[1]))
  const domain = utf8(t.domain)
  const timestamp = new Uint8Array(8)
  new DataView(timestamp.buffer).setBigUint64(0, BigInt(t.timestamp))
  const payload = concat(Uint8Array.from([0xff, 0xff]), utf8('ton-connect/sign-data/'), workchain, hexBytes(raw[2] as string), u32(domain.length), domain, timestamp, utf8('txt'), u32(text.length), text)
  const key = await options.tonPublicKey(t.address)
  return ed25519.verify(base64Decode(proof.signature), sha256(payload), typeof key === 'string' ? hexBytes(key) : key, { zip215: false })
}

/** user-friendly 地址（48 个 base64 / base64url 字符，校验 CRC16）→ workchain + hash + 测试网标记；也接受原始格式 */
function tonAddress(address: string): { workchain: number; hash: Uint8Array; testOnly?: boolean } | null {
  const raw = /^(-?\d+):([0-9a-fA-F]{64})$/.exec(address)
  if (raw) return { workchain: Number(raw[1]), hash: hexBytes(raw[2] as string) }
  if (address.length !== 48) return null
  const bytes = base64Decode(address.replace(/-/g, '+').replace(/_/g, '/'))
  if (bytes.length !== 36) return null
  const crc = crc16(bytes.slice(0, 34))
  if (bytes[34] !== crc >> 8 || bytes[35] !== (crc & 0xff)) return null
  const flag = bytes[0] as number
  if ((flag & 0x3f) !== 0x11) return null // 0x11 可弹回 / 0x51 不可弹回，0x80 是测试网标记
  return { workchain: bytes[1] === 0xff ? -1 : (bytes[1] as number), hash: bytes.slice(2, 34), testOnly: (flag & 0x80) !== 0 }
}

/** CRC16-XMODEM（TON 地址的校验） */
function crc16(data: Uint8Array): number {
  let crc = 0
  for (const byte of data) {
    crc ^= byte << 8
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff
  }
  return crc
}

// ---- 编码 ----

const utf8 = (s: string) => new TextEncoder().encode(s)
const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('')

function hexBytes(s: string): Uint8Array {
  const h = s.replace(/^0x/i, '')
  if (h.length % 2 || /[^0-9a-f]/i.test(h)) throw new Error('invalid hex')
  return Uint8Array.from(h.match(/../g) ?? [], (x) => parseInt(x, 16))
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}

function u32(n: number): Uint8Array {
  const b = new Uint8Array(4)
  new DataView(b.buffer).setUint32(0, n)
  return b
}

function uleb128(n: number): Uint8Array {
  const out: number[] = []
  do {
    let byte = n & 0x7f
    n >>>= 7
    if (n) byte |= 0x80
    out.push(byte)
  } while (n)
  return Uint8Array.from(out)
}

function base64Decode(s: string): Uint8Array {
  const bin = atob(s)
  return Uint8Array.from(bin, (c) => c.charCodeAt(0))
}

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

function base58Decode(s: string): Uint8Array | null {
  let n = 0n
  for (const c of s) {
    const i = B58.indexOf(c)
    if (i < 0) return null
    n = n * 58n + BigInt(i)
  }
  const bytes: number[] = []
  while (n > 0n) {
    bytes.unshift(Number(n & 0xffn))
    n >>= 8n
  }
  for (const c of s) {
    if (c !== '1') break
    bytes.unshift(0)
  }
  return Uint8Array.from(bytes)
}

/** base58check（Tron 地址）：去掉 4 字节校验，校验不对时为 null */
function base58check(s: string): Uint8Array | null {
  const bytes = base58Decode(s)
  if (!bytes || bytes.length < 5) return null
  const body = bytes.slice(0, -4)
  const check = sha256(sha256(body)).slice(0, 4)
  return check.every((b, i) => b === bytes[bytes.length - 4 + i]) ? body : null
}
