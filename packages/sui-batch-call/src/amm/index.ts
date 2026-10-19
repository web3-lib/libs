import { dipcoin } from './dipcoin.js'
import { flowxV2 } from './flowxV2.js'
import { kriyaAmm } from './kriya.js'
import type { AmmReader, SuiAmmProtocol } from './types.js'

/** 支持的传统 AMM（读取部分，键是协议名） */
export const AMM_READERS: Readonly<Record<SuiAmmProtocol, AmmReader>> = { dipcoin, 'flowx-v2': flowxV2, 'kriya-amm': kriyaAmm }
