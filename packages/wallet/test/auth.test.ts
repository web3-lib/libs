/** 钱包登录：消息格式、各链的签名验证（用本地生成的密钥按各钱包的签名方式签名；EVM 和 ethers 交叉核对） */
import { ed25519 } from '@noble/curves/ed25519.js'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { blake2b } from '@noble/hashes/blake2.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { keccak_256 } from '@noble/hashes/sha3.js'
import { Wallet } from 'ethers'
import { describe, expect, it } from 'vitest'

import { createNonce, createSignInMessage, parseSignInMessage, signIn, type SignInProof } from '../src/auth/index.js'
import { base58 } from '../src/core/encoding.js'
import { verifySignIn } from '../src/verify/index.js'

const DOMAIN = 'app.example'
const NOW = new Date('2026-10-19T08:00:00.000Z')
const base = { domain: DOMAIN, uri: 'https://app.example', nonce: 'abcdef123456', issuedAt: NOW.toISOString() }
const opts = { domain: DOMAIN, nonce: 'abcdef123456', now: NOW }

const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('')
const utf8 = (s: string) => new TextEncoder().encode(s)
const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b))
const concat = (...p: Uint8Array[]) => Uint8Array.from(p.flatMap((x) => [...x]))

describe('登录消息', () => {
  it('EIP-4361 格式，可以解析回来（含可选字段）', () => {
    const text = createSignInMessage('evm', { ...base, address: '0xAbC0000000000000000000000000000000000001', chainId: 1, statement: 'Sign in to Example', expirationTime: '2026-10-19T09:00:00.000Z', resources: ['https://a', 'ipfs://b'] })
    expect(text).toBe(
      [
        'app.example wants you to sign in with your Ethereum account:',
        '0xAbC0000000000000000000000000000000000001',
        '',
        'Sign in to Example',
        '',
        'URI: https://app.example',
        'Version: 1',
        'Chain ID: 1',
        'Nonce: abcdef123456',
        'Issued At: 2026-10-19T08:00:00.000Z',
        'Expiration Time: 2026-10-19T09:00:00.000Z',
        'Resources:',
        '- https://a',
        '- ipfs://b',
      ].join('\n'),
    )
    expect(parseSignInMessage(text)).toMatchObject({ namespace: 'evm', statement: 'Sign in to Example', chainId: '1', resources: ['https://a', 'ipfs://b'] })
    const SOL = 'So11111111111111111111111111111111111111112'
    const plain = createSignInMessage('solana', { ...base, address: SOL, chainId: 'mainnet' })
    expect(plain.split('\n').slice(0, 4)).toEqual(['app.example wants you to sign in with your Solana account:', SOL, '', 'URI: https://app.example'])
    expect(parseSignInMessage(plain)).toMatchObject({ namespace: 'solana', address: SOL, chainId: 'mainnet' })
    expect(parseSignInMessage(plain).statement).toBeUndefined()
    // EVM 没有 statement：EIP-4361 要求两个空行（siwe-parser / MetaMask 才认得出是登录请求）
    const evmPlain = createSignInMessage('evm', { ...base, address: '0xAbC0000000000000000000000000000000000001', chainId: 1 })
    expect(evmPlain.split('\n').slice(1, 5)).toEqual(['0xAbC0000000000000000000000000000000000001', '', '', 'URI: https://app.example'])
    expect(parseSignInMessage(evmPlain).statement).toBeUndefined()
  })

  it('不合法的字段报错（换行 / 控制字符 / 行分隔符、夹带字段、EVM 的非 ASCII statement）；createNonce 是 16 位字母数字', () => {
    const evmBase = { ...base, address: '0xAbC0000000000000000000000000000000000001', chainId: 1 }
    expect(() => createSignInMessage('evm', { ...evmBase, nonce: 'short' })).toThrow(/nonce/)
    expect(() => createSignInMessage('evm', { ...evmBase, address: '0x1' })).toThrow(/address/)
    expect(() => createSignInMessage('evm', { ...evmBase, statement: 'a\nb' })).toThrow(/line breaks/)
    expect(() => createSignInMessage('evm', { ...evmBase, statement: 'a\rb' })).toThrow(/line breaks/)
    expect(() => createSignInMessage('evm', { ...evmBase, statement: 'a\u2028b' })).toThrow(/line breaks/)
    expect(() => createSignInMessage('evm', { ...evmBase, requestId: 'x\nResources:\n- https://evil' })).toThrow(/line breaks/)
    expect(() => createSignInMessage('evm', { ...evmBase, resources: ['a\n- evil'] })).toThrow(/line breaks/)
    expect(() => createSignInMessage('evm', { ...evmBase, statement: 'URI: https://evil' })).toThrow(/statement/)
    expect(() => createSignInMessage('evm', { ...evmBase, statement: '登录' })).toThrow(/statement/)
    expect(() => createSignInMessage('evm', { ...evmBase, expirationTime: 'tomorrow' })).toThrow(/RFC 3339/)
    expect(() => createSignInMessage('evm', { ...evmBase, chainId: 'mainnet' })).toThrow(/chainId/)
    expect(() => parseSignInMessage('hello')).toThrow(/Not a sign-in message/)
    // 解析要求是规范格式：多一个空格、Resources 为空都不行
    const ok = createSignInMessage('evm', { ...evmBase, statement: 'hi' })
    expect(() => parseSignInMessage(ok.replace('URI: ', 'URI:  '))).toThrow()
    expect(() => parseSignInMessage(`${ok}\nResources:`)).toThrow()
    expect(createNonce()).toMatch(/^[A-Za-z0-9]{16}$/)
  })
})

