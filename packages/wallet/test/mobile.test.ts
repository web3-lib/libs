import { describe, expect, it } from 'vitest'

import { isMobileBrowser, openInWalletUrl } from '../src/index.js'

const URL_ = 'https://app.example.com/swap?a=1&b=%20'

describe('在钱包 App 里打开', () => {
  it('各钱包的链接格式（与官方文档一致）', () => {
    expect(openInWalletUrl('metamask', URL_)).toBe('https://link.metamask.io/dapp/app.example.com/swap?a=1&b=%20')
    expect(openInWalletUrl('okx', URL_)).toBe(`https://www.okx.com/download?deeplink=${encodeURIComponent(`okx://wallet/dapp/url?dappUrl=${encodeURIComponent(URL_)}`)}`)
    expect(openInWalletUrl('bitget', URL_)).toBe(`https://bkcode.vip?action=dapp&url=${encodeURIComponent(URL_)}`)
    expect(openInWalletUrl('trust', URL_, { trustCoinId: 714 })).toBe(`https://link.trustwallet.com/open_url?coin_id=714&url=${encodeURIComponent(URL_)}`)
    expect(openInWalletUrl('coinbase', URL_)).toBe(`https://go.cb-w.com/dapp?cb_url=${encodeURIComponent(URL_)}`)
    expect(openInWalletUrl('phantom', URL_)).toBe(`https://phantom.app/ul/browse/${encodeURIComponent(URL_)}?ref=${encodeURIComponent('https://app.example.com')}`)
    expect(openInWalletUrl('solflare', URL_, { ref: 'https://ref.example' })).toBe(`https://solflare.com/ul/v1/browse/${encodeURIComponent(URL_)}?ref=${encodeURIComponent('https://ref.example')}`)
    const tp = new URL(openInWalletUrl('tokenpocket', URL_, { chain: 'BSC' }))
    expect(tp.protocol).toBe('tpdapp:')
    expect(JSON.parse(tp.searchParams.get('params')!)).toEqual({ url: URL_, chain: 'BSC', source: 'https://app.example.com' })
    const tl = new URL(openInWalletUrl('tronlink', URL_))
    expect(JSON.parse(tl.searchParams.get('param')!)).toEqual({ url: URL_, action: 'open', protocol: 'TronLink', version: '1.0' })
  })

  it('识别手机浏览器', () => {
    expect(isMobileBrowser('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)')).toBe(true)
    expect(isMobileBrowser('Mozilla/5.0 (Linux; Android 14; Pixel 8)')).toBe(true)
    expect(isMobileBrowser('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')).toBe(false)
  })
})
