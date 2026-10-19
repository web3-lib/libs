/** 读取 + 交易：/liquidity 用（只用 /lp 时不会打包交易命令） */
import { bluefinTx } from './bluefin.js'
import { cetusTx, magmaTx } from './cetusTx.js'
import { flowxTx } from './flowx.js'
import { READERS } from './index.js'
import { momentumTx } from './momentum.js'
import { turbosTx } from './turbos.js'
import type { DexAdapter, DexWriter, SuiLpProtocol } from './types.js'

const WRITERS: Readonly<Record<SuiLpProtocol, DexWriter>> = { cetus: cetusTx, bluefin: bluefinTx, momentum: momentumTx, turbos: turbosTx, flowx: flowxTx, magma: magmaTx }

export const ADAPTERS = Object.fromEntries(
  (Object.keys(READERS) as SuiLpProtocol[]).map((p) => [p, { ...READERS[p], ...WRITERS[p], packages: [...READERS[p].packages, ...WRITERS[p].packages] }]),
) as unknown as Readonly<Record<SuiLpProtocol, DexAdapter>>

/** 按对象类型找协议 */
export const adapterForPosition = (type: string | null) => Object.values(ADAPTERS).find((a) => a.positionType === type) ?? null
export const adapterForPool = (type: string | null) => Object.values(ADAPTERS).find((a) => a.isPool(type)) ?? null
