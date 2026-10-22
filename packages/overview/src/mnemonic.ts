/**
 * 助记词 → 各链地址 → 多链总览（子路径 `@w3lib/overview/mnemonic`）。
 *
 * 只在本地推导地址：助记词、种子、私钥只存在于函数的局部变量里，用完的字节数组尽量清零（JS 的字符串没法清零，这是尽力而为）；
 * 不记录、不保存、不发到网络，返回值只有地址和派生路径，没有私钥。查询总览时发到节点的只有地址。
 *
 * 加密全部用审计过的库：@scure/bip39（助记词校验、种子）、@scure/bip32（secp256k1 的 BIP-32）、@noble/curves（ed25519、secp256k1）、
 * @noble/hashes（HMAC、PBKDF2、keccak、blake2b、sha256）；ed25519 链的 SLIP-0010 派生只是按规范组合 HMAC-SHA512，用 SLIP-0010 的测试向量核对过。
 */
import { ed25519 } from '@noble/curves/ed25519.js'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { blake2b } from '@noble/hashes/blake2.js'
import { hmac } from '@noble/hashes/hmac.js'
import { pbkdf2Async } from '@noble/hashes/pbkdf2.js'
import { sha256, sha512 } from '@noble/hashes/sha2.js'
import { keccak_256 } from '@noble/hashes/sha3.js'
import { base58, createBase58check } from '@scure/base'
import { HDKey } from '@scure/bip32'
import { mnemonicToSeed, validateMnemonic } from '@scure/bip39'
import { wordlist } from '@scure/bip39/wordlists/english.js'

import { combineChains, getOverview } from './overview.js'
import type { ChainOverview, EvmInput, ModuleLoader, Overview, OverviewInput, OverviewLoaders, OverviewOptions, SolanaInput, SuiInput, TonInput, TronInput } from './types.js'

export type MnemonicChain = 'evm' | 'tron' | 'solana' | 'sui' | 'ton'
export type TonWalletVersion = 'v4r2' | 'v5r1'

export const MNEMONIC_CHAINS: readonly MnemonicChain[] = ['evm', 'tron', 'solana', 'sui', 'ton']
/** 一次最多推导多少个账户 */
export const MAX_ACCOUNTS = 20

/** 各链的派生路径（第 i 个账户）：与 MetaMask、TronLink、Phantom、Sui 钱包、Trust Wallet / Tonkeeper（BIP-39 助记词）一致 */
export const DERIVATION_PATHS: Readonly<Record<MnemonicChain, (index: number) => string>> = {
  evm: (i) => `m/44'/60'/0'/0/${i}`,
  tron: (i) => `m/44'/195'/0'/0/${i}`,
  solana: (i) => `m/44'/501'/${i}'/0'`,
  sui: (i) => `m/44'/784'/${i}'/0'/0'`,
  ton: (i) => `m/44'/607'/${i}'`,
}

/** TON 自己格式的助记词（Tonkeeper、MyTonWallet 等生成的 24 个词）没有派生路径，path 是这个 */
export const TON_MNEMONIC_PATH = 'ton-mnemonic'

export interface DeriveOptions {
  /** 每条链推导几个账户（索引 0…accounts-1），默认 1，最多 20 */
  accounts?: number
  /** BIP-39 密码（第 25 个词），默认没有 */
  passphrase?: string
  /** 推导哪些链，默认全部 */
  chains?: readonly MnemonicChain[]
  /** TON 钱包地址用 ton-batch-call 的代码算：`tonWrite`（`/write`）和 `tonCore`（主入口），没传时按包名动态导入 */
  loaders?: Pick<OverviewLoaders, 'tonWrite' | 'tonCore'>
}

export interface TonDerived {
  index: number
  /** 主网、默认 wallet_id 的钱包地址（不可回弹格式 UQ…，与 Tonkeeper 显示的一样） */
  v4r2: string
  v5r1: string
  /** 'ton'：TON 自己格式的助记词（只有一个账户）；'bip39'：BIP-39 助记词按 m/44'/607'/i' 派生 */
  scheme: 'bip39' | 'ton'
  path: string
}

