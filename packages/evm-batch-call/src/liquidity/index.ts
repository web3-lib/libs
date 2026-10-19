import { Interface } from 'ethers'

import type { Provider } from '../provider.js'
import { batchCall, tronModule } from '../write/batch.js'
import { WriteRpc } from '../write/rpc.js'
import { resolveSigner, type SignerInput } from '../write/signer.js'
import { ZERO_ADDRESS, createCtx, evm, positionVersion, protocolById } from './common.js'
import type {
  AddLiquidityParams,
  CollectFeesParams,
  LiquidityOptions,
  LiquidityPlan,
  LiquidityResult,
  LiquiditySendOptions,
  LiquidityTx,
  LiquidityTxResult,
  RemoveLiquidityParams,
} from './types.js'
import { v2Add, v2Remove } from './v2.js'
import { v3Add, v3Remove } from './v3.js'
import { v4Add, v4Remove } from './v4.js'

/**
 * 添加流动性的计划（不签名、不发送）：新建仓位，或往已有仓位追加。返回预计的数量和要按顺序发送的交易（授权在前）。
 * 只做读取，也可以当作报价：输入一边的数量，看另一边要多少、能拿到多少流动性
 *
 * ```ts
 * // 新建 V3 仓位：价格区间按 tokenB / tokenA，给一边的数量
 * const plan = await buildAddLiquidity(multi, owner, { protocol: 'pancakeswap-v3', tokenA: WBNB, tokenB: USDT, fee: 500, priceLower: 550, priceUpper: 650, amountAFormatted: '1' })
 * plan.amount1Formatted   // 需要的 USDT
 * plan.transactions       // [approve…, add]，可以交给钱包逐笔发送
 * // 往已有仓位追加（position 可以直接用 getLpPositions 的结果）
 * await buildAddLiquidity(multi, owner, { position, amount0Formatted: '0.5' })
 * ```
 */
export async function buildAddLiquidity(provider: Provider, owner: string, params: AddLiquidityParams, options: LiquidityOptions = {}): Promise<LiquidityPlan> {
  const ctx = await createCtx(provider, owner, options)
  if ('position' in params) {
    const version = positionVersion(ctx, params.position)
    return version === 'v2' ? v2Add(ctx, params) : version === 'v3' ? v3Add(ctx, params) : v4Add(ctx, params)
  }
  const protocol = protocolById(ctx, params.protocol)
  const resolved = { ...params, protocol }
  return protocol.version === 'v2' ? v2Add(ctx, resolved) : protocol.version === 'v3' ? v3Add(ctx, resolved) : v4Add(ctx, resolved)
}

/**
 * 移除流动性的计划（不签名、不发送）：按比例或指定数量移除，V3 / V4 同时领取全部未领取的手续费。
 *
 * ```ts
 * await buildRemoveLiquidity(multi, owner, { position, percent: 50 })
 * await buildRemoveLiquidity(multi, owner, { position, burn: true })   // 全部移除并销毁 NFT
 * ```
 */
export async function buildRemoveLiquidity(provider: Provider, owner: string, params: RemoveLiquidityParams, options: LiquidityOptions = {}): Promise<LiquidityPlan> {
  const ctx = await createCtx(provider, owner, options)
  const version = positionVersion(ctx, params.position)
  return version === 'v2' ? v2Remove(ctx, params) : version === 'v3' ? v3Remove(ctx, params) : v4Remove(ctx, params)
}

/** 只领取 V3 / V4 仓位的手续费（不动流动性）的计划 */
export async function buildCollectFees(provider: Provider, owner: string, params: CollectFeesParams, options: LiquidityOptions = {}): Promise<LiquidityPlan> {
  const ctx = await createCtx(provider, owner, options)
  const version = positionVersion(ctx, params.position)
  if (version === 'v2') {
    throw new Error('V2 has no separate fees: they are part of the LP tokens, remove liquidity to get them')
  }
  return version === 'v3' ? v3Remove(ctx, { position: params.position }, true) : v4Remove(ctx, { position: params.position }, true)
}

/**
 * 添加流动性：构建计划（同 buildAddLiquidity）后用 from 签名发送，授权不够时先发授权交易。
 * from 与 /write 的 batchCall 相同：私钥、ethers Signer、浏览器钱包（Tron 上也可以是 tronWeb / adapter）
 *
 * ```ts
 * const { status, tokenId, plan } = await addLiquidity(multi, privateKey, { protocol: 'uniswap-v3', tokenA: NATIVE_TOKEN, tokenB: USDC, fee: 500, fullRange: true, amountAFormatted: '0.1' })
 * ```
 */
