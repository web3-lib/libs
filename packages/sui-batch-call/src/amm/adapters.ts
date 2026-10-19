/** 传统 AMM 的读取 + 交易：/liquidity 用（只用 /lp 时不会打包交易命令） */
import { dipcoinTx } from './dipcoin.js'
import { flowxV2Tx } from './flowxV2.js'
import { AMM_READERS } from './index.js'
import { kriyaAmmTx } from './kriya.js'
import type { AmmAdapter, AmmWriter, SuiAmmProtocol } from './types.js'

const WRITERS: Readonly<Record<SuiAmmProtocol, AmmWriter>> = { dipcoin: dipcoinTx, 'flowx-v2': flowxV2Tx, 'kriya-amm': kriyaAmmTx }

export const AMM_ADAPTERS = Object.fromEntries(
  (Object.keys(AMM_READERS) as SuiAmmProtocol[]).map((p) => [p, { ...AMM_READERS[p], ...WRITERS[p], packages: [...AMM_READERS[p].packages, ...WRITERS[p].packages] }]),
) as unknown as Readonly<Record<SuiAmmProtocol, AmmAdapter>>

/** 按对象类型找协议：池子、LP 对象（Kriya 的 KriyaLPToken） */
export const ammAdapterForPool = (type: string | null) => Object.values(AMM_ADAPTERS).find((a) => a.isPool(type)) ?? null
export const ammAdapterForHolding = (type: string | null) => Object.values(AMM_ADAPTERS).find((a) => !!a.positionPrefix && !!type?.startsWith(a.positionPrefix)) ?? null