export interface DerivedAddresses {
  evm: string[]
  tron: string[]
  solana: string[]
  sui: string[]
  ton: TonDerived[]
  /** 与地址一一对应的派生路径 */
  paths: Record<'evm' | 'tron' | 'solana' | 'sui', string[]>
  /** 助记词类型：bip39 校验通过；ton 是 TON 自己格式的助记词（两者可以同时成立） */
  kind: { bip39: boolean; ton: boolean }
  warnings: string[]
}

const HARDENED = 0x80000000
const WORD_COUNTS = [12, 15, 18, 21, 24]
const WORDS = new Set(wordlist)
const utf8 = (s: string) => new TextEncoder().encode(s)
const toHex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
const tronBase58 = createBase58check(sha256)

/** 规范化（NFKD、小写、合并空白）并检查词数和词表；错误信息只有词数、词的位置，不带词本身 */
function wordsOf(mnemonic: string): string[] {
  if (typeof mnemonic !== 'string') throw new TypeError('@w3lib/overview: mnemonic must be a string')
  const words = mnemonic.normalize('NFKD').trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (!WORD_COUNTS.includes(words.length)) {
    throw new Error(`@w3lib/overview: invalid mnemonic: expected 12, 15, 18, 21 or 24 words, got ${words.length}`)
  }
  const unknown = words.flatMap((w, i) => (WORDS.has(w) ? [] : [`#${i + 1}`]))
  if (unknown.length) throw new Error(`@w3lib/overview: invalid mnemonic: word ${unknown.join(', ')} is not in the BIP-39 English word list`)
  return words
}

function checkAccounts(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > MAX_ACCOUNTS) {
    throw new RangeError(`@w3lib/overview: accounts must be an integer between 1 and ${MAX_ACCOUNTS}`)
  }
  return value
}

/** SLIP-0010 ed25519 派生（只有硬化索引）：返回 32 字节私钥，调用方用完清零 */
export function slip10Ed25519(seed: Uint8Array, path: readonly number[]): Uint8Array {
  const master = hmac(sha512, utf8('ed25519 seed'), seed)
  let key = master.slice(0, 32)
  let chainCode = master.slice(32)
  master.fill(0)
  for (const index of path) {
    const data = new Uint8Array(37)
    data.set(key, 1)
    new DataView(data.buffer).setUint32(33, (index | HARDENED) >>> 0)
    const child = hmac(sha512, chainCode, data)
    data.fill(0)
    key.fill(0)
    chainCode.fill(0)
    key = child.slice(0, 32)
    chainCode = child.slice(32)
    child.fill(0)
  }
  chainCode.fill(0)
  return key
}

/** secp256k1 公钥（压缩）→ keccak256(未压缩公钥) 的后 20 字节 */
function keccakAddress(publicKey: Uint8Array): Uint8Array {
  return keccak_256(secp256k1.Point.fromBytes(publicKey).toBytes(false).subarray(1)).subarray(12)
}

/** EIP-55 大小写校验 */
function checksumAddress(bytes: Uint8Array): string {
  const lower = toHex(bytes)
  const hash = toHex(keccak_256(utf8(lower)))
  return `0x${[...lower].map((c, i) => (parseInt(hash[i] as string, 16) >= 8 ? c.toUpperCase() : c)).join('')}`
}

function tronAddress(bytes: Uint8Array): string {
  const payload = new Uint8Array(21)
  payload[0] = 0x41
  payload.set(bytes, 1)
  return tronBase58.encode(payload)
}

/** Sui 地址：blake2b-256(0x00 签名方案标志 || ed25519 公钥) */
function suiAddress(publicKey: Uint8Array): string {
  const data = new Uint8Array(33)
  data.set(publicKey, 1)
  return `0x${toHex(blake2b(data, { dkLen: 32 }))}`
}

/**
 * TON 自己格式的助记词（与 @ton/crypto 的 mnemonicValidate / mnemonicToPrivateKey 相同，不带密码）：
 * entropy = HMAC-SHA512(助记词, '')，PBKDF2(entropy, 'TON seed version', 390 次) 的第一个字节为 0 才合法；
 * 私钥种子 = PBKDF2(entropy, 'TON default seed', 100000 次) 的前 32 字节。不合法时返回 null
 */
