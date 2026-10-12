// @vitest-environment happy-dom
import { createElement, act } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToString } from 'react-dom/server'
import { afterEach, describe, expect, it } from 'vitest'
import { effectScope, nextTick } from 'vue'

import { createWallet, type Connector, type Namespace, type Session, type WalletOption } from '../src/index.js'
import { useWallet as useReactWallet, useWalletGroups as useReactWalletGroups, useWallets as useReactWallets } from '../src/react/index.js'
import { useWallet as useVueWallet, useWalletGroups as useVueWalletGroups, useWallets as useVueWallets } from '../src/vue/index.js'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/** 最小的连接器：一个钱包，可以手动触发列表变化 */
function connector(namespace: Namespace) {
  const listeners = new Set<() => void>()
  const names = ['A']
  const c: Connector & { add(name: string): void } = {
    namespace,
    wallets: () => names.map((name) => ({ id: name, namespace, name, icon: null, type: 'injected' as const, installed: true, downloadUrl: null })),
    watchWallets: (l) => (listeners.add(l), () => listeners.delete(l)),
    connect: async (walletId): Promise<Session> => ({
      walletId,
      walletName: walletId,
      icon: null,
      address: `${namespace}-${walletId}`,
      chainId: 1,
      provider: {},
      subscribe: () => () => {},
      signMessage: async () => '',
      disconnect: async () => {},
    }),
    restore: async () => null,
    add(name) {
      names.push(name)
      listeners.forEach((l) => l())
    },
  }
  return c
}

let cleanup: Array<() => void> = []
afterEach(() => {
  cleanup.forEach((fn) => fn())
  cleanup = []
})

describe('Vue', () => {
  it('useWallet：状态变化时 ref 更新；作用域结束后取消订阅', async () => {
    const wallet = createWallet({ connectors: [connector('evm')], storage: null, autoConnect: false })
    const scope = effectScope()
    const result = scope.run(() => useVueWallet(wallet))!
    expect([result.address.value, result.connected.value, result.status.value]).toEqual([null, false, 'ready'])
    await wallet.connect('evm', 'A')
    await nextTick()
    expect([result.address.value, result.connected.value, result.chainId.value]).toEqual(['evm-A', true, 1])
    expect(result.connection.value?.walletId).toBe('A')
    scope.stop()
    await wallet.disconnect()
    expect(result.address.value).toBe('evm-A')
  })

  it('useWallets：按链过滤，列表变化和连接状态都会更新', async () => {
    const evm = connector('evm')
    const wallet = createWallet({ connectors: [evm, connector('solana')], storage: null, autoConnect: false })
    const scope = effectScope()
    const list = scope.run(() => useVueWallets(wallet, 'evm'))!
    expect(list.value.map((w) => w.id)).toEqual(['A'])
    evm.add('B')
    expect(list.value.map((w) => w.id)).toEqual(['A', 'B'])
    await list.value[1]!.connect()
    expect(list.value.find((w) => w.id === 'B')?.connected).toBe(true)
    scope.stop()
  })
})

describe('React', () => {
  function render(element: ReturnType<typeof createElement>) {
    const container = document.createElement('div')
    const root = createRoot(container)
    act(() => root.render(element))
    cleanup.push(() => act(() => root.unmount()))
    return container
  }

  it('useWallet / useWallets：渲染、变化后重新渲染；按链过滤', async () => {
    const evm = connector('evm')
    const wallet = createWallet({ connectors: [evm, connector('solana')], storage: null, autoConnect: false })
    let items: WalletOption[] = []
    function View() {
      const { address, connected } = useReactWallet(wallet)
      items = useReactWallets(wallet, ['evm'])
      return createElement('p', null, `${connected}:${address}:${items.map((w) => w.id).join(',')}`)
    }
    const el = render(createElement(View))
    expect(el.textContent).toBe('false:null:A')
    act(() => evm.add('B'))
    expect(el.textContent).toBe('false:null:A,B')
    await act(async () => {
      await items[1]!.connect()
    })
    expect(el.textContent).toBe('true:evm-B:A,B')
  })

  it('服务端渲染：status 是 restoring、没有连接，钱包列表是空的（和客户端 hydration 时一致）', () => {
    const wallet = createWallet({ connectors: [connector('evm')], storage: null, autoConnect: false })
    function View() {
      const { status, address } = useReactWallet(wallet)
      const list = useReactWallets(wallet)
      return createElement('p', null, `${status}:${address}:${list.length}`)
    }
    expect(renderToString(createElement(View))).toBe('<p>restoring:null:0</p>')
  })
})

describe('Vue 的 SSR 选项', () => {
  it('ssr: true 在组件里先用和服务端一样的状态，挂载后换成真实状态', async () => {
    const { createApp, defineComponent, h } = await import('vue')
    const wallet = createWallet({ connectors: [connector('evm')], storage: null, autoConnect: false })
    await wallet.connect('evm', 'A')
    const seen: string[] = []
    const App = defineComponent({
      setup() {
        const { status, address } = useVueWallet(wallet, { ssr: true })
        const list = useVueWallets(wallet, 'evm', { ssr: true })
        return () => {
          seen.push(`${status.value}:${address.value}:${list.value.length}`)
          return h('p')
        }
      },
    })
    const el = document.createElement('div')
    const app = createApp(App)
    app.mount(el)
    await nextTick()
    expect(seen[0]).toBe('restoring:null:0')
    expect(seen.at(-1)).toBe('ready:evm-A:1')
    app.unmount()
  })
})

describe('useWalletGroups', () => {
  it('Vue / React：按钱包合并的列表，连接后更新', async () => {
    const wallet = createWallet({ connectors: [connector('evm'), connector('solana')], storage: null, autoConnect: false, mode: 'multi' })
    const scope = effectScope()
    const groups = scope.run(() => useVueWalletGroups(wallet))!
    expect(groups.value.map((g) => [g.id, g.chains])).toEqual([['a', ['evm', 'solana']]])
    await groups.value[0]!.connect('solana')
    expect(groups.value[0]?.connected).toBe(true)
    scope.stop()

    let seen: string[] = []
    function View() {
      seen = useReactWalletGroups(wallet, ['evm', 'solana']).map((g) => `${g.id}:${g.installedChains.join('+')}`)
      return createElement('p')
    }
    const container = document.createElement('div')
    const root = createRoot(container)
    act(() => root.render(createElement(View)))
    expect(seen).toEqual(['a:evm+solana'])
    act(() => root.unmount())
  })
})

describe('React：空数组', () => {
  it('useWallets(wallet, []) 返回空列表（和核心、Vue 一致）', () => {
    const wallet = createWallet({ connectors: [connector('evm')], storage: null, autoConnect: false })
    let seen: WalletOption[] | null = null
    function View() {
      seen = useReactWallets(wallet, [])
      return createElement('p')
    }
    const root = createRoot(document.createElement('div'))
    act(() => root.render(createElement(View)))
    expect(seen).toEqual([])
    act(() => root.unmount())
  })
})
