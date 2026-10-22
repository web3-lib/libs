/**
 * 助记词 → 各链地址 → 多链总览（子路径 `@w3lib/overview/mnemonic`）。只在本地推导，返回值只有地址和派生路径；
 * 不从主入口导出，只用 getOverview 时打包不会带上这里的加密库。
 *
 * ```ts
 * import { deriveAddresses, getDerivedOverview } from '@w3lib/overview/mnemonic'
 *
 * const a = await deriveAddresses(mnemonic, { accounts: 3 })
 * const r = await getDerivedOverview(a, { evm: { chains: [1, 56] }, loaders })      // 或一步：getOverviewFromMnemonic(mnemonic, { accounts: 3, … })
 * ```
 */
export {
  DERIVATION_PATHS,
  MAX_ACCOUNTS,
  MNEMONIC_CHAINS,
  TON_MNEMONIC_PATH,
  deriveAddresses,
  getDerivedOverview,
  getOverviewFromMnemonic,
  type AccountOverview,
  type DeriveOptions,
  type DerivedOverviewOptions,
  type DerivedAddresses,
  type MnemonicChain,
  type MnemonicOverview,
  type MnemonicOverviewOptions,
  type TonDerived,
  type TonQueried,
  type TonWalletVersion,
} from '../mnemonic.js'
