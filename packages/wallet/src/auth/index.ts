/**
 * 钱包登录（子路径 `@w3lib/wallet/auth`）：生成 / 解析登录消息（EIP-4361 “Sign-In with Ethereum” 的格式，其他链按 CAIP-122 换掉链名），
 * 用连接的钱包签名。后端验签用 `@w3lib/wallet/verify`。这里不含任何密码学代码，浏览器里只打包消息的拼装和解析
 *
 * ```ts
 * import { signIn } from '@w3lib/wallet/auth'
 *
 * const { nonce } = await fetch('/api/nonce').then((r) => r.json())
 * const proof = await signIn(wallet, 'evm', { domain: location.host, uri: location.origin, nonce, statement: '登录 Example' })
 * await fetch('/api/login', { method: 'POST', body: JSON.stringify(proof) })   // 后端：verifySignIn(proof, { domain, nonce })
 * ```
 */
import { WalletError } from '../core/errors.js'
import type { Namespace } from '../core/types.js'

/** 消息里的链名（“wants you to sign in with your Ethereum account”） */
export const CHAIN_NAMES: Readonly<Record<Namespace, string>> = {
  evm: 'Ethereum',
  solana: 'Solana',
  sui: 'Sui',
  tron: 'Tron',
  ton: 'TON',
}

export interface SignInFields {
  /** 发起登录的网站（host，可以带端口），钱包会显示；后端要核对 */
  domain: string
  address: string
  /** 给用户看的一句话（不能换行） */
  statement?: string
  /** 登录的资源地址，如 location.origin */
  uri: string
  /** 固定为 '1' */
  version?: '1'
  /** EVM 是数字 chainId；其他链是网络名，如 'mainnet' */
  chainId: string | number
  /** 后端生成的随机串（至少 8 位字母数字），一次性使用，防止重放 */
  nonce: string
  /** ISO 8601 时间，默认现在 */
  issuedAt?: string
  expirationTime?: string
  notBefore?: string
  requestId?: string
  resources?: readonly string[]
}

export interface SignInMessage extends SignInFields {
  namespace: Namespace
  version: '1'
  issuedAt: string
}

const NONCE = /^[A-Za-z0-9]{8,}$/

/** 生成一个随机 nonce（16 位字母数字，crypto.getRandomValues）；生产环境建议由后端生成并记住 */
export function createNonce(length = 16): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  const bytes = crypto.getRandomValues(new Uint8Array(length))
  return [...bytes].map((b) => alphabet[b % alphabet.length]).join('')
}

/**
 * 按 EIP-4361 的格式拼出登录消息（其他链把 “Ethereum” 换成链名，见 CHAIN_NAMES）。
 *
 * ```text
 * example.com wants you to sign in with your Ethereum account:
 * 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045
 *
 * Sign in to Example
 *
 * URI: https://example.com
 * Version: 1
 * Chain ID: 1
 * Nonce: 32891756
 * Issued At: 2026-10-19T08:00:00.000Z
 * ```
 */
export function createSignInMessage(namespace: Namespace, fields: SignInFields): string {
  const m = normalize(namespace, fields)
  const lines = [`${m.domain} wants you to sign in with your ${CHAIN_NAMES[namespace]} account:`, m.address, '']
  // EIP-4361 的语法：没有 statement 时地址和 URI 之间是两个空行（钱包按这个格式识别登录请求、提示域名不符）；
  // 其他链按 Solana 等钱包的写法，只有一个空行
  if (m.statement) lines.push(m.statement, '')
  else if (namespace === 'evm') lines.push('')
  lines.push(`URI: ${m.uri}`, `Version: ${m.version}`, `Chain ID: ${m.chainId}`, `Nonce: ${m.nonce}`, `Issued At: ${m.issuedAt}`)
  if (m.expirationTime) lines.push(`Expiration Time: ${m.expirationTime}`)
  if (m.notBefore) lines.push(`Not Before: ${m.notBefore}`)
  if (m.requestId !== undefined) lines.push(`Request ID: ${m.requestId}`)
  if (m.resources?.length) lines.push('Resources:', ...m.resources.map((r) => `- ${r}`))
  return lines.join('\n')
}

