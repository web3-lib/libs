/**
 * Cetus CLMM（主网）：包、共享对象。合约会升级，调用时用包的最新版本（ListPackageVersions 查，进程内缓存 10 分钟）
 */
import type { GrpcTransport } from './grpc.js'
import { listPackageVersions } from './services.js'

export const CETUS = {
  /** CLMM 核心包（原始 id，类型名用它） */
  clmm: '0x1eabed72c53feb3805120a081dc15963c204dc8d091542592abaf7a35689b2fb',
  /** 入口函数（pool_script_v2：开仓、加减流动性、领取） */
  integrate: '0x996c4d9480708fb8b92aa7acf819fb0497b5ec8e65ba06601cae2fb6db3312c3',
  /** integer-mate（I32） */
  integerMate: '0x714a63a0dba6da4f017b42d5d0fb78867f18bcde904868e51d951a5a6f5b7f57',
  globalConfig: { objectId: '0xdaa46292632c3c4d8f31f23ea0f9b36a28ff3677e9684980e4438403a67a3d8f', initialSharedVersion: 1574190n },
  rewarderVault: { objectId: '0xce7bceef26d3ad1f6d9b6f13a953f053e6ed3ca77907516481ce99ae8e588f2b', initialSharedVersion: 1574190n },
} as const

export const CETUS_POSITION_TYPE = `${CETUS.clmm}::position::Position`

/** 包的最新版本缓存多久（毫秒）：DEX 升级后旧版本会被合约的版本检查拒绝，长时间运行的服务要能拿到新版本 */
const LATEST_TTL = 10 * 60_000
const latest = new WeakMap<GrpcTransport, Map<string, { at: number; id: Promise<string> }>>()

/** 包的最新版本（storage id） */
export function latestPackage(t: GrpcTransport, original: string): Promise<string> {
  let byPackage = latest.get(t)
  if (!byPackage) {
    byPackage = new Map()
    latest.set(t, byPackage)
  }
  const cached = byPackage.get(original)
  if (cached && Date.now() - cached.at < LATEST_TTL) return cached.id
  const id = listPackageVersions(t, original).then((versions) => {
    const last = versions.at(-1)
    if (!last) throw new Error(`Package ${original} not found`)
    return last.packageId
  })
  const entry = { at: Date.now(), id }
  // 失败的不缓存
  id.catch(() => {
    if (byPackage.get(original) === entry) byPackage.delete(original)
  })
  byPackage.set(original, entry)
  return id
}