export async function tonMnemonicSeed(words: readonly string[]): Promise<Uint8Array | null> {
  if (words.length !== 24) return null
  const entropy = hmac(sha512, utf8(words.join(' ')), new Uint8Array(0))
  try {
    const check = await pbkdf2Async(sha512, entropy, utf8('TON seed version'), { c: Math.floor(100_000 / 256), dkLen: 64 })
    const valid = check[0] === 0
    check.fill(0)
    if (!valid) return null
    const seed = await pbkdf2Async(sha512, entropy, utf8('TON default seed'), { c: 100_000, dkLen: 64 })
    const key = seed.slice(0, 32)
    seed.fill(0)
    return key
  } finally {
    entropy.fill(0)
  }
}

/** ton-batch-call 里算钱包地址的代码（结构，不引用链包类型） */
export interface TonModules {
  write: { walletAddress(version: TonWalletVersion, publicKey: Uint8Array, walletId: number, workchain?: number): unknown; defaultWalletId(version: TonWalletVersion, network: 'mainnet' | 'testnet'): number }
  core: {
    toFriendlyAddress(address: any, options?: { bounceable?: boolean; testOnly?: boolean }): string
    getWalletStates?(addresses: readonly string[], options?: Record<string, unknown>): Promise<Array<{ status: string; balance: string; walletType: string | null }>>
  }
}

const TON_MODULES = { tonWrite: '@w3lib/ton-batch-call/write', tonCore: '@w3lib/ton-batch-call' } as const

function loadTonModule(loaders: DeriveOptions['loaders'], key: keyof typeof TON_MODULES): Promise<any> {
  const loader: ModuleLoader | undefined = loaders?.[key]
  return (loader ? loader() : import(/* @vite-ignore */ /* webpackIgnore: true */ TON_MODULES[key])).catch((err: unknown) => {
    throw new Error(`${TON_MODULES[key]} could not be loaded (${err instanceof Error ? err.message : String(err)}). Install @w3lib/ton-batch-call and pass loaders: { ${key}: () => import('${TON_MODULES[key]}') }`)
  })
}

async function loadTon(loaders: DeriveOptions['loaders']): Promise<TonModules> {
  const [write, core] = await Promise.all([loadTonModule(loaders, 'tonWrite'), loadTonModule(loaders, 'tonCore')])
  return { write, core }
}

/** 公钥 → v4r2 / v5r1 钱包地址（默认 wallet_id、工作链 0），不可回弹格式 */
export function tonWalletAddresses(publicKey: Uint8Array, ton: TonModules, network: 'mainnet' | 'testnet' = 'mainnet'): Record<TonWalletVersion, string> {
  const of = (version: TonWalletVersion) =>
    ton.core.toFriendlyAddress(ton.write.walletAddress(version, publicKey, ton.write.defaultWalletId(version, network)), { bounceable: false, testOnly: network === 'testnet' })
  return { v4r2: of('v4r2'), v5r1: of('v5r1') }
}

/**
 * 从助记词推导各链地址（只返回地址和派生路径）。
 *
 * - EVM `m/44'/60'/0'/0/i`、Tron `m/44'/195'/0'/0/i`（BIP-32 secp256k1）
 * - Solana `m/44'/501'/i'/0'`、Sui `m/44'/784'/i'/0'/0'`（SLIP-0010 ed25519）
 * - TON：BIP-39 `m/44'/607'/i'`；是 TON 自己格式的 24 词助记词时用它的密钥（只有一个账户）；两种都成立时（约 1/256 的 24 词 BIP-39 助记词）两种都推导，
 *   `scheme` 区分；每个都给出 v4r2 和 v5r1 两个钱包地址
 *
 * 助记词校验不通过时抛错（错误信息不含助记词）。
 *
 * ```ts
 * const a = await deriveAddresses(mnemonic, { accounts: 3 })
 * a.evm[0]; a.paths.evm[0]   // '0x…', "m/44'/60'/0'/0/0"
 * a.ton[0]                   // { index: 0, v4r2: 'UQ…', v5r1: 'UQ…', scheme: 'bip39', path: "m/44'/607'/0'" }
 * ```
 */
