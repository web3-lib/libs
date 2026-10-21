/**
 * 代币风险检查：在 BSC 主网分叉上部署测试代币（买 5% / 卖 8% / 转账 2% 税，以及禁止卖出的貔貅盘），建 PancakeSwap V2 池子，
 * 核对 tokenRisks 算出的税率和判断。默认跳过：
 *
 * ```sh
 * anvil --fork-url https://bsc-dataseed.bnbchain.org --port 18546
 * FORK_RPC=http://127.0.0.1:18546 npx vitest run test/risk-fork.test.ts
 * ```
 */
import { createRequire } from 'node:module'

import { Contract, ContractFactory, JsonRpcProvider, NonceManager, Wallet, parseEther } from 'ethers'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { Provider } from '../src/index.js'
import { tokenRisks } from '../src/subpaths/risk.js'

const fork = process.env.FORK_RPC ? describe : describe.skip
const ROUTER = '0x10ED43C718714eb63d5aA57B78B54704E256024E' // PancakeSwap V2
const FACTORY = '0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73'
const WBNB = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c'

/**
 * 可配置税率的代币（万分之一）；owner 免税；blockSells 时只有 owner 能卖给池子；
 * swapFees 时税先留在合约里，别人卖出时合约把攒下的税也卖进同一个池子（常见的“自动换成主币”写法）
 */
const SOURCE = `
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
interface IRouter { function swapExactTokensForETHSupportingFeeOnTransferTokens(uint256, uint256, address[] calldata, address, uint256) external; }
contract TaxToken {
    address constant ROUTER = 0x10ED43C718714eb63d5aA57B78B54704E256024E;
    address constant WBNB = 0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c;
    string public name = "Tax"; string public symbol = "TAX"; uint8 public decimals = 18;
    uint256 public totalSupply; address public owner; address public pair;
    uint256 public buyTax; uint256 public sellTax; uint256 public transferTax; bool public blockSells; bool public swapFees; bool inSwap;
    mapping(address => uint256) public balanceOf; mapping(address => mapping(address => uint256)) public allowance;
    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    constructor(uint256 b, uint256 s, uint256 t, bool block_, bool swap_) { owner = msg.sender; buyTax = b; sellTax = s; transferTax = t; blockSells = block_; swapFees = swap_; totalSupply = 1e27; balanceOf[msg.sender] = 1e27; }
    function setPair(address p) external { require(msg.sender == owner); pair = p; }
    function approve(address s, uint256 a) external returns (bool) { allowance[msg.sender][s] = a; emit Approval(msg.sender, s, a); return true; }
    function transfer(address to, uint256 a) external returns (bool) { _transfer(msg.sender, to, a); return true; }
    function transferFrom(address f, address to, uint256 a) external returns (bool) { allowance[f][msg.sender] -= a; _transfer(f, to, a); return true; }
    function _transfer(address f, address to, uint256 a) internal {
        if (blockSells && to == pair && f != owner) revert("no sells");
        if (swapFees && to == pair && !inSwap && f != owner && f != address(this) && balanceOf[address(this)] > 0) {
            inSwap = true;
            uint256 fees = balanceOf[address(this)];
            allowance[address(this)][ROUTER] = fees;
            address[] memory path = new address[](2); path[0] = address(this); path[1] = WBNB;
            IRouter(ROUTER).swapExactTokensForETHSupportingFeeOnTransferTokens(fees, 0, path, owner, block.timestamp);
            inSwap = false;
        }
        uint256 rate = (f == owner || to == owner || f == address(this)) ? 0 : f == pair ? buyTax : to == pair ? sellTax : transferTax;
        uint256 fee = a * rate / 10000;
        address sink = swapFees ? address(this) : owner;
        balanceOf[f] -= a; balanceOf[to] += a - fee; balanceOf[sink] += fee;
        emit Transfer(f, to, a - fee);
    }
}`

function compile(): { abi: unknown[]; bytecode: string } {
  const solc = createRequire(import.meta.url)('solc')
  const out = JSON.parse(
    solc.compile(
      JSON.stringify({
        language: 'Solidity',
        sources: { 'TaxToken.sol': { content: SOURCE } },
        settings: { evmVersion: 'paris', optimizer: { enabled: true, runs: 200 }, outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } },
      }),
    ),
  )
  const c = out.contracts['TaxToken.sol'].TaxToken
  return { abi: c.abi, bytecode: `0x${c.evm.bytecode.object}` }
}

