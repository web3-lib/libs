/**
 * 检查内置公共节点表（src/rpcNodes.ts）里每个节点是否可用：
 *
 *   pnpm check:rpc               检查全部
 *   pnpm check:rpc --chain=56    只检查某条链（Tron 主网是 728126428）
 *
 * 节点要能在浏览器里直连，任一不满足即判为不可用：
 *   - 预检 OPTIONS 返回 2xx，放行任意来源和 content-type 头，POST 响应也放行跨域
 *   - EVM：eth_chainId 与表里的 chainId 一致；10 条一批的 batch 请求整批成功（ethers 会把同时发出的请求合成 batch）
 *   - Tron：triggerconstantcontract 能正常执行（读 USDT 的 symbol）
 *
 * 另外每条 EVM 链用第一个可用节点检查批量调用的两种方式：内置表里的 Multicall3 能否调用 aggregate3、deployless（合约创建式 eth_call）
 * 能否执行并带回结果。两种都不可用时这条链上的批量查询会失败，报错（退出码 1）。
 *
 * 并比对主币余额：合约里读到的（Multicall3.getEthBalance、deployless 里的 BALANCE）
 * 与 eth_getBalance 是否一致。不一致说明这条链要在 src/chains.ts 的 NATIVE_BALANCE_MODES 里配置 'rpc' 或 { erc20 }，
 * 否则 balances() 会静默返回错误的主币余额。
 *
 * 只报告不改文件；有链一个可用节点都没有、或主币余额不一致且没配置时退出码为 1。需要 Node 22.18+ / 23.6+（直接加载 .ts）。
 */
import { AbiCoder, Interface, concat } from 'ethers'

import { NATIVE_BALANCE_MODES } from '../src/chains.ts'
import { DEPLOYLESS_MULTICALL3_BYTECODE } from '../src/deployless.ts'
import { MULTICALL3_ADDRESS, getMulticall3 } from '../src/multicall.ts'
import { DEFAULT_RPC_URLS, DEFAULT_TRON_HOSTS } from '../src/rpcNodes.ts'

const TRON_MAINNET = 728126428
const ORIGIN = 'https://cors-check.example'
const TIMEOUT = 15_000
const CONCURRENCY = 6

const chainArg = process.argv.find((a) => a.startsWith('--chain='))?.slice(8)

async function request(url, init = {}) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT) })
  return res
}

const corsAllowed = (res) => ['*', ORIGIN].includes(res.headers.get('access-control-allow-origin'))