export async function deriveAddresses(mnemonic: string, options: DeriveOptions = {}): Promise<DerivedAddresses> {
  const accounts = checkAccounts(options.accounts ?? 1)
  const passphrase = options.passphrase ?? ''
  if (typeof passphrase !== 'string') throw new TypeError('@w3lib/overview: passphrase must be a string')
  const chains = new Set(options.chains ?? MNEMONIC_CHAINS)
  for (const c of chains) if (!MNEMONIC_CHAINS.includes(c)) throw new TypeError(`@w3lib/overview: unknown chain ${String(c)}`)

  const words = wordsOf(mnemonic)
  const bip39 = validateMnemonic(words.join(' '), wordlist)
  // TON 格式只在不带密码时识别（带密码的 TON 助记词很少见，不支持）
  let tonKey = chains.has('ton') && !passphrase ? await tonMnemonicSeed(words) : null
  if (!bip39 && !tonKey) throw new Error('@w3lib/overview: invalid mnemonic: checksum mismatch (check the spelling and order of the words)')

  const out: DerivedAddresses = {
    evm: [],
    tron: [],
    solana: [],
    sui: [],
    ton: [],
    paths: { evm: [], tron: [], solana: [], sui: [] },
    kind: { bip39, ton: !!tonKey },
    warnings: [],
  }
  let ton: TonModules | null = null
  if (chains.has('ton')) {
    try {
      ton = await loadTon(options.loaders)
    } catch (err) {
      out.warnings.push(`没有推导 TON：${err instanceof Error ? err.message : String(err)}`)
    }
  }
  const indexes = Array.from({ length: accounts }, (_, i) => i)
  let seed: Uint8Array | null = null
  try {
    if (bip39) {
      seed = await mnemonicToSeed(words.join(' '), passphrase)
      for (const kind of ['evm', 'tron'] as const) {
        if (!chains.has(kind)) continue
        const root = HDKey.fromMasterSeed(seed)
        const parent = root.derive(kind === 'evm' ? "m/44'/60'/0'/0" : "m/44'/195'/0'/0")
        root.wipePrivateData()
        for (const i of indexes) {
          const child = parent.deriveChild(i)
          const bytes = keccakAddress(child.publicKey as Uint8Array)
          child.wipePrivateData()
          out[kind].push(kind === 'evm' ? checksumAddress(bytes) : tronAddress(bytes))
          out.paths[kind].push(DERIVATION_PATHS[kind](i))
        }
        parent.wipePrivateData()
      }
      const ed = (path: readonly number[]) => {
        const key = slip10Ed25519(seed as Uint8Array, path)
        const publicKey = ed25519.getPublicKey(key)
        key.fill(0)
        return publicKey
      }
      for (const i of indexes) {
        if (chains.has('solana')) {
          out.solana.push(base58.encode(ed([44, 501, i, 0])))
          out.paths.solana.push(DERIVATION_PATHS.solana(i))
        }
        if (chains.has('sui')) {
          out.sui.push(suiAddress(ed([44, 784, i, 0, 0])))
          out.paths.sui.push(DERIVATION_PATHS.sui(i))
        }
        if (ton) out.ton.push({ index: i, ...tonWalletAddresses(ed([44, 607, i]), ton), scheme: 'bip39', path: DERIVATION_PATHS.ton(i) })
      }
    }
    if (tonKey) {
      if (ton) out.ton.push({ index: 0, ...tonWalletAddresses(ed25519.getPublicKey(tonKey), ton), scheme: 'ton', path: TON_MNEMONIC_PATH })
      if (!bip39) out.warnings.push('这是 TON 格式的助记词（不是 BIP-39）：只能推导 TON 钱包')
      else if (ton) out.warnings.push('这个助记词同时符合 BIP-39 和 TON 格式：TON 两种钱包都推导（scheme 区分），查询时用在用的')
      if (accounts > 1) out.warnings.push('TON 格式的助记词只有一个账户')
    }
  } finally {
    seed?.fill(0)
    tonKey?.fill(0)
    tonKey = null
  }
  return out
}

// ---------------------------------------------------------------------------
// 总览
// ---------------------------------------------------------------------------

/** 没传 evm.chains 时查的链 */
const DEFAULT_EVM_CHAINS = [1, 56, 8453]

