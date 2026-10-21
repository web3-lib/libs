/**
 * 授权管理连主网（只读 + 预估 gas，不发送），默认跳过：`LIVE=1 NODE_USE_ENV_PROXY=1 npx vitest run test/approvals-live.test.ts`
 * 从最近的区块里找真实的授权事件（ERC20 Approval、Permit2 Permit），核对 approvals / scanApprovals / 撤销的预估
 */
import { Contract, JsonRpcProvider } from 'ethers'
import { describe, expect, it } from 'vitest'

import { Provider, TRON_CHAIN_ID } from '../src/index.js'
import { PERMIT2_ADDRESS, approvals, buildRevokes, knownSpenders, revokeApprovals, scanApprovals, type Approval } from '../src/subpaths/approvals.js'

const live = process.env.LIVE ? describe : describe.skip
/** 扫描要按 owner 查全部合约的事件：publicnode 等节点要求 getLogs 带合约地址，这里用不限制的公共节点 */
const RPCS = process.env.ETH_RPC ? [process.env.ETH_RPC] : ['https://eth.drpc.org', 'https://1rpc.io/eth', 'https://rpc.flashbots.net']
const APPROVAL = '0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925'
const APPROVAL_FOR_ALL = '0x17307eab39ab6107e8899845ad3d59bd9653f200f220920489ca2b5937696c31'
const PERMIT = '0xc6a377bfc4eb120024a8ac08eef205be16b817020812c73223e81d1bdb9708ec'
const addr = (topic: string) => `0x${topic.slice(26)}`

const watchOnly = (address: string) => ({ getAddress: async () => address, sendTransaction: async (): Promise<{ hash: string }> => Promise.reject(new Error('watch-only')) })