/** 控制字符（含 \r、\n）和 Unicode 的行 / 段分隔符：钱包可能显示成换行，解析时却是同一行 */
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/
/** EIP-4361 的 statement 只能是这些 ASCII 字符（RFC 3986 的 reserved / unreserved 和空格）；中文等会让钱包识别不出登录请求 */
const EVM_STATEMENT = /^[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;= ]*$/
/** RFC 3339 时间 */
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/
/** 各链地址的格式（只检查形状，签名验证时再核对） */
const ADDRESS: Record<Namespace, RegExp> = {
  evm: /^0x[0-9a-fA-F]{40}$/,
  solana: /^[1-9A-HJ-NP-Za-km-z]{32,44}$/,
  sui: /^0x[0-9a-fA-F]{1,64}$/,
  tron: /^T[1-9A-HJ-NP-Za-km-z]{33}$/,
  ton: /^([A-Za-z0-9_\-+/]{48}|-?\d+:[0-9a-fA-F]{64})$/,
}

function normalize(namespace: Namespace, f: SignInFields): SignInMessage {
  if (!CHAIN_NAMES[namespace]) throw new WalletError('unsupported', `Unknown namespace: ${namespace}`)
  const bad = (field: string) => new WalletError('unknown', `Invalid ${field}`)
  const issuedAt = f.issuedAt ?? new Date().toISOString()
  const text = [f.domain, f.address, f.statement, f.uri, String(f.chainId), f.nonce, issuedAt, f.expirationTime, f.notBefore, f.requestId, ...(f.resources ?? [])]
  if (text.some((v) => v !== undefined && CONTROL.test(v))) throw new WalletError('unknown', 'Sign-in fields must not contain line breaks or control characters')
  if (!f.domain || /[\s/]/.test(f.domain)) throw bad(`domain: ${f.domain}`)
  if (!ADDRESS[namespace].test(f.address)) throw bad(`${namespace} address: ${f.address}`)
  if (f.statement !== undefined && (f.statement.startsWith('URI: ') || (namespace === 'evm' && !EVM_STATEMENT.test(f.statement)))) {
    throw bad('statement (EVM statements may only use ASCII letters, digits, spaces and URI punctuation, and must not start with "URI: ")')
  }
  if (!NONCE.test(f.nonce)) throw new WalletError('unknown', 'nonce must be at least 8 alphanumeric characters')
  if (!f.uri || /\s/.test(f.uri)) throw bad('uri')
  if (namespace === 'evm' ? !/^\d+$/.test(String(f.chainId)) : !/^[\w:.-]+$/.test(String(f.chainId))) throw bad(`chainId: ${f.chainId}`)
  for (const [name, value] of [['issuedAt', issuedAt], ['expirationTime', f.expirationTime], ['notBefore', f.notBefore]] as const) {
    if (value !== undefined && !DATE_TIME.test(value)) throw bad(`${name} (RFC 3339): ${value}`)
  }
  if (f.resources?.some((r) => !r || /\s/.test(r))) throw bad('resources')
  return { ...f, namespace, version: '1', chainId: String(f.chainId), issuedAt }
}

const HEADER = /^(\S+) wants you to sign in with your (.+) account:$/
const FIELDS: ReadonlyArray<[string, keyof SignInFields]> = [
  ['URI', 'uri'],
  ['Version', 'version'],
  ['Chain ID', 'chainId'],
  ['Nonce', 'nonce'],
  ['Issued At', 'issuedAt'],
  ['Expiration Time', 'expirationTime'],
  ['Not Before', 'notBefore'],
  ['Request ID', 'requestId'],
]

