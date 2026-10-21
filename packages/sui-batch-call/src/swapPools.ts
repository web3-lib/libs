/** 兑换用的池子：按 ID 读出并认出协议（/swap、/risk 用） */
import { normalizeSuiAddress } from './address.js'
import type { SuiClient } from './client.js'
import { AMM_READERS } from './amm/index.js'
import { READERS } from './dex/index.js'
import { isAftermathObject, loadAftermathPool } from './aftermath.js'
import { parseDlmmPool } from './dlmm.js'
import type { SuiObject } from './services.js'
import type { SwapPool } from './swapTx.js'

/** 对象 → 兑换用的池子（暂停 / 没有储备的为 null）；Aftermath 要另外读（DAO 费池子） */
function parse(o: SuiObject): SwapPool | null {
  for (const r of Object.values(READERS)) {
    if (!r.isPool(o.type)) continue
    const pool = r.parsePool(o)
    return pool && !pool.paused ? { protocol: pool.protocol, id: pool.id, coins: [pool.coinA, pool.coinB], fee: pool.fee, data: { kind: 'clmm', pool } } : null
  }
  const dlmm = parseDlmmPool(o)
  if (dlmm) return { protocol: 'cetus-dlmm', id: dlmm.id, coins: [dlmm.coinA, dlmm.coinB], fee: dlmm.fee, data: { kind: 'dlmm', pool: dlmm } }
  for (const r of Object.values(AMM_READERS)) {
    if (!r.isPool(o.type)) continue
    const pool = r.parsePool(o)
    return pool && pool.reserveA > 0n && pool.reserveB > 0n ? { protocol: pool.protocol, id: pool.id, coins: [pool.coinA, pool.coinB], fee: pool.fee, data: { kind: 'amm', pool } } : null
  }
  return null
}

/** 按 ID 读池子（任意支持的 DEX；DLMM 不能交易时、Aftermath 读不出时为 null）；结果与 ids 一一对应 */
export async function loadSwapPools(client: SuiClient, ids: readonly string[], signal?: AbortSignal): Promise<Array<SwapPool | null>> {
  const objects = await client.objects(
    ids.map((id) => normalizeSuiAddress(id)),
    { fields: ['type', 'owner', 'json'], signal },
  )
  return Promise.all(
    objects.map(async (o) => {
      if (!o) return null
      if (isAftermathObject(o.type)) {
        const pool = await loadAftermathPool(client, o.objectId, signal, o)
        return pool && pool.reserves.every((r) => r > 0n) ? { protocol: 'aftermath' as const, id: pool.id, coins: pool.coins, fee: pool.fee, data: { kind: 'multi' as const, pool } } : null
      }
      const p = parse(o)
      // DLMM 暂停交易：permissions.disable_swap
      if (p?.data.kind === 'dlmm' && (o.json as { permissions?: { disable_swap?: boolean } })?.permissions?.disable_swap) return null
      return p
    }),
  )
}
