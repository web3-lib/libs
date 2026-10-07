/**
 * 连真实节点的测试，默认跳过：`pnpm test:live`
 * 可用环境变量覆盖 RPC：BSC_RPC / ETH_RPC / TRON_HOST / TRON_API_KEY
 */
import { FetchRequest, JsonRpcProvider } from 'ethers'
import { describe, expect, it } from 'vitest'

import {
  CallFailedError,
  Contract,
  NATIVE_TOKEN,
  Provider,
  TRON_CHAIN_ID,
  TronProvider,
  getAllowances,
  getBalances,
  getNftCollections,
  getNftOwners,
  getNftTokenUris,
  getTokens,
} from '../src/index.js'

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

  it('getBalances：内置节点，主币 + 代币，带 decimals 换算', async () => {
    const [bnb, usdt] = await getBalances(HOLDER, [NATIVE_TOKEN, USDT], { chainId: 56 })
    expect(bnb).toMatchObject({ native: true, decimals: 18, success: true })
    expect(usdt).toMatchObject({ native: false, decimals: 18, success: true })
    expect(bnb?.balance).toBe((await rpc.getBalance(HOLDER)).toString())
    expect(Number(usdt?.formatted)).toBeCloseTo(Number(usdt?.balance) / 1e18)
    console.log('BSC balances:', bnb?.formatted, 'BNB,', usdt?.formatted, 'USDT')
  })

  it('不传 chainId：从节点 URL 识别；symbol 选项', async () => {
    const res = await getBalances(HOLDER, [NATIVE_TOKEN, USDT], { provider: 'https://bsc-dataseed.bnbchain.org', symbol: true })
    expect(res.map((r) => [r.symbol, r.decimals, r.success])).toEqual([
      ['BNB', 18, true],
      ['USDT', 18, true],
    ])
  })

  it('getAllowances：授权额度', async () => {
    const [usdt, bnb] = await getAllowances(HOLDER, '0x10ED43C718714eb63d5aA57B78B54704E256024E', [USDT, NATIVE_TOKEN], { chainId: 56 })
    expect(usdt).toMatchObject({ native: false, decimals: 18, success: true })
    expect(bnb).toMatchObject({ native: true, unlimited: true, success: true })
  })

  it('简化写法：绑定合约直接 await + 对象形式', async () => {
    const multi = new Provider(56, rpc)
    const usdt = multi.erc20(USDT)
    const { symbol, decimals, bnb } = await multi.all({ symbol: usdt.symbol(), decimals: usdt.decimals(), bnb: multi.getEthBalance(HOLDER) })
    expect([symbol, decimals]).toEqual(['USDT', 18n])
    expect(bnb).toBeTypeOf('bigint')
    expect(await usdt.transfer.staticCall(USDT, 1n, { from: HOLDER })).toBe(true)
    const [info] = await multi.tokens([USDT])
    expect(info).toMatchObject({ symbol: 'USDT', decimals: 18, success: true })
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

live('Ethereum NFT / 代币详情', () => {
  const BAYC = '0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D'
  const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'

  it('NFT 集合：ERC165 识别标准 + name / totalSupply', async () => {
    const [bayc] = await getNftCollections([BAYC], { chainId: 1, fields: ['standard', 'name', 'symbol', 'totalSupply'] })
    expect(bayc).toMatchObject({ standard: 'ERC721', name: 'BoredApeYachtClub', symbol: 'BAYC', totalSupply: '10000', success: true })
  })

  it('NFT 持有人与元数据地址', async () => {
    const [owner] = await getNftOwners([{ contract: BAYC, tokenId: 1 }], { chainId: 1 })
    expect(owner?.owner).toMatch(/^0x[0-9a-fA-F]{40}$/)
    const [uri] = await getNftTokenUris([{ contract: BAYC, tokenId: 1 }], { chainId: 1, ipfsGateway: 'https://ipfs.io/ipfs/' })
    expect(uri?.uri).toMatch(/^https:\/\/ipfs\.io\/ipfs\/.+\/1$/)
    console.log('BAYC #1 owner', owner?.owner, 'uri', uri?.uri)
  })

  it('getTokens：字段可选 + totalSupply 换算', async () => {
    const [usdc, eth] = await getTokens([USDC, NATIVE_TOKEN], { chainId: 1, fields: ['symbol', 'decimals', 'totalSupply'] })
    expect(usdc).toMatchObject({ symbol: 'USDC', decimals: 6, success: true })
    expect(Number(usdc?.totalSupplyFormatted)).toBeGreaterThan(1e9)
    expect(eth).toMatchObject({ native: true, symbol: 'ETH', decimals: 18, totalSupply: null, success: true })
  })
}, 60_000)

live('Ethereum 历史区块', () => {
  // 公共节点对历史区块请求可能直接挂住，加超时，超时按“不是归档节点”跳过
  const request = new FetchRequest(process.env.ETH_RPC ?? 'https://ethereum-rpc.publicnode.com')
  request.timeout = 10_000
  const rpc = new JsonRpcProvider(request, 1, { staticNetwork: true })
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

  it('getBalances：TRX 6 位精度', async () => {
    const [trx, usdt] = await getBalances(HOLDER, [NATIVE_TOKEN, USDT], { chainId: TRON_CHAIN_ID.mainnet })
    expect(trx).toMatchObject({ native: true, decimals: 6, success: true })
    expect(usdt).toMatchObject({ native: false, decimals: 6, success: true })
    console.log('Tron balances:', trx?.formatted, 'TRX,', usdt?.formatted, 'USDT')
  })

  it('不传 chainId：Tron 节点 URL 自动识别为 Tron', async () => {
    const multi = new Provider('https://api.trongrid.io')
    expect(await multi.getChainId()).toBe(TRON_CHAIN_ID.mainnet)
    const [trx, usdt] = await multi.balances(HOLDER, [NATIVE_TOKEN, USDT], { symbol: true })
    expect([trx?.symbol, trx?.decimals, usdt?.symbol, usdt?.decimals]).toEqual(['TRX', 6, 'USDT', 6])
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