/** 解析登录消息（createSignInMessage 的逆过程）；格式不对时抛错。chainId 为字符串 */
export function parseSignInMessage(text: string): SignInMessage {
  const lines = text.split('\n')
  const header = HEADER.exec(lines[0] ?? '')
  const namespace = (Object.keys(CHAIN_NAMES) as Namespace[]).find((n) => CHAIN_NAMES[n] === header?.[2])
  if (!header || !namespace) throw new WalletError('unknown', 'Not a sign-in message')
  const address = lines[1] ?? ''
  if (!address || lines[2] !== '') throw new WalletError('unknown', 'Malformed sign-in message: address line')
  let i = 3
  let statement: string | undefined
  if (namespace === 'evm' && lines[i] === '') {
    i += 1 // EIP-4361：没有 statement 时是两个空行
  } else if (lines[i] !== undefined && !lines[i]?.startsWith('URI: ')) {
    statement = lines[i]
    if (lines[i + 1] !== '') throw new WalletError('unknown', 'Malformed sign-in message: statement')
    i += 2
  }
  const out: Record<string, unknown> = { namespace, domain: header[1], address, ...(statement !== undefined ? { statement } : {}) }
  let field = 0
  for (; i < lines.length; i++) {
    const line = lines[i] as string
    if (line === 'Resources:') {
      out.resources = lines.slice(i + 1).map((l) => {
        if (!l.startsWith('- ')) throw new WalletError('unknown', 'Malformed sign-in message: resources')
        return l.slice(2)
      })
      break
    }
    // 字段按固定顺序出现，可选的可以没有
    while (field < FIELDS.length && !line.startsWith(`${(FIELDS[field] as [string, string])[0]}: `)) field++
    const def = FIELDS[field]
    if (!def) throw new WalletError('unknown', `Malformed sign-in message: ${line}`)
    out[def[1]] = line.slice(def[0].length + 2)
    field++
  }
  for (const key of ['uri', 'version', 'chainId', 'nonce', 'issuedAt'] as const) {
    if (out[key] === undefined) throw new WalletError('unknown', `Malformed sign-in message: missing ${key}`)
  }
  if (out.version !== '1') throw new WalletError('unknown', `Unsupported sign-in message version: ${String(out.version)}`)
  const message = out as unknown as SignInMessage
  // 字段要合法，且按这些字段重新拼出的消息与原文逐字节相同（排除各种夹带、换行和空白上的歧义）
  if (createSignInMessage(namespace, message) !== text) throw new WalletError('unknown', 'Malformed sign-in message: not in canonical form')
  return message
}

/** 签名结果：原样发给后端验签 */
export interface SignInProof {
  namespace: Namespace
  /** 签名的登录消息（文本） */
  message: string
  /** 钱包返回的签名：evm / tron 0x 十六进制，solana base58，sui / ton base64 */
  signature: string
  address: string
  /** ton：TON Connect signData 返回的签名地址（原始格式 0:…）、时间戳和域名，验签要用 */
  ton?: { address: string; timestamp: number; domain: string }
}

/** createWallet 返回的对象里用到的部分 */
interface WalletLike {
  getConnection(namespace?: Namespace): { address: string; chainId: string | number | null; provider: unknown } | null
  signMessage(message: string, namespace?: Namespace): Promise<string>
}

/**
 * 用已连接的钱包签名登录消息。chainId 不传时用连接的链（EVM 是当前链；其他链默认 'mainnet'）。
 * TON 用 TON Connect 的 signData（text），钱包会在签名里加上时间戳和域名，结果的 ton 字段带上它们
 */
export async function signIn(wallet: WalletLike, namespace: Namespace, fields: Omit<SignInFields, 'address' | 'chainId'> & { chainId?: string | number }): Promise<SignInProof> {
  const connection = wallet.getConnection(namespace)
  if (!connection) throw new WalletError('unknown', `No ${namespace} wallet connected`)
  const chainId = fields.chainId ?? (namespace === 'evm' && connection.chainId !== null ? Number(connection.chainId) : 'mainnet')
  const message = createSignInMessage(namespace, { ...fields, address: connection.address, chainId })
  if (namespace === 'ton') {
    const tc = connection.provider as { signData?(data: { type: 'text'; text: string }): Promise<{ signature: string; address: string; timestamp: number; domain: string }> }
    if (!tc.signData) throw new WalletError('unsupported', 'signData needs @tonconnect/sdk 3.2 or later')
    const r = await tc.signData({ type: 'text', text: message })
    return { namespace, message, signature: r.signature, address: connection.address, ton: { address: r.address, timestamp: r.timestamp, domain: r.domain } }
  }
  return { namespace, message, signature: await wallet.signMessage(message, namespace), address: connection.address }
}