export interface DerivedOverviewOptions extends OverviewOptions {
  /** 各链的配置，同 getOverview 的输入（地址由助记词推导）；EVM 没传 chains 时查 Ethereum、BNB Chain、Base，chains 为空数组时不查 EVM（warnings 里说明） */
  evm?: Partial<Omit<EvmInput, 'address'>>
  tron?: Omit<TronInput, 'address'>
  solana?: Omit<SolanaInput, 'address'>
  sui?: Omit<SuiInput, 'address'>
  ton?: Omit<TonInput, 'address'>
  /** 一个账户查完时调用 */
  onAccount?: (account: AccountOverview) => void
}

export interface MnemonicOverviewOptions extends DerivedOverviewOptions, Omit<DeriveOptions, 'loaders'> {}

export interface TonQueried {
  version: TonWalletVersion
  /** 来自哪种推导（助记词同时符合 BIP-39 和 TON 格式时两种都有） */
  scheme: TonDerived['scheme']
  address: string
  /** 链上状态 'active' / 'uninit' / 'nonexist'；读不到时为 null */
  status: string | null
}

export interface AccountOverview {
  index: number
  /** 这个账户查询用的地址 */
  addresses: { evm?: string; tron?: string; solana?: string; sui?: string }
  /** 查询的 TON 钱包：已部署或有余额的（多个时都查），都没有时查 v5r1（两种 scheme 时各一个） */
  ton: TonQueried[]
  overview: Overview
}

export interface MnemonicOverview {
  addresses: DerivedAddresses
  accounts: AccountOverview[]
  /** 推导和选择 TON 钱包时的说明（addresses.warnings 加上查询时的） */
  warnings: string[]
  /** 所有账户合起来（byChain 里同一条链可能出现多次，按 address 区分） */
  total: Overview
}

/** 每个账户查哪个 TON 钱包：读各钱包的链上状态，用已部署或有余额的；core 没加载到时（调用方已写 warning）都查 */
async function pickTonWallets(list: readonly TonDerived[], core: TonModules['core'] | null, options: DerivedOverviewOptions, warnings: string[]): Promise<Map<number, TonQueried[]>> {
  const picked = new Map<number, TonQueried[]>()
  if (!list.length) return picked
  let states: Array<{ status: string; balance: string }> | null = null
  if (core) {
    try {
      if (!core.getWalletStates) throw new Error('getWalletStates is not available')
      const node = { ...(options.fetch ? { fetch: options.fetch } : {}), ...(options.ton?.node ?? {}), ...(options.signal ? { signal: options.signal } : {}) }
      states = await core.getWalletStates(list.flatMap((t) => [t.v4r2, t.v5r1]), node)
    } catch (err) {
      options.signal?.throwIfAborted()
      warnings.push(`TON：读不到钱包状态（${err instanceof Error ? err.message : String(err)}），v4r2 和 v5r1 都查`)
    }
  }
  // 同一个账户可能有两种 scheme（BIP-39 和 TON 格式），一起选
  const byIndex = new Map<number, Array<TonQueried & { used: boolean }>>()
  list.forEach((t, k) => {
    const all = byIndex.get(t.index) ?? []
    ;(['v4r2', 'v5r1'] as const).forEach((version, j) => {
      const s = states?.[k * 2 + j]
      all.push({ version, scheme: t.scheme, address: t[version], status: s?.status ?? null, used: !!s && (s.status === 'active' || /^[1-9]\d*$/.test(s.balance)) })
    })
    byIndex.set(t.index, all)
  })
  for (const [index, all] of byIndex) {
    const used = states ? all.filter((w) => w.used) : all
    picked.set(index, (used.length ? used : all.filter((w) => w.version === 'v5r1')).map(({ used: _, ...w }) => w))
  }
  return picked
}

/**
 * 助记词 → 推导地址 → 每个账户一次 getOverview（账户依次查，免费节点不容易限频），再合计所有账户。
 * 选项同 getOverview，加上 deriveAddresses 的 accounts / passphrase / chains 和各链的配置。
 *
 * ```ts
 * const r = await getOverviewFromMnemonic(mnemonic, { accounts: 3, evm: { chains: [1, 56] }, loaders })
 * r.total.totalUsd                       // 所有账户的合计
 * r.accounts[0].overview.byChain         // 账户 0 的分链明细
 * r.addresses.paths.evm                  // 派生路径
 * ```
 */
