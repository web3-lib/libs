import { describe, expect, it } from 'vitest'

import * as chains from '../src/chains/index.js'
import { createWallet } from '../src/index.js'
import { evm } from '../src/evm/index.js'
import { FakeEvmProvider, announce, stubWindow } from './fakes.js'

describe('内置的链', () => {
  it('每条链信息完整：id 不重复、https 的节点和浏览器、原生币 18 位', () => {
    const list = Object.values(chains)
    expect(list.length).toBeGreaterThanOrEqual(12)
    expect(new Set(list.map((c) => c.id)).size).toBe(list.length)
    for (const chain of list) {
      expect(chain.name).toBeTruthy()
      expect(chain.rpcUrls[0]).toMatch(/^https:\/\//)
      expect(chain.blockExplorerUrls?.[0]).toMatch(/^https:\/\//)
      expect(chain.nativeCurrency.decimals).toBe(18)
    }
    expect([chains.ethereum.id, chains.bsc.id, chains.polygon.id, chains.arbitrum.id, chains.optimism.id, chains.base.id]).toEqual([1, 56, 137, 42161, 10, 8453])
  })

  it('直接传给 evm({ chains })：钱包没有这条链时按它添加', async () => {
    const win = stubWindow()
    const provider = new FakeEvmProvider({ chains: [1] })
    announce(win, provider, { rdns: 'io.metamask', name: 'MetaMask' })
    const wallet = createWallet({ connectors: [evm({ chains: [chains.ethereum, chains.base] })], storage: null, autoConnect: false })
    await wallet.connect('evm', 'io.metamask')
    await wallet.switchChain(chains.base.id)
    const add = provider.calls.find((c) => c.method === 'wallet_addEthereumChain')
    expect((add?.params as unknown[])[0]).toMatchObject({ chainId: '0x2105', chainName: 'Base', rpcUrls: chains.base.rpcUrls, blockExplorerUrls: ['https://basescan.org'] })
    expect(wallet.chainId).toBe(8453)
  })
})
