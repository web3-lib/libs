import { computed, getCurrentInstance, getCurrentScope, onMounted, onScopeDispose, shallowRef, type ComputedRef, type ShallowRef } from 'vue'

import type { WalletGroup } from '../core/groups.js'
import type { WalletManager } from '../core/manager.js'
import type { ChainId, Connection, Namespace, WalletOption, WalletState } from '../core/types.js'

export interface UseWalletOptions {
  /**
   * 服务端渲染（Nuxt 等）时设为 true：从和服务端一样的初始状态开始（status: 'restoring'、没有连接、钱包列表为空），
   * 组件挂载后再换成真实状态，避免 hydration 不一致。不用 SSR 时不需要（否则每次挂载会先显示一下“恢复中”）
   */
  ssr?: boolean
}

/** 服务端渲染时的状态 */
const SERVER_STATE: WalletState = Object.freeze({ connection: null, address: null, connections: {}, active: null, status: 'restoring' })

/**
 * 订阅：在组件里且开了 ssr 时等挂载后再开始；作用域结束时取消。
 * 服务端（没有 window）不订阅：每个请求都会留下一个监听
 */
function track(start: () => () => void, ssr: boolean) {
  if (typeof window === 'undefined') return
  let stop: (() => void) | null = null
  const run = () => (stop = start())
  if (ssr && getCurrentInstance()) onMounted(run)
  else run()
  if (getCurrentScope()) onScopeDispose(() => stop?.())
}

export interface UseWallet {
  /** 整个状态（每次变化是新对象） */
  state: Readonly<ShallowRef<WalletState>>
  /** 当前钱包的地址，没连接时为 null */
  address: ComputedRef<string | null>
  /** 当前钱包的连接 */
  connection: ComputedRef<Connection | null>
  connected: ComputedRef<boolean>
  chainId: ComputedRef<ChainId | null>
  /** 'restoring'：刷新后正在恢复上次的连接；'ready'：恢复完了 */
  status: ComputedRef<WalletState['status']>
}

/**
 * Vue 组合式函数：钱包状态，变化时自动更新。在 setup / effectScope 里调用，组件卸载时自动取消订阅。
 * 服务端渲染时不订阅（服务端没有钱包），状态是 status: 'restoring'、没有连接；Nuxt 等 SSR 应用传 { ssr: true }。
 *
 * ```ts
 * const { address, connected, status } = useWallet(wallet)
 * ```
 */
export function useWallet(wallet: WalletManager, options: UseWalletOptions = {}): UseWallet {
  const ssr = options.ssr === true
  const state = shallowRef(ssr || typeof window === 'undefined' ? SERVER_STATE : wallet.getState())
  track(() => {
    state.value = wallet.getState()
    return wallet.subscribe((next) => (state.value = next))
  }, ssr)
  return {
    state,
    address: computed(() => state.value.address),
    connection: computed(() => state.value.connection),
    connected: computed(() => state.value.connection !== null),
    chainId: computed(() => state.value.connection?.chainId ?? null),
    status: computed(() => state.value.status),
  }
}

/**
 * Vue 组合式函数：钱包列表（可按链过滤），插件晚注入、SDK 加载完、连接 / 断开时自动更新。每项可以直接 item.connect()。
 *
 * ```vue
 * <button v-for="item in useWallets(wallet, 'evm').value" :key="item.id" @click="item.connect()">{{ item.name }}</button>
 * ```
 */
export function useWallets(wallet: WalletManager, chains?: Namespace | readonly Namespace[], options: UseWalletOptions = {}): Readonly<ShallowRef<WalletOption[]>> {
  const list = shallowRef<WalletOption[]>([])
  track(() => wallet.watchWallets((next) => (list.value = next), chains), options.ssr === true)
  return list
}

/**
 * Vue 组合式函数：按钱包合并的列表（先选钱包，再选链），同一个插件在各条链上合成一项，带 chains / installedChains 和 connect(namespace?)。
 *
 * ```vue
 * <button v-for="group in useWalletGroups(wallet).value" :key="group.id" @click="pick(group)">{{ group.name }}</button>
 * ```
 */
export function useWalletGroups(wallet: WalletManager, chains?: Namespace | readonly Namespace[], options: UseWalletOptions = {}): Readonly<ShallowRef<WalletGroup[]>> {
  const groups = shallowRef<WalletGroup[]>([])
  track(() => wallet.watchWalletGroups((next) => (groups.value = next), chains), options.ssr === true)
  return groups
}
