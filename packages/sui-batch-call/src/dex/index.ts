import { bluefin } from './bluefin.js'
import { cetus, magma } from './cetus.js'
import { flowx } from './flowx.js'
import { momentum } from './momentum.js'
import { turbos } from './turbos.js'
import type { DexReader, SuiLpProtocol } from './types.js'

/** 支持的 DEX（读取部分，键是协议名） */
export const READERS: Readonly<Record<SuiLpProtocol, DexReader>> = { cetus, bluefin, momentum, turbos, flowx, magma }

export const readerList = (protocols?: readonly SuiLpProtocol[]) => (protocols ?? (Object.keys(READERS) as SuiLpProtocol[])).map((p) => READERS[p]).filter((a): a is DexReader => !!a)
