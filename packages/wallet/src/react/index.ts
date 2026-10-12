import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'

import type { WalletGroup } from '../core/groups.js'
import type { WalletManager } from '../core/manager.js'
import type { Namespace, WalletOption, WalletState } from '../core/types.js'

/** 链的过滤条件 → 可比较的 key（null 表示不过滤；'' 表示空数组） */
const chainsKey = (chains?: Namespace | readonly Namespace[]): string | null => (chains === undefined ? null : typeof chains === 'string' ? chains : chains.join(','))
const chainsOf = (key: string | null): Namespace[] | undefined => (key === null ? undefined : key ? (key.split(',') as Namespace[]) : [])

/** 服务端渲染 / hydration 时的状态：还不知道有没有连接（必须每次是同一个对象） */
const SERVER_STATE: WalletState = Object.freeze({ connection: null, address: null, connections: {}, active: null, status: 'restoring' })

/**
 * React hook：钱包状态，变化时重新渲染。服务端渲染和 hydration 时是 status: 'restoring'、没有连接，
 * 不会和客户端不一致；hydration 之后换成真实状态。
 *
 * ```tsx
 * const { address, connected, status } = useWallet(wallet)
 * ```
 */
export function useWallet(wallet: WalletManager): WalletState & { connected: boolean } {
  const state = useSyncExternalStore(wallet.subscribe, wallet.getState, () => SERVER_STATE)
  return useMemo(() => ({ ...state, connected: state.connection !== null }), [state])
}

/**
 * React hook：钱包列表（可按链过滤），插件晚注入、SDK 加载完、连接 / 断开时重新渲染。每项可以直接 item.connect()。
 * 第一次渲染（包括服务端）是空数组，挂载后填上。
 *
 * ```tsx
 * const wallets = useWallets(wallet, 'evm')
 * wallets.map((item) => <button key={item.id} onClick={() => item.connect()}>{item.name}</button>)
 * ```
 */
export function useWallets(wallet: WalletManager, chains?: Namespace | readonly Namespace[]): WalletOption[] {
  const [list, setList] = useState<WalletOption[]>([])
  // 数组每次渲染都是新的：按内容比较
  const key = chainsKey(chains)
  useEffect(() => wallet.watchWallets(setList, chainsOf(key)), [wallet, key])
  return list
}

/**
 * React hook：按钱包合并的列表（先选钱包，再选链），同一个插件在各条链上合成一项，带 chains / installedChains 和 connect(namespace?)。
 * 第一次渲染（包括服务端）是空数组，挂载后填上。
 */
export function useWalletGroups(wallet: WalletManager, chains?: Namespace | readonly Namespace[]): WalletGroup[] {
  const [groups, setGroups] = useState<WalletGroup[]>([])
  const key = chainsKey(chains)
  useEffect(() => wallet.watchWalletGroups(setGroups, chainsOf(key)), [wallet, key])
  return groups
}
