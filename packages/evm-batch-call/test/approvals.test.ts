/** 授权管理：撤销交易的编码、已知被授权方的列表（不连网络） */
import { Interface } from 'ethers'
import { describe, expect, it } from 'vitest'

import { TRON_CHAIN_ID } from '../src/index.js'
import { PERMIT2_ADDRESS, buildRevokes, knownSpenders, type Approval } from '../src/subpaths/approvals.js'

const USDT = '0x55d398326f99059fF775485246999027B3197955'
const CAKE = '0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82'
const ROUTER = '0x10ED43C718714eb63d5aA57B78B54704E256024E'
const NFT = '0x46A15B0b27311cedF172AB29E4f4766fbE7F4364'
const base = { symbol: null, decimals: 18, formatted: '1', unlimited: false, spenderName: null }

const iface = new Interface([
  'function approve(address spender, uint256 amount)',
  'function lockdown((address token, address spender)[] approvals)',
  'function setApprovalForAll(address operator, bool approved)',
])

describe('buildRevokes', () => {
  it('ERC20 每个一笔 approve 0，Permit2 合成一笔 lockdown，NFT 每个一笔 setApprovalForAll(false)', () => {
    const list: Approval[] = [
      { type: 'erc20', token: USDT, spender: ROUTER, amount: '5', ...base },
      { type: 'permit2', token: USDT, spender: ROUTER, amount: '5', expiration: 9e9, expired: false, nonce: 0, ...base },
      { type: 'permit2', token: CAKE, spender: ROUTER, amount: '5', expiration: 9e9, expired: false, nonce: 1, ...base },
      { type: 'nft', collection: NFT, spender: ROUTER, spenderName: null, approved: true },
    ]
    const txs = buildRevokes(list, 56)
    expect(txs.map((t) => [t.kind, t.to, t.approvals.length])).toEqual([
      ['approve', USDT, 1],
      ['setApprovalForAll', NFT, 1],
      ['lockdown', PERMIT2_ADDRESS, 2],
    ])
    expect(iface.decodeFunctionData('approve', txs[0]?.data as string).toArray()).toEqual([ROUTER, 0n])
    expect(iface.decodeFunctionData('setApprovalForAll', txs[1]?.data as string).toArray()).toEqual([ROUTER, false])
    const [pairs] = iface.decodeFunctionData('lockdown', txs[2]?.data as string).toArray() as [Array<[string, string]>]
    expect(pairs.map((p) => [...p])).toEqual([
      [USDT, ROUTER],
      [CAKE, ROUTER],
    ])
  })

  it('Tron：交易发给 T 地址，参数里是 0x 地址', () => {
    const [tx] = buildRevokes([{ type: 'erc20', token: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', spender: 'TKzxdSv2FZKQrEqkKVgp5DcwEXBEKMg2Ax', amount: '1', ...base }], TRON_CHAIN_ID.mainnet)
    expect(tx?.to).toBe('TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t')
    expect((iface.decodeFunctionData('approve', tx?.data as string)[0] as string).toLowerCase()).toMatch(/^0x[0-9a-f]{40}$/)
  })
})

describe('knownSpenders', () => {
  it('包含协议表的 Router / 仓位合约和聚合器，不重复；Tron 上没有 Permit2', () => {
    const bsc = knownSpenders(56)
    expect(bsc.some((s) => s.address === ROUTER && s.name === 'PancakeSwap V2 Router')).toBe(true)
    expect(bsc.some((s) => s.address === PERMIT2_ADDRESS)).toBe(true)
    expect(new Set(bsc.map((s) => `${s.kind}:${s.address.toLowerCase()}`)).size).toBe(bsc.length)
    const tron = knownSpenders(TRON_CHAIN_ID.mainnet)
    expect(tron.length).toBeGreaterThan(0)
    expect(tron.some((s) => s.address === PERMIT2_ADDRESS)).toBe(false)
  })
})