fork('代币风险检查（BSC 分叉）', { timeout: 300_000 }, () => {
  let rpc: JsonRpcProvider
  let multi: Provider
  let wallet: Wallet
  let signer: NonceManager
  let snapshot: string
  const { abi, bytecode } = compile()

  beforeAll(async () => {
    rpc = new JsonRpcProvider(process.env.FORK_RPC, 56, { staticNetwork: true })
    multi = new Provider(56, rpc)
    wallet = new Wallet(Wallet.createRandom().privateKey, rpc)
    // 连续发交易：nonce 在本地递增（anvil 自动出块时 ethers 读到的 pending nonce 可能落后）
    signer = new NonceManager(wallet)
    snapshot = (await rpc.send('evm_snapshot', [])) as string
    await rpc.send('anvil_setBalance', [wallet.address, `0x${parseEther('100').toString(16)}`])
  }, 120_000)

  afterAll(async () => {
    if (snapshot) await rpc.send('evm_revert', [snapshot])
  })

  /** 部署代币、建池子（10 BNB + 1e24 代币） */
  async function launch(buy: number, sell: number, transfer: number, blockSells: boolean, swapFees = false): Promise<string> {
    const token = await new ContractFactory(abi as never, bytecode, signer).deploy(buy, sell, transfer, blockSells, swapFees)
    await token.waitForDeployment()
    const address = await token.getAddress()
    const t = new Contract(address, abi as never, signer)
    await (await t.getFunction('approve')(ROUTER, 2n ** 255n)).wait()
    const router = new Contract(ROUTER, ['function addLiquidityETH(address token, uint256 amountTokenDesired, uint256 amountTokenMin, uint256 amountETHMin, address to, uint256 deadline) payable'], signer)
    await (await router.getFunction('addLiquidityETH')(address, 10n ** 24n, 0, 0, wallet.address, 2n ** 40n, { value: parseEther('10') })).wait()
    const pair = await new Contract(FACTORY, ['function getPair(address, address) view returns (address)'], rpc).getFunction('getPair')(address, WBNB)
    await (await t.getFunction('setPair')(pair)).wait()
    return address
  }

  it('买 5% / 卖 8% / 转账 2% 的税：算出的税率一致', async () => {
    const token = await launch(500, 800, 200, false)
    const [r] = await tokenRisks(multi, [token])
    expect(r).toMatchObject({ protocol: 'pancakeswap-v2', stage: 'ok', honeypot: false })
    expect(r?.buyTax).toBeCloseTo(0.05, 4)
    expect(r?.sellTax).toBeCloseTo(0.08, 4)
    expect(r?.transferTax).toBeCloseTo(0.02, 4)
    expect(r?.flags).toEqual(expect.arrayContaining(['has-tax', 'owned']))
    expect(r?.flags).not.toContain('honeypot')
  })

  it('卖出时把攒下的税也卖进同一个池子：卖出税仍按 8% 报出（取两种算法中较大的）', async () => {
    const token = await launch(500, 800, 0, false, true)
    // 先让合约攒一些税：随便一个地址买一笔
    const router = new Contract(ROUTER, ['function swapExactETHForTokensSupportingFeeOnTransferTokens(uint256, address[], address, uint256) payable'], signer)
    await (await router.getFunction('swapExactETHForTokensSupportingFeeOnTransferTokens')(0, [WBNB, token], '0x000000000000000000000000000000000000bEEF', 2n ** 40n, { value: parseEther('0.5') })).wait()
    const [r] = await tokenRisks(multi, [token])
    expect(r).toMatchObject({ stage: 'ok', honeypot: false })
    expect(r?.buyTax).toBeCloseTo(0.05, 4)
    expect(r?.sellTax ?? 0).toBeGreaterThanOrEqual(0.0799)
    expect(r?.flags).toContain('has-tax')
  })

  it('禁止卖出：判断为貔貅盘', async () => {
    const token = await launch(0, 0, 0, true)
    const [r] = await tokenRisks(multi, [token])
    expect(r).toMatchObject({ stage: 'sell-failed', honeypot: true, buyTax: 0, transferTax: 0 })
    expect(r?.flags).toContain('honeypot')
  })

  it('卖出税 95%：也算貔貅盘；普通代币（CAKE）没有税', async () => {
    const token = await launch(0, 9500, 0, false)
    const [heavy, cake] = await tokenRisks(multi, [token, '0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82'])
    expect(heavy).toMatchObject({ stage: 'ok', honeypot: true })
    expect(heavy?.flags).toEqual(expect.arrayContaining(['honeypot', 'high-sell-tax']))
    expect(cake).toMatchObject({ stage: 'ok', honeypot: false, buyTax: 0, sellTax: 0, transferTax: 0 })
  })
})
