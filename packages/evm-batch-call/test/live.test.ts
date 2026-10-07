/**
 * 连真实节点的测试，默认跳过：`pnpm test:live`
 * 可用环境变量覆盖 RPC：BSC_RPC / ETH_RPC / TRON_HOST / TRON_API_KEY
 */
import { JsonRpcProvider } from 'ethers'
import { describe, expect, it } from 'vitest'

import { CallFailedError, Contract, Provider, TRON_CHAIN_ID, TronProvider } from '../src/index.js'

const live = process.env.LIVE ? describe : describe.skip

const ERC20ABI = [
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function balanceOf(address owner) view returns (uint256)',
  'function transfer(address to, uint256 amount) returns (bool)',
]

live('BSC', () => {
  const rpc = new JsonRpcProvider(process.env.BSC_RPC ?? 'https://bsc-dataseed.bnbchain.org', 56, { staticNetwork: true })
  const USDT = '0x55d398326f99059fF775485246999027B3197955'
  const HOLDER = '0xF977814e90dA44bFA03b6295A0616a897441aceC' // Binance 8

  it('Multicall3 合约模式', async () => {
    const multi = new Provider(56, rpc)
    const usdt = new Contract(USDT, ERC20ABI)
    const [symbol, decimals, balance, bnb] = await multi.all([usdt.symbol(), usdt.decimals(), usdt.balanceOf(HOLDER), multi.getEthBalance(HOLDER)])
    expect(symbol).toBe('USDT')
    expect(decimals).toBe(18n)
    expect(balance).toBeTypeOf('bigint')
    expect(bnb).toBeTypeOf('bigint')
  })

  it('deployless 大批量（超过 24KB 返回 / 48KB initcode）+ 主币余额在同一批', async () => {
    const multi = new Provider(56, rpc, { deployless: true })
    const usdt = new Contract(USDT, ERC20ABI)
    const holders = Array.from({ length: 400 }, (_, i) => '0x' + (i + 1).toString(16).padStart(40, '0'))
    const calls = [multi.getEthBalance(HOLDER), ...holders.map((h) => usdt.balanceOf(h))]
    const res = await multi.all(calls)
    expect(res).toHaveLength(401)
    expect(res[0]).toBe(await rpc.getBalance(HOLDER))
    expect(res.every((r) => typeof r === 'bigint')).toBe(true)
  })

  it('不传节点用内置公共节点；坏节点自动切换', async () => {
    const usdt = new Provider(56).erc20(USDT)
    expect(await usdt.symbol()).toBe('USDT')
    const multi = new Provider(56, ['https://bad-node.invalid', 'https://bsc-dataseed.bnbchain.org'])
    expect(await multi.balances(HOLDER, [USDT, '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'])).toHaveLength(2)
  })

  it('简化写法：绑定合约直接 await + 对象形式', async () => {
    const multi = new Provider(56, rpc)
    const usdt = multi.erc20(USDT)
    const { symbol, decimals, bnb } = await multi.all({ symbol: usdt.symbol(), decimals: usdt.decimals(), bnb: multi.getEthBalance(HOLDER) })
    expect([symbol, decimals]).toEqual(['USDT', 18n])
    expect(bnb).toBeTypeOf('bigint')
    expect(await usdt.transfer.staticCall(USDT, 1n, { from: HOLDER })).toBe(true)
    const [info] = await multi.tokenInfo([USDT])
    expect(info).toMatchObject({ symbol: 'USDT', decimals: 18 })
  })

  it('deployless 模式结果一致', async () => {
    const usdt = new Contract(USDT, ERC20ABI)
    const calls = [usdt.symbol(), usdt.balanceOf(HOLDER)]
    const a = await new Provider(56, rpc).all(calls, { blockTag: 'latest' })
    const b = await new Provider(56, rpc, { deployless: true }).tryAll(calls)
    expect(b[0]).toBe(a[0])
    const bnb = await new Provider(56, rpc, { deployless: true }).all([new Provider(56, rpc).getEthBalance(HOLDER)])
    expect(bnb[0]).toBeTypeOf('bigint')
  })

  it('tryAll：非合约地址返回 null', async () => {
    const res = await new Provider(56, rpc).tryAll([new Contract(HOLDER, ERC20ABI).symbol(), new Contract(USDT, ERC20ABI).symbol()])
    expect(res).toEqual([null, 'USDT'])
  })

  it('call() 自动合并', async () => {
    const multi = new Provider(56, rpc)
    const usdt = new Contract(USDT, ERC20ABI)
    const [s, d] = await Promise.all([multi.call(usdt.symbol()), multi.call(usdt.decimals())])
    expect([s, d]).toEqual(['USDT', 18n])
  })

  it('staticCall 预执行：余额足够成功，不足 revert', async () => {
    const multi = new Provider(56, rpc)
    const usdt = new Contract(USDT, ERC20ABI)
    expect(await multi.staticCall(usdt.transfer(USDT, 1n), { from: HOLDER })).toBe(true)
    const [ok, fail] = await multi.staticCallAll([usdt.transfer(USDT, 1n), usdt.transfer(USDT, 10n ** 40n)], { from: HOLDER })
    expect(ok).toEqual({ success: true, data: true })
    expect(fail?.success).toBe(false)
    if (fail && !fail.success) {
      expect(fail.error).toBeInstanceOf(CallFailedError)
      console.log('BSC revert reason:', (fail.error as CallFailedError).reason)
    }
  })
}, 30_000)

