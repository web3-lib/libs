/**
 * 写层的按需加载入口：只读为主的子路径（/rewards、/liquidity）静态引用这里，
 * 签名（BaseWallet / SigningKey）、发送、智能账户等代码只在真正发交易时才加载，不进首屏
 */
import type { Provider } from '../provider.js'
import { isTronChain } from '../tron.js'
import type { SignerInput } from './signer.js'

/** batchCall 所在的模块 */
export function loadBatch(): Promise<typeof import('./batch.js')> {
  return import('./batch.js')
}

/** 签名器的地址（Tron 上为 T 地址），不发交易 */
export async function signerAddressOf(provider: Provider, from: SignerInput): Promise<string> {
  if (isTronChain(await provider.getChainId())) {
    const { tronSignerAddress } = await import('./tron.js')
    return tronSignerAddress(from)
  }
  const { resolveSigner } = await import('./signer.js')
  return (await resolveSigner(from)).address
}
