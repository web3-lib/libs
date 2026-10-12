/**
 * 移动端：手机浏览器里没有插件钱包，常见做法是跳到钱包 App 的内置浏览器打开当前页面（那里有注入的钱包，可以直接连接），
 * 或者用 WalletConnect / TON Connect 扫码。这里生成各钱包“在 App 里打开”的链接（格式来自各钱包的官方文档）
 */
export type DeepLinkWallet = 'metamask' | 'okx' | 'bitget' | 'trust' | 'coinbase' | 'tokenpocket' | 'phantom' | 'solflare' | 'tronlink'

export interface DeepLinkOptions {
  /** 请求方的地址（Phantom / Solflare 要求），默认页面的 origin */
  ref?: string
  /** Trust Wallet 打开时的网络（SLIP-44 编号），默认 60（Ethereum） */
  trustCoinId?: number
  /** TokenPocket 打开时的网络，如 'ETH'、'BSC'、'TRON'、'SOL' */
  chain?: string
}

const enc = encodeURIComponent

/**
 * 在钱包 App 的内置浏览器里打开 url（默认当前页面）的链接。没装 App 时，https 的链接会跳到下载页；
 * tokenpocket / tronlink 只有自定义协议，没装时没有反应。
 *
 * ```ts
 * if (isMobileBrowser() && !wallet.wallets('evm').some((w) => w.installed)) location.href = openInWalletUrl('metamask')
 * ```
 */
export function openInWalletUrl(wallet: DeepLinkWallet, url = currentUrl(), options: DeepLinkOptions = {}): string {
  const ref = options.ref ?? originOf(url)
  switch (wallet) {
    case 'metamask':
      // https://docs.metamask.io/metamask-connect/evm/guides/metamask-exclusive/use-deeplinks/：dapp 地址不带协议
      return `https://link.metamask.io/dapp/${url.replace(/^https?:\/\//, '')}`
    case 'okx':
      // OKX App universal link：deeplink 参数里的 dappUrl 先编码一次，整个 deeplink 再编码一次
      return `https://www.okx.com/download?deeplink=${enc(`okx://wallet/dapp/url?dappUrl=${enc(url)}`)}`
    case 'bitget':
      // https://web3.bitget.com/zh-CN/docs/configuration/deeplink/
      return `https://bkcode.vip?action=dapp&url=${enc(url)}`
    case 'trust':
      // https://developer.trustwallet.com/developer/develop-for-trust/deeplinking
      return `https://link.trustwallet.com/open_url?coin_id=${options.trustCoinId ?? 60}&url=${enc(url)}`
    case 'coinbase':
      // https://docs.cdp.coinbase.com/wallet-sdk/docs/deep-link
      return `https://go.cb-w.com/dapp?cb_url=${enc(url)}`
    case 'tokenpocket':
      // https://help.tokenpocket.pro/developer-en/wallet/pull-up-wallet-with-deeplink
      return `tpdapp://open?params=${enc(JSON.stringify({ url, ...(options.chain ? { chain: options.chain } : {}), source: ref }))}`
    case 'phantom':
      // https://docs.phantom.com/phantom-deeplinks/other-methods/browse
      return `https://phantom.app/ul/browse/${enc(url)}?ref=${enc(ref)}`
    case 'solflare':
      // https://docs.solflare.com/solflare/technical/deeplinks/other-methods/browse
      return `https://solflare.com/ul/v1/browse/${enc(url)}?ref=${enc(ref)}`
    case 'tronlink':
      // https://docs.tronlink.org/mobile/deeplink/
      return `tronlinkoutside://pull.activity?param=${enc(JSON.stringify({ url, action: 'open', protocol: 'TronLink', version: '1.0' }))}`
  }
}

/** 是否是手机 / 平板的浏览器（包括钱包 App 的内置浏览器） */
export function isMobileBrowser(userAgent = typeof navigator === 'undefined' ? '' : navigator.userAgent): boolean {
  return /Android|iPhone|iPad|iPod|Mobile|HarmonyOS/i.test(userAgent)
}

function currentUrl(): string {
  return typeof location === 'undefined' ? '' : location.href
}

function originOf(url: string): string {
  try {
    return new URL(url).origin
  } catch {
    return url
  }
}