describe('verifySignIn', () => {
  it('EVM：ethers 的 signMessage（personal_sign）通过；改了消息、换了域名、nonce 不对、过期都不通过', async () => {
    const w = Wallet.createRandom()
    const message = createSignInMessage('evm', { ...base, address: w.address, chainId: 1 })
    const proof: SignInProof = { namespace: 'evm', message, signature: await w.signMessage(message), address: w.address }
    expect(await verifySignIn(proof, opts)).toMatchObject({ ok: true, message: { address: w.address }, address: w.address })
    // 小写地址也能登录，返回的 address 是 EIP-55 格式（账户的键不会因大小写不同而分裂）
    const lowerMessage = createSignInMessage('evm', { ...base, address: w.address.toLowerCase(), chainId: 1 })
    const lower: SignInProof = { namespace: 'evm', message: lowerMessage, signature: await w.signMessage(lowerMessage), address: w.address.toLowerCase() }
    expect(await verifySignIn(lower, opts)).toMatchObject({ ok: true, address: w.address })
    // 有 Expiration Time 也受 maxAge 限制：很久以前签的、到 2099 年才过期的签名不能用
    const oldMessage = createSignInMessage('evm', { ...base, address: w.address, chainId: 1, issuedAt: '2020-01-01T00:00:00Z', expirationTime: '2099-01-01T00:00:00Z' })
    expect(await verifySignIn({ ...proof, message: oldMessage, signature: await w.signMessage(oldMessage) }, opts)).toMatchObject({ ok: false, error: 'message expired' })
    // chainId 选项
    expect(await verifySignIn(proof, { ...opts, chainId: 56 })).toMatchObject({ ok: false, error: expect.stringMatching(/chain/) })
    // 非法的 now、nonce 回调出错：返回失败，不抛出
    expect(await verifySignIn(proof, { ...opts, now: new Date(NaN) })).toMatchObject({ ok: false })
    expect(
      await verifySignIn(proof, {
        ...opts,
        nonce: async () => {
          throw new Error('db down')
        },
      }),
    ).toMatchObject({ ok: false, error: expect.stringMatching(/db down/) })
    // high-S（同一签名的另一种写法）不通过
    const n = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n
    const sig = proof.signature.slice(2)
    const highS = (n - BigInt(`0x${sig.slice(64, 128)}`)).toString(16).padStart(64, '0')
    const flipped = `0x${sig.slice(0, 64)}${highS}${(parseInt(sig.slice(128), 16) ^ 1).toString(16)}`
    expect((await verifySignIn({ ...proof, signature: flipped }, opts)).ok).toBe(false)
    expect((await verifySignIn({ ...proof, message: message.replace('Chain ID: 1', 'Chain ID: 56') }, opts)).ok).toBe(false)
    expect(await verifySignIn(proof, { ...opts, domain: 'evil.example' })).toMatchObject({ ok: false, error: expect.stringMatching(/domain/) })
    expect(await verifySignIn(proof, { ...opts, nonce: 'other12345' })).toMatchObject({ ok: false, error: 'nonce mismatch' })
    expect(await verifySignIn(proof, { ...opts, now: new Date(NOW.getTime() + 11 * 60_000) })).toMatchObject({ ok: false, error: 'message expired' })
    expect(await verifySignIn(proof, { ...opts, nonce: async (n) => n === 'abcdef123456' })).toMatchObject({ ok: true })
  })

  it('EVM：恢复出的不是登录地址时交给 verifyContract（EIP-1271）', async () => {
    const signer = Wallet.createRandom()
    const safe = '0x000000000000000000000000000000000000cafe'
    const message = createSignInMessage('evm', { ...base, address: safe, chainId: 1 })
    const proof: SignInProof = { namespace: 'evm', message, signature: await signer.signMessage(message), address: safe }
    expect((await verifySignIn(proof, opts)).ok).toBe(false)
    let seen: { address: string; hash: string } | null = null
    const verifyContract = async (input: { address: string; chainId: string; hash: string; signature: string }) => {
      seen = input
      return true
    }
    // 用 verifyContract 时必须指定 chainId（消息里的 Chain ID 由签名的人决定）
    expect(await verifySignIn(proof, { ...opts, verifyContract })).toMatchObject({ ok: false, error: expect.stringMatching(/chainId/) })
    const r = await verifySignIn(proof, { ...opts, chainId: 1, verifyContract })
    expect(r.ok).toBe(true)
    expect(seen).toMatchObject({ address: safe, hash: expect.stringMatching(/^0x[0-9a-f]{64}$/) })
    // 恢复字节是 31（Safe 的 eth_sign 签名）：恢复不出地址时也交给 verifyContract
    seen = null
    const safeSig = `${proof.signature.slice(0, 130)}1f`
    expect((await verifySignIn({ ...proof, signature: safeSig }, { ...opts, chainId: 1, verifyContract })).ok).toBe(true)
    expect(seen).not.toBe(null)
  })

  it('Tron：signMessageV2（\\x19TRON Signed Message 前缀 + keccak），T 地址', async () => {
    const sk = secp256k1.utils.randomSecretKey()
    const pk = secp256k1.getPublicKey(sk, false)
    const body = concat(Uint8Array.from([0x41]), keccak_256(pk.slice(1)).slice(12))
    const address = base58(concat(body, sha256(sha256(body)).slice(0, 4)))
    const message = createSignInMessage('tron', { ...base, address, chainId: 'mainnet' })
    const bytes = utf8(message)
    const sig = secp256k1.sign(keccak_256(concat(utf8(`\x19TRON Signed Message:\n${bytes.length}`), bytes)), sk, { prehash: false, format: 'recovered' })
    // noble 的 recovered 格式是 recovery ‖ r ‖ s；钱包返回 r ‖ s ‖ v（v = 27 / 28）
    const signature = `0x${hex(sig.slice(1))}${(sig[0] as number + 27).toString(16)}`
    expect(await verifySignIn({ namespace: 'tron', message, signature, address }, opts)).toMatchObject({ ok: true })
    expect((await verifySignIn({ namespace: 'tron', message: message.replace('mainnet', 'nile'), signature, address }, opts)).ok).toBe(false)
  })

  it('Solana：ed25519，签名 base58', async () => {
    const sk = ed25519.utils.randomSecretKey()
    const address = base58(ed25519.getPublicKey(sk))
    const message = createSignInMessage('solana', { ...base, address, chainId: 'mainnet' })
    const signature = base58(ed25519.sign(utf8(message), sk))
    expect(await verifySignIn({ namespace: 'solana', message, signature, address }, opts)).toMatchObject({ ok: true })
    // 全零公钥（System Program）+ 恒等点 R、S = 0 的“签名”：zip215 宽松模式下对任何消息都成立，这里必须拒绝
    const zero = '11111111111111111111111111111111'
    const zeroMessage = createSignInMessage('solana', { ...base, address: zero, chainId: 'mainnet' })
    const forged = base58(Uint8Array.from([1, ...new Array(63).fill(0)]))
    expect((await verifySignIn({ namespace: 'solana', message: zeroMessage, signature: forged, address: zero }, opts)).ok).toBe(false)
    const other = base58(ed25519.getPublicKey(ed25519.utils.randomSecretKey()))
    expect((await verifySignIn({ namespace: 'solana', message: message.replace(address, other), signature, address: other }, opts)).ok).toBe(false)
  })

  it('Sui：signPersonalMessage 的序列化签名（ed25519 / secp256k1），地址 = blake2b(flag ‖ 公钥)；zkLogin 明确报不支持', async () => {
    const intent = (text: string) => {
      const bytes = utf8(text)
      return blake2b(concat(Uint8Array.from([3, 0, 0, bytes.length & 0x7f | (bytes.length > 127 ? 0x80 : 0)]), bytes.length > 127 ? Uint8Array.from([bytes.length >> 7]) : new Uint8Array(), bytes), { dkLen: 32 })
    }
    const suiAddress = (flag: number, pk: Uint8Array) => `0x${hex(blake2b(concat(Uint8Array.from([flag]), pk), { dkLen: 32 }))}`
    // ed25519
    const sk = ed25519.utils.randomSecretKey()
    const pk = ed25519.getPublicKey(sk)
    const address = suiAddress(0, pk)
    const message = createSignInMessage('sui', { ...base, address, chainId: 'mainnet', statement: '一段比较长的说明，让消息超过 127 字节，检查 ULEB128 长度的两字节编码是否正确' })
    expect(utf8(message).length).toBeGreaterThan(127)
    const signature = b64(concat(Uint8Array.from([0]), ed25519.sign(intent(message), sk), pk))
    expect(await verifySignIn({ namespace: 'sui', message, signature, address }, opts)).toMatchObject({ ok: true })
    // secp256k1：对 digest 的 sha256 签名
    const ksk = secp256k1.utils.randomSecretKey()
    const kpk = secp256k1.getPublicKey(ksk, true)
    const kaddress = suiAddress(1, kpk)
    const kmessage = createSignInMessage('sui', { ...base, address: kaddress, chainId: 'mainnet' })
    const ksig = secp256k1.sign(intent(kmessage), ksk)
    expect(await verifySignIn({ namespace: 'sui', message: kmessage, signature: b64(concat(Uint8Array.from([1]), ksig, kpk)), address: kaddress }, opts)).toMatchObject({ ok: true })
    expect(await verifySignIn({ namespace: 'sui', message: kmessage, signature: b64(concat(Uint8Array.from([5]), new Uint8Array(100))), address: kaddress }, opts)).toMatchObject({ ok: false, error: expect.stringMatching(/zkLogin/) })
  })

  it('TON：signData（text）的格式，公钥由 tonPublicKey 提供；签名里的域名、地址要和登录消息一致', async () => {
    const sk = ed25519.utils.randomSecretKey()
    const pk = ed25519.getPublicKey(sk)
    const hash = new Uint8Array(32).fill(7)
    // user-friendly 地址：flag(0x51 不可弹回) ‖ workchain ‖ hash ‖ crc16
    const crc16 = (data: Uint8Array) => {
      let crc = 0
      for (const byte of data) {
        crc ^= byte << 8
        for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff
      }
      return crc
    }
    const friendlyOf = (flag: number) => {
      const body = concat(Uint8Array.from([flag, 0]), hash)
      const crc = crc16(body)
      return b64(concat(body, Uint8Array.from([crc >> 8, crc & 0xff]))).replace(/\+/g, '-').replace(/\//g, '_')
    }
    const friendly = friendlyOf(0x51)
    const raw = `0:${hex(hash)}`
    const message = createSignInMessage('ton', { ...base, address: friendly, chainId: 'mainnet' })
    const timestamp = Math.floor(NOW.getTime() / 1000)
    const u32 = (n: number) => Uint8Array.from([n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255])
    const ts = new Uint8Array(8)
    new DataView(ts.buffer).setBigUint64(0, BigInt(timestamp))
    const text = utf8(message)
    const payload = concat(Uint8Array.from([0xff, 0xff]), utf8('ton-connect/sign-data/'), u32(0), hash, u32(DOMAIN.length), utf8(DOMAIN), ts, utf8('txt'), u32(text.length), text)
    const proof: SignInProof = { namespace: 'ton', message, signature: b64(ed25519.sign(sha256(payload), sk)), address: friendly, ton: { address: raw, timestamp, domain: DOMAIN } }
    const tonPublicKey = async () => hex(pk)
    expect(await verifySignIn(proof, { ...opts, tonPublicKey })).toMatchObject({ ok: true, address: raw })
    // CRC 不对、主网上用测试网地址：不通过
    const badCrc = `${friendly.slice(0, 46)}${friendly.slice(46) === 'AA' ? 'AB' : 'AA'}`
    const badMessage = message.replace(friendly, badCrc)
    expect((await verifySignIn({ ...proof, message: badMessage, address: badCrc }, { ...opts, tonPublicKey })).ok).toBe(false)
    expect(await verifySignIn(proof, opts)).toMatchObject({ ok: false, error: expect.stringMatching(/tonPublicKey/) })
    expect(await verifySignIn({ ...proof, ton: { ...proof.ton!, timestamp: timestamp - 3600 } }, { ...opts, tonPublicKey })).toMatchObject({ ok: false, error: expect.stringMatching(/timestamp/) })
    expect(await verifySignIn({ ...proof, ton: { ...proof.ton!, domain: 'evil.example' } }, { ...opts, tonPublicKey })).toMatchObject({ ok: false, error: expect.stringMatching(/domain/) })
    expect(await verifySignIn({ ...proof, ton: { ...proof.ton!, address: `0:${'11'.repeat(32)}` } }, { ...opts, tonPublicKey })).toMatchObject({ ok: false, error: expect.stringMatching(/address/) })
  })

  it('signIn：用连接的地址和链拼消息、调用钱包签名', async () => {
    const w = Wallet.createRandom()
    const wallet = {
      getConnection: () => ({ address: w.address, chainId: 56, provider: null }),
      signMessage: (message: string) => w.signMessage(message),
    }
    const proof = await signIn(wallet, 'evm', { domain: DOMAIN, uri: 'https://app.example', nonce: 'abcdef123456', issuedAt: NOW.toISOString() })
    expect(parseSignInMessage(proof.message)).toMatchObject({ chainId: '56', address: w.address })
    expect(await verifySignIn(proof, opts)).toMatchObject({ ok: true })
  })
})
