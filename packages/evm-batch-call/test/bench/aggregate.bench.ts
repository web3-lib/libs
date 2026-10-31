/**
 * 大批量读取的主线程 CPU：N 条 balanceOf 的编码 + 解码（假节点直接返回预先算好的结果，排除网络和节点侧的解码）。
 * 不进默认测试：`pnpm exec vitest bench --run test/bench/aggregate.bench.ts`
 */
import { AbiCoder } from 'ethers'
import { bench, describe } from 'vitest'

import { decodeResult3Array, encodeCall3Array } from '../../src/abi3.js'
import { multicall3Interface } from '../../src/aggregate.js'
import { decodeCall, encodeCall } from '../../src/call.js'
import { Contract, ERC20_ABI, MULTICALL3_ADDRESS, Provider } from '../../src/index.js'

const TOKEN = '0x55d398326f99059fF775485246999027B3197955'
const owners = (n: number) => Array.from({ length: n }, (_, i) => `0x${(i + 0x1000).toString(16).padStart(40, '0')}`)
const erc20 = new Contract(TOKEN, ERC20_ABI as unknown as string[])

/** 每片 500 条的 aggregate3 返回值（所有片相同，节点直接返回） */
const chunkResult = multicall3Interface.encodeFunctionResult('aggregate3', [Array.from({ length: 500 }, (_, i) => [true, AbiCoder.defaultAbiCoder().encode(['uint256'], [BigInt(i)])])])
const node = { call: async () => chunkResult, getBalance: async () => 0n }

for (const n of [5_000, 10_000]) {
  const list = owners(n)
  const calls = list.map((o) => erc20.balanceOf(o))
  describe(`${n} 条 balanceOf`, () => {
    bench('端到端 provider.all（编码 + 解码，假节点）', async () => {
      const multi = new Provider(56, node, { multicall: { address: MULTICALL3_ADDRESS }, maxConcurrentChunks: 100 })
      await multi.all(list.map((o) => erc20.balanceOf(o)))
    }, { iterations: 5, warmupIterations: 1 })
    bench('只编码：encodeCall × n', () => {
      for (const c of calls) encodeCall(c, true)
    }, { iterations: 5, warmupIterations: 1 })
    const requests = calls.map((c) => encodeCall(c, true))
    bench('只编码：aggregate3 calldata，手写（每片 500）', () => {
      for (let i = 0; i < requests.length; i += 500) {
        encodeCall3Array(requests.slice(i, i + 500).map((r) => ({ target: r.target, allowFailure: true, callData: r.callData })))
      }
    }, { iterations: 5, warmupIterations: 1 })
    bench('只编码：aggregate3 calldata，ethers（每片 500）', () => {
      for (let i = 0; i < requests.length; i += 500) {
        multicall3Interface.encodeFunctionData('aggregate3', [requests.slice(i, i + 500).map((r) => ({ target: r.target, allowFailure: true, callData: r.callData }))])
      }
    }, { iterations: 5, warmupIterations: 1 })
    bench('只解码：aggregate3 结果，手写', () => {
      for (let i = 0; i < n; i += 500) decodeResult3Array(chunkResult)
    }, { iterations: 5, warmupIterations: 1 })
    bench('只解码：aggregate3 结果，ethers', () => {
      for (let i = 0; i < n; i += 500) multicall3Interface.decodeFunctionResult('aggregate3', chunkResult)
    }, { iterations: 5, warmupIterations: 1 })
    const rows = multicall3Interface.decodeFunctionResult('aggregate3', chunkResult)[0] as Array<[boolean, string]>
    bench('只解码：decodeCall × n', () => {
      for (let i = 0; i < n; i++) decodeCall(calls[i]!, rows[i % 500]![1])
    }, { iterations: 5, warmupIterations: 1 })
  })
}
