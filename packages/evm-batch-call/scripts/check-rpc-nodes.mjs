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
 * 只报告不改文件；有链一个可用节点都没有时退出码为 1。需要 Node 22.18+ / 23.6+（直接加载 .ts）。
 */
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

let deadChains = 0
for (const [chainId, nodes] of [...results].sort(([a], [b]) => a - b)) {
  const ok = nodes.filter((n) => !n.problem).length
  if (!ok) {
    deadChains++
  }
  console.log(`${ok ? '✓' : '✗'} ${chainId}  ${ok}/${nodes.length} 可用`)
  for (const node of nodes.filter((n) => n.problem)) {
    console.log(`    ✗ ${node.url}  ${node.problem}`)
  }
}
console.log(`\n共 ${results.size} 条链，${deadChains} 条无可用节点`)
console.log('提示：UND_ERR_* / ECONN* / TimeoutError 等网络层错误可能是本机网络抖动，删除节点前请多跑几次确认')
process.exitCode = deadChains ? 1 : 0
