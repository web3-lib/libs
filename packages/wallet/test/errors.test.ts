import { afterEach, describe, expect, it, vi } from 'vitest'

import { WalletError, isMobileBrowser, isUserRejected, openInWalletUrl, toWalletError } from '../src/index.js'
import { base58, base64, hex, toBytes } from '../src/core/encoding.js'

afterEach(() => vi.unstubAllGlobals())

describe('isUserRejected：各钱包 / 库的“用户拒绝”写法', () => {
  it.each([
    ['EIP-1193 4001', { code: 4001, message: 'x' }],
    ['字符串错误码', { code: '4001' }],
    ['ethers v6 ACTION_REJECTED', { code: 'ACTION_REJECTED' }],
    ['WalletConnect 5000', { code: 5000 }],
    ['5002', { code: 5002 }],
    ['包在 error 里', { error: { code: 4001 } }],
    ['ethers 包在 info.error 里', { info: { error: { code: 4001 } } }],
    ['包在 cause 里', { cause: { code: 4001 } }],
    ['viem UserRejectedRequestError', { name: 'UserRejectedRequestError', message: 'x' }],
    ['Phantom 文本', new Error('User rejected the request.')],
    ['Solflare 文本', new Error('Confirmation declined by user')],
    ['TonConnect（name 为 Error，类型写在消息里）', new Error('[TON_CONNECT_SDK_ERROR] UserRejectsError\nUser rejects the action in the wallet.')],
    ['WalletConnect 关闭弹窗', new Error('Connection request reset. Please try again.')],
    ['TronLink 中文', new Error('用户拒绝签名')],
    ['字符串', 'User canceled'],
    ['WalletError', new WalletError('user_rejected', 'x')],
  ])('%s', (_, err) => {
    expect(isUserRejected(err)).toBe(true)
    expect(toWalletError(err).code).toBe('user_rejected')
  })

  it('不是拒绝的不误判', () => {
    expect(isUserRejected(new Error('insufficient funds'))).toBe(false)
    expect(isUserRejected(null)).toBe(false)
    expect(isUserRejected(new WalletError('unknown', 'cancelled somewhere'))).toBe(false)
    // ethers 的交易被替换（加速 / 取消）不是用户拒绝
    expect(isUserRejected({ code: 'TRANSACTION_REPLACED', reason: 'cancelled', message: 'transaction was replaced' })).toBe(false)
    expect(isUserRejected(new Error('Request cancelled by timeout'))).toBe(false)
  })
})

describe('toWalletError', () => {
  it.each([
    [{ code: -32002, message: 'Already processing' }, 'pending_request'],
    [{ code: 4200, message: 'Unsupported method' }, 'unsupported'],
    [{ code: 4901, message: 'Chain disconnected' }, 'unsupported_chain'],
    [{ code: 4902, message: 'Unrecognized chain' }, 'unsupported_chain'],
    [{ error: { code: -32002 } }, 'pending_request'],
    [Object.assign(new Error('not found'), { name: 'WalletNotFoundError' }), 'not_installed'],
    [new Error('boom'), 'unknown'],
  ] as const)('%o → %s', (err, code) => {
    const mapped = toWalletError(err)
    expect(mapped.code).toBe(code)
    expect(mapped.cause).toBe(err)
  })

  it('已经是 WalletError 的原样返回；没有消息时用 fallback；字符串错误用作消息', () => {
    const original = new WalletError('not_connected', 'x')
    expect(toWalletError(original)).toBe(original)
    expect(toWalletError({}, 'Failed to sign').message).toBe('Failed to sign')
    expect(toWalletError(undefined).message).toBe('Wallet request failed')
    expect(toWalletError('rpc down').message).toBe('rpc down')
    expect(toWalletError({ code: 4200 }).message).toBe('The wallet does not support this method')
    expect(toWalletError({ code: 4902 }).message).toBe('The wallet does not support this chain')
    // 普通对象（不是 Error）的 message 也保留
    expect(toWalletError({ code: 4001, message: 'User rejected the request.' }).message).toBe('User rejected the request.')
    expect(toWalletError({ code: -1, message: 'execution reverted' })).toMatchObject({ code: 'unknown', message: 'execution reverted' })
  })
})

describe('编码', () => {
  it('base58 / hex / base64；签名可能是 Uint8Array、number[] 或别的', () => {
    expect(base58(new Uint8Array([1, 2, 3]))).toBe('Ldp')
    expect(base58(new Uint8Array([0, 0, 1, 2, 3]))).toBe('11Ldp')
    expect(base58(new Uint8Array())).toBe('')
    expect(hex(new Uint8Array([0, 255]))).toBe('0x00ff')
    expect(base64(new Uint8Array([104, 105]))).toBe('aGk=')
    expect(toBytes([1, 2])).toEqual(new Uint8Array([1, 2]))
    expect(toBytes(['a'])).toBeNull()
    expect(toBytes('abc')).toBeNull()
  })
})

describe('移动端的默认值', () => {
  it('默认用当前页面；Trust 默认 coin_id 60；TokenPocket 不传 chain 时不带；url 不合法时 ref 用原文', () => {
    vi.stubGlobal('location', { href: 'https://dapp.example/path' })
    expect(openInWalletUrl('metamask')).toBe('https://link.metamask.io/dapp/dapp.example/path')
    expect(openInWalletUrl('trust')).toContain('coin_id=60&')
    const tp = new URL(openInWalletUrl('tokenpocket'))
    expect(JSON.parse(tp.searchParams.get('params')!)).toEqual({ url: 'https://dapp.example/path', source: 'https://dapp.example' })
    expect(openInWalletUrl('phantom', 'not a url')).toBe(`https://phantom.app/ul/browse/not%20a%20url?ref=not%20a%20url`)
  })

  it('不传 userAgent 时读 navigator；没有 navigator / location（SSR）时不报错', () => {
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (iPhone)' })
    expect(isMobileBrowser()).toBe(true)
    vi.stubGlobal('navigator', undefined)
    vi.stubGlobal('location', undefined)
    expect(isMobileBrowser()).toBe(false)
    expect(openInWalletUrl('bitget')).toBe('https://bkcode.vip?action=dapp&url=')
  })
})