async function checkPreflight(url) {
  const res = await request(url, {
    method: 'OPTIONS',
    headers: { Origin: ORIGIN, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' },
  })
  const allowHeaders = (res.headers.get('access-control-allow-headers') ?? '').toLowerCase()
  if (!res.ok || !corsAllowed(res)) {
    return `preflight ${res.status}`
  }
  if (!allowHeaders.includes('*') && !allowHeaders.split(',').map((h) => h.trim()).includes('content-type')) {
    return 'preflight 不放行 content-type'
  }
  return null
}

async function postJson(url, body) {
  const res = await request(url, {
    method: 'POST',
    headers: { Origin: ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`)
  }
  if (!corsAllowed(res)) {
    throw new Error('POST 响应不放行跨域')
  }
  return res.json()
}

async function checkEvm(chainId, url) {
  const preflight = await checkPreflight(url)
  if (preflight) {
    return preflight
  }
  const single = await postJson(url, { jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] })
  if (Number(single.result) !== chainId) {
    return `chainId 不符：${single.result ?? JSON.stringify(single.error)}`
  }
  const batch = Array.from({ length: 10 }, (_, i) =>
    i % 2
      ? { jsonrpc: '2.0', id: i + 1, method: 'eth_getBalance', params: ['0x0000000000000000000000000000000000000001', 'latest'] }
      : { jsonrpc: '2.0', id: i + 1, method: 'eth_blockNumber', params: [] },
  )
  const results = await postJson(url, batch)
  if (!Array.isArray(results) || results.length !== batch.length || results.some((r) => r.error || r.result === undefined)) {
    return 'batch 请求失败'
  }
  return null
}

const multicall3 = new Interface([
  'function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)',
  'function getEthBalance(address addr) view returns (uint256 balance)',
  'function getBlockNumber() view returns (uint256 blockNumber)',
])

async function rpc(url, method, params) {
  const res = await postJson(url, { jsonrpc: '2.0', id: 1, method, params })
  if (res.error) {
    throw new Error(`${method}: ${res.error.message ?? JSON.stringify(res.error)}`)
  }
  return res.result
}

/** 找一个主币余额大于 0 的地址：最新区块里交易的发送方（要付 gas），其次出块地址 */
async function findFundedAddress(url, blockTag) {
  const block = await rpc(url, 'eth_getBlockByNumber', [blockTag, true])
  const candidates = [...new Set([...(block?.transactions ?? []).map((tx) => tx.from), block?.miner].filter(Boolean))].slice(0, 5)
  for (const address of candidates) {
    const balance = BigInt(await rpc(url, 'eth_getBalance', [address, blockTag]))
    if (balance > 0n) {
      return { address, balance }
    }
  }
  return null
}

/**
 * 比对合约里读到的主币余额与 eth_getBalance：Multicall3 用库里这条链实际使用的地址（内置表，没有时为标准地址），
 * 以及 deployless。读不到（无合约、deployless 不被支持、请求出错）的方式不参与比对，都读不到时返回 skipped
 */
async function checkNativeBalance(chainId, url) {
  const blockTag = await rpc(url, 'eth_blockNumber', [])
  const funded = await findFundedAddress(url, blockTag)
  if (!funded) {
    return { skipped: '最新区块里找不到余额大于 0 的地址' }
  }
  const results = {}
  const notes = []
  const multicallAddress = getMulticall3(chainId)?.address ?? MULTICALL3_ADDRESS
  const call = { to: multicallAddress, data: multicall3.encodeFunctionData('getEthBalance', [funded.address]) }
  try {
    const code = await rpc(url, 'eth_getCode', [multicallAddress, blockTag])
    if (code && code !== '0x') {
      results.multicall = BigInt(await rpc(url, 'eth_call', [call, blockTag]))
    }
  } catch (err) {
    notes.push(`multicall 未比对：${err.message}`)
  }
  const args = AbiCoder.defaultAbiCoder().encode(
    ['tuple(address target, bool allowFailure, bytes callData)[]'],
    [[{ target: MULTICALL3_ADDRESS, allowFailure: true, callData: call.data }]],
  )
  try {
    const data = await rpc(url, 'eth_call', [{ data: concat([DEPLOYLESS_MULTICALL3_BYTECODE, args]) }, blockTag])
    const [[[success, returnData]]] = multicall3.decodeFunctionResult('aggregate3', data)
    if (success && returnData !== '0x') {
      results.deployless = BigInt(returnData)
    } else {
      notes.push('deployless 未比对：调用失败')
    }
  } catch (err) {
    notes.push(`deployless 未比对：${err.message}`)
  }
  if (!Object.keys(results).length) {
    return { skipped: notes.join('；') || '没有可比对的方式' }
  }
  const wrong = Object.entries(results).filter(([, v]) => v !== funded.balance)
  return wrong.length
    ? { problem: `${funded.address} eth_getBalance=${funded.balance}，${wrong.map(([k, v]) => `${k}=${v}`).join('，')}` }
    : {}
}

/** 批量调用方式是否可用：返回 { multicall, deployless }，值为 true 或失败原因（表里没有 Multicall3 时 multicall 为 null） */
async function checkBatchModes(chainId, url) {
  const latest = BigInt(await rpc(url, 'eth_blockNumber', []))
  const getBlockNumber = multicall3.encodeFunctionData('getBlockNumber')
  // 同时读 Arbitrum 的 L2 区块号（ArbSys.arbBlockNumber；Arbitrum 系的链上 block.number 是 L1 区块号），与库里一致
  const arbBlockNumber = { target: '0x0000000000000000000000000000000000000064', allowFailure: true, callData: '0xa3b1b31d' }
  // 区块号与 eth_blockNumber 相差太多（如合约没执行、返回了别的数据）也算不可用
  const plausible = (block) => block + 20n >= latest && block <= latest + 20n
  const blockOf = (results) => {
    const [[ok, own], [arbOk, arb]] = results
    return { ok, block: BigInt(arbOk && arb.length === 66 ? arb : own), raw: own }
  }
  const out = { multicall: null, deployless: null }
  const multicall = getMulticall3(chainId)
  if (multicall) {
    try {
      const data = await rpc(url, 'eth_call', [
        { to: multicall.address, data: multicall3.encodeFunctionData('aggregate3', [[{ target: multicall.address, allowFailure: false, callData: getBlockNumber }, arbBlockNumber]]) },
        'latest',
      ])
      const { ok, block, raw } = blockOf(multicall3.decodeFunctionResult('aggregate3', data)[0])
      out.multicall = ok && plausible(block) ? true : `aggregate3 结果不对：${raw}`
    } catch (err) {
      out.multicall = err.message.slice(0, 100)
    }
  }
  try {
    const args = AbiCoder.defaultAbiCoder().encode(
      ['tuple(address target, bool allowFailure, bytes callData)[]'],
      [[{ target: MULTICALL3_ADDRESS, allowFailure: false, callData: getBlockNumber }, arbBlockNumber]],
    )
    const data = await rpc(url, 'eth_call', [{ data: concat([DEPLOYLESS_MULTICALL3_BYTECODE, args]) }, 'latest'])
    const { ok, block, raw } = blockOf(multicall3.decodeFunctionResult('aggregate3', data)[0])
    out.deployless = ok && plausible(block) ? true : `结果不对：${raw}`
  } catch (err) {
    out.deployless = err.message.slice(0, 100)
  }
  return out
}

async function checkTron(host) {
  const preflight = await checkPreflight(`${host}/wallet/triggerconstantcontract`)
  if (preflight) {
    return preflight
  }
  const res = await postJson(`${host}/wallet/triggerconstantcontract`, {
    owner_address: '410000000000000000000000000000000000000000',
    contract_address: '41a614f803b6fd780986a42c78ec9c7f77e6ded13c', // USDT
    data: '95d89b41', // symbol()
  })
  return res?.constant_result?.[0] ? null : `triggerconstantcontract 失败：${JSON.stringify(res?.result ?? res).slice(0, 80)}`
}

const jobs = [
  ...Object.entries(DEFAULT_RPC_URLS).flatMap(([id, urls]) => urls.map((url) => ({ chainId: Number(id), url }))),
  ...DEFAULT_TRON_HOSTS.map((url) => ({ chainId: TRON_MAINNET, url })),
].filter((job) => !chainArg || job.chainId === Number(chainArg))

const results = new Map()
let next = 0
await Promise.all(
  Array.from({ length: CONCURRENCY }, async () => {
    while (next < jobs.length) {
      const job = jobs[next++]
      let problem
      try {
        problem = job.chainId === TRON_MAINNET ? await checkTron(job.url) : await checkEvm(job.chainId, job.url)
      } catch (err) {
        problem = err?.cause?.code ?? err?.name ?? String(err)
      }
      if (!results.has(job.chainId)) {
        results.set(job.chainId, [])
      }
      results.get(job.chainId).push({ url: job.url, problem })
    }
  }),
)

// 主币余额比对：每条 EVM 链用第一个可用节点
const nativeChecks = new Map()
const batchChecks = new Map()
const evmChains = [...results].filter(([chainId, nodes]) => chainId !== TRON_MAINNET && nodes.some((n) => !n.problem))
let nextChain = 0
await Promise.all(
  Array.from({ length: CONCURRENCY }, async () => {
    while (nextChain < evmChains.length) {
      const [chainId, nodes] = evmChains[nextChain++]
      const url = nodes.find((n) => !n.problem).url
      try {
        nativeChecks.set(chainId, await checkNativeBalance(chainId, url))
      } catch (err) {
        nativeChecks.set(chainId, { skipped: err?.message ?? String(err) })
      }
      try {
        batchChecks.set(chainId, await checkBatchModes(chainId, url))
      } catch (err) {
        batchChecks.set(chainId, { error: err?.message ?? String(err) })
      }
    }
  }),
)

let deadChains = 0
let wrongNative = 0
let noBatch = 0
for (const [chainId, nodes] of [...results].sort(([a], [b]) => a - b)) {
  const ok = nodes.filter((n) => !n.problem).length
  if (!ok) {
    deadChains++
  }
  console.log(`${ok ? '✓' : '✗'} ${chainId}  ${ok}/${nodes.length} 可用`)
  for (const node of nodes.filter((n) => n.problem)) {
    console.log(`    ✗ ${node.url}  ${node.problem}`)
  }
  const batch = batchChecks.get(chainId)
  if (batch?.error) {
    console.log(`    · 批量调用方式未检查：${batch.error}`)
  } else if (batch) {
    const label = (v) => (v === true ? '✓' : v === null ? '表里没有' : `✗ ${v}`)
    if (batch.multicall !== true && batch.deployless !== true) {
      noBatch++
      console.log(`    ✗ 批量调用不可用：multicall ${label(batch.multicall)}；deployless ${label(batch.deployless)}`)
    } else if (batch.multicall !== true && batch.multicall !== null) {
      console.log(`    · 内置表里的 Multicall3 不可用（会自动改走 deployless）：${batch.multicall}`)
    } else if (batch.deployless !== true) {
      console.log(`    · deployless 不可用（有 Multicall3，平时不受影响；查询早于合约部署区块的历史状态会失败）：${batch.deployless}`)
    }
  }
  const native = nativeChecks.get(chainId)
  const mode = NATIVE_BALANCE_MODES[chainId]
  if (native?.problem) {
    if (mode) {
      console.log(`    · 合约里读主币余额不一致（已配置 nativeBalance: ${JSON.stringify(mode)}）：${native.problem}`)
    } else {
      wrongNative++
      console.log(`    ✗ 合约里读主币余额不一致，需要在 NATIVE_BALANCE_MODES 里配置 'rpc' 或 { erc20 }：${native.problem}`)
    }
  } else if (native?.skipped) {
    console.log(`    · 主币余额未比对：${native.skipped}`)
  }
}
console.log(`\n共 ${results.size} 条链，${deadChains} 条无可用节点，${noBatch} 条批量调用不可用，${wrongNative} 条主币余额读取不一致且未配置`)
console.log('提示：UND_ERR_* / ECONN* / TimeoutError 等网络层错误可能是本机网络抖动，删除节点前请多跑几次确认')
process.exitCode = deadChains || noBatch || wrongNative ? 1 : 0