export async function addLiquidity(provider: Provider, from: SignerInput, params: AddLiquidityParams, options: LiquiditySendOptions = {}): Promise<LiquidityResult> {
  const plan = await buildAddLiquidity(provider, await signerAddress(provider, from), params, options)
  if (options.checkBalance ?? true) {
    await checkBalance(provider, plan)
  }
  return execute(provider, from, plan, options)
}

/** 移除流动性：构建计划（同 buildRemoveLiquidity）后用 from 签名发送 */
export async function removeLiquidity(provider: Provider, from: SignerInput, params: RemoveLiquidityParams, options: LiquiditySendOptions = {}): Promise<LiquidityResult> {
  const plan = await buildRemoveLiquidity(provider, await signerAddress(provider, from), params, options)
  return execute(provider, from, plan, options)
}

/** 领取 V3 / V4 仓位的手续费 */
export async function collectFees(provider: Provider, from: SignerInput, params: CollectFeesParams, options: LiquiditySendOptions = {}): Promise<LiquidityResult> {
  const plan = await buildCollectFees(provider, await signerAddress(provider, from), params, options)
  return execute(provider, from, plan, options)
}

/** 签名器的地址（Tron 上为 T 地址），不发交易 */
async function signerAddress(provider: Provider, from: SignerInput): Promise<string> {
  const tron = await tronModule(provider)
  return tron ? tron.tronSignerAddress(from) : (await resolveSigner(from)).address
}

/** 添加前检查余额：代币按预计数量，主币按附带的 value（不含手续费） */
async function checkBalance(provider: Provider, plan: LiquidityPlan): Promise<void> {
  const needs: Array<[string, bigint]> = []
  // V4 追加时先自动领取手续费、与存入相抵：只需要差额
  const offset = (amount: string, fees: string) => {
    const need = BigInt(amount) - (plan.version === 'v4' && plan.tokenId !== null ? BigInt(fees) : 0n)
    return need > 0n ? need : 0n
  }
  if (plan.native !== 'token0') needs.push([plan.token0.address, offset(plan.amount0, plan.fees0)])
  if (plan.native !== 'token1') needs.push([plan.token1.address, offset(plan.amount1, plan.fees1)])
  if (BigInt(plan.value) > 0n) needs.push([provider.nativeTokens[0] ?? ZERO_ADDRESS, BigInt(plan.value)])
  const list = needs.filter(([, amount]) => amount > 0n)
  if (!list.length) {
    return
  }
  const balances = await provider.balances(plan.owner, list.map(([token]) => token))
  list.forEach(([token, amount], i) => {
    const b = balances[i]
    // 读不到余额的不拦（预估 gas 时也会失败）
    if (b?.success && BigInt(b.balance) < amount) {
      throw new Error(`Insufficient balance of ${token}: need ${amount}, have ${b.balance}`)
    }
  })
}

const transferTopic = new Interface(['event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)']).getEvent('Transfer')?.topicHash as string

async function execute(provider: Provider, from: SignerInput, plan: LiquidityPlan, options: LiquiditySendOptions): Promise<LiquidityResult> {
  const { transactions } = plan
  const results = (
    await batchCall(
      provider,
      transactions.map((tx) => ({ from, to: tx.to, data: tx.data, value: BigInt(tx.value) })),
      {
        ...options,
        mode: 'tx',
        // 授权失败时不发主交易
        continueOnError: false,
        onUpdate: options.onUpdate ? (r) => options.onUpdate?.({ ...r, kind: (transactions[r.index] as LiquidityTx).kind }) : undefined,
      },
    )
  ).map((r, i): LiquidityTxResult => ({ ...r, kind: (transactions[i] as LiquidityTx).kind }))
  const main = results[results.length - 1] as LiquidityTxResult
  let tokenId: string | null = plan.tokenId
  if (plan.action === 'add' && plan.tokenId === null && plan.version !== 'v2') {
    tokenId = main.status === 'confirmed' && main.hash ? await mintedTokenId(provider, plan, main.hash) : null
  }
  return { plan, results, status: main.status, hash: main.hash, tokenId }
}

/** 新建仓位的 tokenId：主交易回执里仓位合约从零地址转出的 NFT（Tron 上不读，为 null） */
async function mintedTokenId(provider: Provider, plan: LiquidityPlan, hash: string): Promise<string | null> {
  try {
    if (await tronModule(provider)) {
      return null
    }
    const receipt = await (await WriteRpc.from(provider)).receipt(hash)
    const pm = evm((plan.transactions[plan.transactions.length - 1] as { to: string }).to)
    const log = receipt?.logs.find(
      (l) => l.topics.length === 4 && l.topics[0] === transferTopic && BigInt(l.topics[1] as string) === 0n && evm(l.address) === pm,
    )
    return log ? BigInt(log.topics[3] as string).toString() : null
  } catch {
    return null // 读回执失败不影响结果（交易已确认）
  }
}