export async function getOverviewFromMnemonic(mnemonic: string, options: MnemonicOverviewOptions = {}): Promise<MnemonicOverview> {
  const { accounts, passphrase, chains, ...rest } = options
  const addresses = await deriveAddresses(mnemonic, {
    ...(accounts !== undefined ? { accounts } : {}),
    ...(passphrase !== undefined ? { passphrase } : {}),
    ...(chains ? { chains } : {}),
    ...(options.loaders ? { loaders: options.loaders } : {}),
  })
  return getDerivedOverview(addresses, rest)
}

/**
 * 用 deriveAddresses 的结果查总览：可以先推导、丢掉助记词，再查询（getOverviewFromMnemonic 就是这两步）。
 *
 * ```ts
 * const addresses = await deriveAddresses(mnemonic, { accounts: 3 })   // 之后不再需要助记词
 * const r = await getDerivedOverview(addresses, { evm: { chains: [1, 56] }, loaders })
 * ```
 */
export async function getDerivedOverview(addresses: DerivedAddresses, options: DerivedOverviewOptions = {}): Promise<MnemonicOverview> {
  const { evm, tron, solana, sui, ton, onAccount, ...overviewOptions } = options
  const started = Date.now()
  const warnings = [...addresses.warnings]
  // 选钱包只要 ton-batch-call 主入口的 getWalletStates；加载不了时不中断，两个版本都查
  let tonCore: TonModules['core'] | null = null
  if (addresses.ton.length) {
    try {
      tonCore = await loadTonModule(options.loaders, 'tonCore')
    } catch (err) {
      options.signal?.throwIfAborted()
      warnings.push(`TON：读不到钱包状态（${err instanceof Error ? err.message : String(err)}），v4r2 和 v5r1 都查`)
    }
  }
  const tonWallets = await pickTonWallets(addresses.ton, tonCore, options, warnings)
  const evmChains = evm?.chains ?? DEFAULT_EVM_CHAINS
  if (addresses.evm.length && !evmChains.length) warnings.push('EVM：evm.chains 是空的，没有查 EVM')
  const evmAddresses = evmChains.length ? addresses.evm : []
  const count = Math.max(0, evmAddresses.length, addresses.tron.length, addresses.solana.length, addresses.sui.length, ...addresses.ton.map((t) => t.index + 1))
  if (count > MAX_ACCOUNTS) throw new RangeError(`@w3lib/overview: at most ${MAX_ACCOUNTS} accounts`)

  const result: AccountOverview[] = []
  for (let i = 0; i < count; i++) {
    options.signal?.throwIfAborted()
    const a = { evm: evmAddresses[i], tron: addresses.tron[i], solana: addresses.solana[i], sui: addresses.sui[i] }
    const tonList = tonWallets.get(i) ?? []
    const input: OverviewInput = {
      ...(a.evm ? { evm: { ...evm, chains: evmChains, address: a.evm } } : {}),
      ...(a.tron ? { tron: { ...tron, address: a.tron } } : {}),
      ...(a.solana ? { solana: { ...solana, address: a.solana } } : {}),
      ...(a.sui ? { sui: { ...sui, address: a.sui } } : {}),
      ...(tonList[0] ? { ton: { ...ton, address: tonList[0].address } } : {}),
    }
    const parts = Object.keys(input).length ? [await getOverview(input, overviewOptions)] : []
    // 两个 TON 钱包都在用时，第二个单独查一次再合并
    for (const extra of tonList.slice(1)) parts.push(await getOverview({ ton: { ...ton, address: extra.address } }, overviewOptions))
    const overview = parts.length === 1 ? (parts[0] as Overview) : combineChains(parts.flatMap((p) => p.byChain), parts.reduce((s, p) => s + p.timings.totalMs, 0), !!options.approvals, () => i)
    const account: AccountOverview = {
      index: i,
      addresses: Object.fromEntries(Object.entries(a).filter(([, v]) => v)) as AccountOverview['addresses'],
      ton: tonList,
      overview,
    }
    result.push(account)
    try {
      onAccount?.(account)
    } catch {
      // 界面回调出错不影响结果
    }
  }
  const accountOf = new Map<ChainOverview, number>()
  for (const r of result) for (const c of r.overview.byChain) accountOf.set(c, r.index)
  return { addresses, accounts: result, warnings, total: combineChains([...accountOf.keys()], Date.now() - started, !!options.approvals, (c) => accountOf.get(c)) }
}
