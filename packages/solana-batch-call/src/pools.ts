/**
 * 按两个 mint 推导池子地址（PDA，不需要 getProgramAccounts）：Raydium CLMM / CPMM 的每个 AmmConfig、Orca 的每个费率档位。
 * 链上价格（/price）和兑换（/swap）共用；Raydium AMM v4 的池子地址要用 OpenBook 市场推导，不在这里
 */
import { decodeAddress, findProgramAddress } from './address.js'
import { ORCA_WHIRLPOOL_PROGRAM_ID, RAYDIUM_CLMM_PROGRAM_ID, RAYDIUM_CPMM_PROGRAM_ID, utf8 } from './lp.js'

export type PdaPoolProtocol = 'raydium-clmm' | 'orca-whirlpool' | 'raydium-cpmm'

/** Orca 默认的 WhirlpoolsConfig */
export const ORCA_WHIRLPOOLS_CONFIG = '2LecshUwdy9xi7meFgHtFJQNSKk4KdTrcpvaB56dP2NQ'
/**
 * 池子 PDA 用到的配置（2026-10 主网实测存在的全部）：
 * - Raydium CLMM / CPMM 的 AmmConfig：PDA ["amm_config", index（u16 大端）]，index 0~20
 * - Orca 的费率档位：普通档位的种子是 tick spacing（1、2、4、8、16、64、96、128、256，32896 为 Splash 池），动态费率档位是 1025~1036
 * Raydium CLMM 用 seed_index 建的自定义池子不在推导范围内
 */
const RAYDIUM_CONFIG_COUNT = 21
const ORCA_FEE_TIERS = [1, 2, 4, 8, 16, 64, 96, 128, 256, 32896, ...Array.from({ length: 12 }, (_, i) => 1025 + i)]

let configs: { clmm: Uint8Array[]; cpmm: Uint8Array[]; orca: Uint8Array } | undefined
function poolConfigs() {
  const derive = (program: string) =>
    Array.from({ length: RAYDIUM_CONFIG_COUNT }, (_, i) => decodeAddress(findProgramAddress([utf8('amm_config'), new Uint8Array([i >> 8, i & 0xff])], program)))
  configs ??= { clmm: derive(RAYDIUM_CLMM_PROGRAM_ID), cpmm: derive(RAYDIUM_CPMM_PROGRAM_ID), orca: decodeAddress(ORCA_WHIRLPOOLS_CONFIG) }
  return configs
}

/** 两个 mint 在这些协议里可能的池子地址（三个程序都要求 mint0 < mint1，按字节比较）；两个 mint 相同时为空 */
export function poolAddresses(mintA: string, mintB: string, protocols: ReadonlySet<PdaPoolProtocol>): Array<{ protocol: PdaPoolProtocol; address: string }> {
  const a = decodeAddress(mintA)
  const b = decodeAddress(mintB)
  const i = a.findIndex((byte, k) => byte !== b[k])
  if (i < 0) return []
  const [m0, m1] = (a[i] as number) < (b[i] as number) ? [a, b] : [b, a]
  const { clmm, cpmm, orca } = poolConfigs()
  const out: Array<{ protocol: PdaPoolProtocol; address: string }> = []
  const add = (protocol: PdaPoolProtocol, seeds: Uint8Array[], program: string) => out.push({ protocol, address: findProgramAddress(seeds, program) })
  if (protocols.has('raydium-clmm')) for (const c of clmm) add('raydium-clmm', [utf8('pool'), c, m0, m1], RAYDIUM_CLMM_PROGRAM_ID)
  if (protocols.has('raydium-cpmm')) for (const c of cpmm) add('raydium-cpmm', [utf8('pool'), c, m0, m1], RAYDIUM_CPMM_PROGRAM_ID)
  if (protocols.has('orca-whirlpool')) for (const t of ORCA_FEE_TIERS) add('orca-whirlpool', [utf8('whirlpool'), orca, m0, m1, new Uint8Array([t & 0xff, t >> 8])], ORCA_WHIRLPOOL_PROGRAM_ID)
  return out
}