live('授权管理（Ethereum 主网）', { timeout: 180_000 }, () => {
  const rpc = new JsonRpcProvider(RPCS[0], 1, { staticNetwork: true })
  const provider = new Provider(1, RPCS)

  it('ERC20：最近的 Approval 事件 → approvals 的额度和合约一致，scanApprovals 能发现，撤销能预估', async () => {
    const latest = await rpc.getBlockNumber()
    const logs = (await rpc.getLogs({ fromBlock: latest - 30, toBlock: latest, topics: [APPROVAL] })).filter((l) => l.topics.length === 3 && BigInt(l.data) > 0n)
    // 找一个额度还在的（可能已经被花掉一部分）
    let found: { owner: string; token: string; spender: string; block: number; list: Approval[] } | null = null
    for (const log of logs.slice(0, 40)) {
      const owner = addr(log.topics[1] as string)
      const spender = addr(log.topics[2] as string)
      const list = await approvals(provider, owner, { pairs: [{ token: log.address, spender }], spenders: [], permit2: false })
      if (list.length) {
        found = { owner, token: log.address, spender, block: log.blockNumber, list }
        break
      }
    }
    if (!found) throw new Error('no live approval found in the last 30 blocks')
    const [a] = found.list
    const onchain = await new Contract(found.token, ['function allowance(address,address) view returns (uint256)'], rpc).getFunction('allowance')(found.owner, found.spender)
    expect(a).toMatchObject({ type: 'erc20', amount: onchain.toString() })

    const scan = await scanApprovals(provider, found.owner, { fromBlock: found.block, blockRange: 50 })
    expect(scan.pairs).toContainEqual({ token: found.token.toLowerCase(), spender: found.spender.toLowerCase() })
    expect(scan.cursor).toBeGreaterThanOrEqual(found.block)

    const [tx] = buildRevokes(found.list, 1)
    expect(tx).toMatchObject({ kind: 'approve', to: found.token })
    const [r] = await revokeApprovals(provider, watchOnly(found.owner), found.list, { dryRun: true })
    expect([r?.status, r?.error ?? null]).toEqual(['simulated', null])
  })

  it('Permit2：最近的 Permit 事件 → approvals 有额度和过期时间，lockdown 能预估', async () => {
    const latest = await rpc.getBlockNumber()
    const logs = await rpc.getLogs({ address: PERMIT2_ADDRESS, fromBlock: latest - 100, toBlock: latest, topics: [PERMIT] })
    let found: { owner: string; list: Approval[]; block: number } | null = null
    for (const log of logs.reverse().slice(0, 30)) {
      const owner = addr(log.topics[1] as string)
      const list = (await approvals(provider, owner, { pairs: [{ token: addr(log.topics[2] as string), spender: addr(log.topics[3] as string) }], spenders: [] })).filter((x) => x.type === 'permit2')
      if (list.length) {
        found = { owner, list, block: log.blockNumber }
        break
      }
    }
    if (!found) throw new Error('no live Permit2 allowance found')
    const [p] = found.list
    expect(p?.type === 'permit2' && p.expiration > Date.now() / 1000).toBe(true)
    const scan = await scanApprovals(provider, found.owner, { fromBlock: found.block, blockRange: 50 })
    expect(scan.pairs.length).toBeGreaterThan(0)
    const [r] = await revokeApprovals(provider, watchOnly(found.owner), found.list, { dryRun: true })
    expect([r?.kind, r?.status, r?.error ?? null]).toEqual(['lockdown', 'simulated', null])
  })

  it('默认检查已知的被授权方（一次 multicall）', async () => {
    const latest = await rpc.getBlockNumber()
    const logs = (await rpc.getLogs({ fromBlock: latest - 10, toBlock: latest, topics: [APPROVAL] })).filter((l) => l.topics.length === 3)
    const owner = addr(logs[0]?.topics[1] as string)
    const list = await approvals(provider, owner, { tokens: [...new Set(logs.map((l) => l.address))].slice(0, 20), includeZero: true })
    // includeZero：每个 代币 × 已知被授权方 都有一项 ERC20 和一项 Permit2
    const spenders = knownSpenders(1).filter((s) => s.kind === 'erc20').length
    expect(list.filter((x) => x.type === 'erc20').length).toBeGreaterThan(0)
    expect(list.filter((x) => x.type === 'permit2').length).toBeLessThanOrEqual(spenders * 20)
    expect(list.every((x) => x.spenderName !== null)).toBe(true)
  })

  it('NFT：最近的 ApprovalForAll 事件 → approvals 返回 approved，撤销能预估', async () => {
    const latest = await rpc.getBlockNumber()
    const logs = (await rpc.getLogs({ fromBlock: latest - 100, toBlock: latest, topics: [APPROVAL_FOR_ALL] })).filter((l) => BigInt(l.data) === 1n)
    let found: { owner: string; list: Approval[] } | null = null
    for (const log of logs.reverse().slice(0, 20)) {
      const owner = addr(log.topics[1] as string)
      const list = await approvals(provider, owner, { nftPairs: [{ collection: log.address, operator: addr(log.topics[2] as string) }], spenders: [] })
      if (list.length) {
        found = { owner, list }
        break
      }
    }
    if (!found) throw new Error('no live ApprovalForAll found')
    expect(found.list[0]).toMatchObject({ type: 'nft', approved: true })
    const [r] = await revokeApprovals(provider, watchOnly(found.owner), found.list, { dryRun: true })
    expect([r?.kind, r?.status, r?.error ?? null]).toEqual(['setApprovalForAll', 'simulated', null])
  })
})

live('授权管理（Tron 主网）', { timeout: 120_000 }, () => {
  it('SunSwap 的 Router / 仓位合约：读额度（T 地址），撤销能模拟', async () => {
    const provider = new Provider(TRON_CHAIN_ID.mainnet)
    const owner = 'TW7igRFaUUFWNuwsuVw1xiMQcDf4pf7SWe'
    const tokens = ['TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', 'TNUC9Qb1rRpS5CbWLmNMxXBjyFoydXjWFR', 'TSSMHYeV2uE9qYH95DqyoCuNCzEL1NvU3S']
    const all = await approvals(provider, owner, { tokens, includeZero: true })
    expect(all.length).toBe(tokens.length * knownSpenders(TRON_CHAIN_ID.mainnet).length)
    expect(all.every((a) => a.type === 'erc20' && a.spenderName !== null)).toBe(true)
    const active = all.filter((a) => a.type === 'erc20' && a.amount !== '0')
    if (!active.length) return
    const [tx] = buildRevokes(active, TRON_CHAIN_ID.mainnet)
    expect(tx?.to.startsWith('T')).toBe(true)
    const [r] = await revokeApprovals(provider, { address: owner, signTransaction: async () => Promise.reject(new Error('watch-only')) }, active.slice(0, 1), { dryRun: true })
    expect([r?.status, r?.error ?? null]).toEqual(['simulated', null])
  })
})