live('Ethereum 历史区块', () => {
  const rpc = new JsonRpcProvider(process.env.ETH_RPC ?? 'https://ethereum-rpc.publicnode.com', 1, { staticNetwork: true })
  it('blockTag 早于 Multicall3 部署区块时走 deployless（需要归档节点）', async (ctx) => {
    const dai = new Contract('0x6B175474E89094C44Da98b954EedeAC495271d0F', ERC20ABI)
    try {
      const res = await new Provider(1, rpc).all([dai.symbol()], { blockTag: 14_000_000 })
      expect(res).toEqual(['DAI'])
    } catch (err) {
      if (/archive|missing trie node|header not found|403|timeout/i.test(String(err))) {
        ctx.skip('当前 ETH_RPC 不是归档节点')
      }
      throw err
    }
  })
}, 30_000)

live('Tron 主网', () => {
  const tron = new TronProvider({
    fullHost: process.env.TRON_HOST,
    apiKey: process.env.TRON_API_KEY,
    // 没有 API Key 时 TronGrid 限频很严
    minInterval: process.env.TRON_API_KEY ? 0 : 300,
  })
  const USDT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'
  const HOLDER = 'TNXoiAJ3dct8Fjg4M9fkLFh9S2v9TXc32G'

  it('Multicall3 合约模式 + TRX 余额', async () => {
    const multi = new Provider(TRON_CHAIN_ID.mainnet, tron)
    const usdt = new Contract(USDT, ERC20ABI)
    const [symbol, decimals, balance, trx] = await multi.all([usdt.symbol(), usdt.decimals(), usdt.balanceOf(HOLDER), multi.getEthBalance(HOLDER)])
    expect(symbol).toBe('USDT')
    expect(decimals).toBe(6n)
    expect(balance).toBeTypeOf('bigint')
    expect(trx).toBeGreaterThan(0n)
  })

  it('deployless 模式：主币余额也在同一次请求里', async () => {
    const multi = new Provider(TRON_CHAIN_ID.mainnet, tron, { deployless: true })
    const usdt = new Contract(USDT, ERC20ABI)
    const [symbol, trx] = await multi.tryAll([usdt.symbol(), multi.getEthBalance(HOLDER)])
    expect(symbol).toBe('USDT')
    expect(trx).toBe(await tron.getBalance(HOLDER))
  })

  it('不传节点用内置 Tron 节点', async () => {
    expect(await new Provider(TRON_CHAIN_ID.mainnet).erc20(USDT).symbol()).toBe('USDT')
  })

  it('staticCall 预执行', async () => {
    const multi = new Provider(TRON_CHAIN_ID.mainnet, tron)
    const usdt = new Contract(USDT, ERC20ABI)
    const [ok, fail] = await multi.staticCallAll([usdt.transfer(USDT, 1n), usdt.transfer(USDT, 10n ** 40n)], { from: HOLDER })
    expect(ok?.success).toBe(true)
    expect(fail?.success).toBe(false)
  })
}, 30_000)
