import { bluefin } from './bluefin.js'
import { cetus, magma } from './cetus.js'
import { flowx } from './flowx.js'
import { kriyaClmm, momentum } from './momentum.js'
import { turbos } from './turbos.js'
import type { DexReader, SuiClmmProtocol, SuiLpProtocol } from './types.js'

/** 支持的 DEX（读取部分，键是协议名） */
export const READERS: Readonly<Record<SuiClmmProtocol, DexReader>> = { cetus, bluefin, momentum, turbos, flowx, magma, 'kriya-clmm': kriyaClmm }

/** 选中的集中流动性协议（不传时全部；其他类型的协议忽略） */
export const readerList = (protocols?: readonly SuiLpProtocol[]) =>
  (protocols ?? (Object.keys(READERS) as SuiClmmProtocol[])).map((p) => READERS[p as SuiClmmProtocol]).filter((a): a is DexReader => !!a)
