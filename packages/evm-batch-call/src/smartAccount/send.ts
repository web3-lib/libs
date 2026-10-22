import { Interface, getAddress, getBytes, type Authorization } from 'ethers'

import { decodeRevertReason } from '../errors.js'
import { SIMPLE_7702_ACCOUNT, delegationOf, failedIndex, type BatchCallOptions, type NormalizedCall } from '../write/batch.js'
import { WriteRpc, failureText } from '../write/rpc.js'
import { FeeSource, emptyOutcome, mapPool, sendJobs, toWriteResult, type TxJob, type TxOutcome, type WriteResult } from '../write/send.js'
import { resolveSigner, type ResolvedSigner, type SignerInput } from '../write/signer.js'
import { encodeExecuteBatch, resolveSimpleAccount, type SmartAccountKind } from './account.js'
import { BundlerClient, PaymasterClient, type GasEstimate, type PaymasterHook } from './clients.js'
import {
  DUMMY_SIGNATURE,
  EIP7702_MARKER,
  entryPointAddress,
  entryPointInterface,
  getUserOpHash,
  packUserOp,
  userOpTypedData,
  type EntryPointVersion,
  type UserOperation,
} from './userOp.js'

export interface SmartAccountOptions {
  /** 账户类型，默认 'simple'（见 SmartAccountKind）；7702 模式固定为 'simple7702' */
  account?: SmartAccountKind
  /** EntryPoint 版本：'simple' 默认 '0.7'，'simple7702' 只能 '0.8' */
  entryPoint?: EntryPointVersion
  /** 'simple' 账户的 salt，默认 0（同一个 owner 可以有多个账户） */
  salt?: bigint | number | string
  /** 'simple' 账户的工厂，默认 eth-infinitism 的 SimpleAccountFactory */
  factory?: string
  /** bundler：URL 或 BundlerClient。UserOperation 交给它打包上链 */
  bundler?: string | BundlerClient
  /** paymaster（代付 gas）：ERC-7677 客户端，或自定义函数 */
  paymaster?: PaymasterClient | PaymasterHook
  /**
   * 不用 bundler，自己发 EntryPoint.handleOps 交易：true 表示用账户的 owner 钱包发（owner 付交易 gas），
   * 或传另一个钱包 / 私钥（它付 gas，即 sponsor）。这种方式 UserOperation 的 maxFeePerGas 为 0，账户本身不扣 gas
   */
  selfBundle?: SignerInput | true
  /** 覆盖 gas 预估（自己打包时的 callGasLimit 等） */
  gas?: Partial<GasEstimate>
  /** 把 7702 授权交给 bundler 时的委托合约、是否替换已有委托，同 BatchCallOptions.delegate / redelegate（由调用方填） */
  delegate?: string
  redelegate?: boolean
}

export interface SmartSendOptions extends BatchCallOptions {
  smartAccount?: SmartAccountOptions
}

const FALLBACK_CALL_GAS = 300_000n
const PER_CALL_OVERHEAD = 15_000n
const VERIFICATION_GAS = 200_000n
const DEPLOY_VERIFICATION_GAS = 700_000n
const PRE_VERIFICATION_GAS = 100_000n

type Ctx = {
  rpc: WriteRpc
  options: SmartSendOptions
  so: SmartAccountOptions
  kind: SmartAccountKind
  version: EntryPointVersion
  entryPoint: string
  delegate: string
  fees: FeeSource
  bundler: BundlerClient | null
  paymaster: PaymasterHook | null
}

/** 一笔 UserOperation 的结果（对应一批调用） */
interface OpOutcome extends TxOutcome {
  userOpHash: string | null
  /** 账户（sender）地址 */
  sender: string
}

function paymasterHook(p: SmartAccountOptions['paymaster']): PaymasterHook | null {
  if (!p) return null
  return typeof p === 'function' ? p : p.hook
}

/**
 * 智能账户批量执行：同一钱包的调用打成一个（按 batchSize 拆分）UserOperation，由 bundler 或自己（handleOps）打包上链，一个 UserOperation 里的调用原子执行。
 * 结果的 gasUsed / fee 是 UserOperation 的 actualGasUsed / actualGasCost（账户或 paymaster 付的），不含打包交易其余部分
 */
export async function sendSmartBatch(rpc: WriteRpc, calls: readonly NormalizedCall[], options: SmartSendOptions): Promise<WriteResult[]> {
  const so = options.smartAccount ?? {}
  const kind = so.account ?? 'simple'
  const version = so.entryPoint ?? (kind === 'simple7702' ? '0.8' : '0.7')
  if (kind === 'simple7702' && version !== '0.8') {
    throw new Error("The 7702 account (Simple7702Account) only works with EntryPoint v0.8")
  }
  if (!so.bundler && !so.selfBundle) {
    throw new Error('smartAccount.bundler (a bundler URL) or smartAccount.selfBundle is required')
  }
  const ctx: Ctx = {
    rpc,
    options,
    so,
    kind,
    version,
    entryPoint: entryPointAddress(version),
    delegate: getAddress(so.delegate ?? options.delegate ?? SIMPLE_7702_ACCOUNT),
    fees: new FeeSource(rpc, options),
    bundler: so.selfBundle ? null : typeof so.bundler === 'string' ? new BundlerClient(so.bundler) : (so.bundler ?? null),
    paymaster: paymasterHook(so.paymaster),
  }
  const results: WriteResult[] = calls.map((c, i) => toWriteResult(i, c.signer.address, c.to, emptyOutcome('skipped')))
  const report = (indexes: readonly number[], outcome: OpOutcome, failed?: { index: number; reason: string }) => {
    indexes.forEach((i, k) => {
      const c = calls[i] as NormalizedCall
      const o = failed ? (k === failed.index ? { ...outcome, error: failed.reason } : outcome) : outcome
      results[i] = { ...toWriteResult(i, outcome.sender, c.to, o), userOpHash: outcome.userOpHash, atomic: true }
      options.onUpdate?.(results[i] as WriteResult)
    })
  }

  const byWallet = new Map<string, number[]>()
  calls.forEach((c, i) => byWallet.set(c.signer.address.toLowerCase(), [...(byWallet.get(c.signer.address.toLowerCase()) ?? []), i]))
  const batchSize = Math.max(1, options.batchSize ?? 50)
  // 同一个 sponsor 钱包发所有 handleOps：并发会抢 nonce，按顺序发
  await mapPool([...byWallet.values()], so.selfBundle && so.selfBundle !== true ? 1 : (options.concurrency ?? 8), async (indexes) => {
    const signer = (calls[indexes[0] as number] as NormalizedCall).signer
    let stopped = false
    for (let start = 0; start < indexes.length; start += batchSize) {
      const chunk = indexes.slice(start, start + batchSize)
      if (stopped || options.signal?.aborted) {
        report(chunk, { ...emptyOutcome('skipped', options.signal?.aborted ? 'aborted' : 'skipped: a previous batch from this wallet failed'), userOpHash: null, sender: signer.address })
        continue
      }
      const last = start + batchSize >= indexes.length
      let outcome: OpOutcome
      try {
        outcome = await sendOp(ctx, signer, chunk.map((i) => calls[i] as NormalizedCall), last ? options.wait !== false : true)
      } catch (err) {
        outcome = { ...emptyOutcome('failed', failureText(err)), userOpHash: null, sender: signer.address }
      }
      report(chunk, outcome, outcome.status === 'reverted' && outcome.revertData ? (failedIndex(outcome.revertData, chunk.length) ?? undefined) : undefined)
      if (outcome.status !== 'confirmed' && outcome.status !== 'simulated' && !options.continueOnError) stopped = true
    }
  })
  return results
}

/** 账户信息：sender、是否要部署 / 授权 */
interface AccountInfo {
  sender: string
  factory?: string
  factoryData?: string
  /** 账户上已经有代码（可以估算整批的 gas） */
  live: boolean
  /** 需要带 7702 授权 */
  needsAuth: boolean
}

async function accountInfo(ctx: Ctx, signer: ResolvedSigner): Promise<AccountInfo> {
  const { rpc } = ctx
  if (ctx.kind === 'simple') {
    const a = await resolveSimpleAccount(rpc, signer.address, ctx.version, ctx.so.salt, ctx.so.factory)
    return { sender: a.address, live: a.deployed, needsAuth: false, ...(a.deployed ? {} : { factory: a.factory, factoryData: a.factoryData }) }
  }
  if (!signer.local || typeof signer.signer.authorize !== 'function') {
    throw new Error('The 7702 account requires a signer that can sign EIP-7702 authorizations locally (a private key or an ethers Wallet)')
  }
  if ((await rpc.code(ctx.delegate)) === '0x') {
    throw new Error(`The delegate contract ${ctx.delegate} is not deployed on chain ${rpc.chainId}`)
  }
  const { delegated, to } = await delegationOf(rpc, signer.address)
  if (delegated && to !== ctx.delegate && !(ctx.so.redelegate ?? ctx.options.redelegate)) {
    throw new Error(`${signer.address} is already delegated to ${to}; pass redelegate: true to replace it`)
  }
  const needsAuth = !delegated || to !== ctx.delegate
  return { sender: signer.address, live: !needsAuth, needsAuth, ...(needsAuth ? { factory: EIP7702_MARKER, factoryData: '0x' } : {}) }
}

async function readNonce(ctx: Ctx, sender: string): Promise<bigint> {
  const data = await ctx.rpc.call({ to: ctx.entryPoint, data: entryPointInterface.encodeFunctionData('getNonce', [sender, 0]) })
  return entryPointInterface.decodeFunctionResult('getNonce', data)[0] as bigint
}

/** 没有 bundler 时估算 gas：整批能执行时估整批（从 EntryPoint 调账户），否则逐个调用估算后相加 */
async function estimateCallGas(ctx: Ctx, info: AccountInfo, callData: string, items: readonly NormalizedCall[]): Promise<bigint> {
  const multiplier = BigInt(Math.round((ctx.options.gasMultiplier ?? 1.2) * 1000))
  if (info.live) {
    return (await ctx.rpc.estimateGas({ from: ctx.entryPoint, to: info.sender, data: callData })) * multiplier / 1000n + PER_CALL_OVERHEAD
  }
  let total = 0n
  for (const [i, c] of items.entries()) {
    try {
      total += await ctx.rpc.estimateGas({ from: info.sender, to: c.to, data: c.data, value: c.value })
    } catch (err) {
      // 依赖前面调用结果的（先 approve 再兑换）单独估算会失败；第一个调用失败说明批量本身就会失败
      if (i === 0) throw err
      total += FALLBACK_CALL_GAS
    }
    total += PER_CALL_OVERHEAD
  }
  return (total * multiplier) / 1000n
}

async function signOp(ctx: Ctx, signer: ResolvedSigner, op: UserOperation, hash: string): Promise<string> {
  if (ctx.version === '0.8') {
    if (typeof signer.signer.signTypedData !== 'function') throw new Error('The signer does not support signTypedData')
    const { domain, types, message } = userOpTypedData(op, ctx.entryPoint, ctx.rpc.chainId, ctx.delegate)
    return signer.signer.signTypedData(domain, types, message)
  }
  if (typeof signer.signer.signMessage !== 'function') throw new Error('The signer does not support signMessage')
  return signer.signer.signMessage(getBytes(hash))
}

async function signAuth(ctx: Ctx, signer: ResolvedSigner, nonce: number): Promise<Authorization> {
  return (signer.signer.authorize as NonNullable<typeof signer.signer.authorize>)({ address: ctx.delegate, nonce, chainId: ctx.rpc.chainId })
}

async function sendOp(ctx: Ctx, signer: ResolvedSigner, items: readonly NormalizedCall[], wait: boolean): Promise<OpOutcome> {
  const { rpc, options } = ctx
  const info = await accountInfo(ctx, signer)
  const callData = encodeExecuteBatch(ctx.version, items)
  const selfBundle = Boolean(ctx.so.selfBundle)
  const fee = selfBundle ? null : await ctx.fees.get()
  const op: UserOperation = {
    sender: info.sender,
    nonce: await readNonce(ctx, info.sender),
    ...(info.factory ? { factory: info.factory, factoryData: info.factoryData } : {}),
    callData,
    callGasLimit: 0n,
    verificationGasLimit: 0n,
    preVerificationGas: 0n,
    maxFeePerGas: fee?.perGas ?? 0n,
    maxPriorityFeePerGas: fee ? (fee.type === 2 ? (fee.maxPriorityFeePerGas as bigint) : fee.perGas) : 0n,
    signature: DUMMY_SIGNATURE,
  }
  const pmContext = { entryPoint: ctx.entryPoint, chainId: rpc.chainId }
  const hook = ctx.paymaster

  // gas：bundler 估算，或本地估算
  if (ctx.bundler) {
    if (info.needsAuth) {
      // bundler 是别人：授权 nonce 就是钱包当前的 nonce
      op.eip7702Auth = await signAuth(ctx, signer, await rpc.nonce(signer.address))
    }
    if (hook) Object.assign(op, await hook(op, { ...pmContext, stage: 'stub' }))
    Object.assign(op, await ctx.bundler.estimateUserOperationGas(op, ctx.entryPoint))
  } else {
    if (hook) Object.assign(op, await hook(op, { ...pmContext, stage: 'stub' }))
    op.callGasLimit = await estimateCallGas(ctx, info, callData, items)
    op.verificationGasLimit = info.factory ? DEPLOY_VERIFICATION_GAS : VERIFICATION_GAS
    op.preVerificationGas = PRE_VERIFICATION_GAS
  }
  Object.assign(op, ctx.so.gas)
  if (hook) Object.assign(op, await hook({ ...op, signature: DUMMY_SIGNATURE }, { ...pmContext, stage: 'final' }))

  const delegate = info.needsAuth || ctx.kind === 'simple7702' ? ctx.delegate : undefined
  const hash = getUserOpHash(op, ctx.entryPoint, rpc.chainId, ctx.version, delegate)
  op.signature = await signOp(ctx, signer, op, hash)

  if (ctx.bundler) {
    if (options.dryRun) return { ...emptyOutcome('simulated'), gasLimit: op.callGasLimit + op.verificationGasLimit + op.preVerificationGas, userOpHash: hash, sender: info.sender }
    const sent = await ctx.bundler.sendUserOperation(op, ctx.entryPoint)
    if (sent.toLowerCase() !== hash.toLowerCase()) {
      throw new Error(`The bundler returned a different userOpHash (${sent}) than computed locally (${hash}); not tracking it`)
    }
    if (!wait) return { ...emptyOutcome('sent'), userOpHash: hash, sender: info.sender }
    const receipt = await ctx.bundler.waitForUserOperation(hash, options)
    if (!receipt) return { ...emptyOutcome('pending', 'not confirmed in time; the UserOperation may still be included'), userOpHash: hash, sender: info.sender }
    return {
      ...emptyOutcome(receipt.success ? 'confirmed' : 'reverted', receipt.success ? null : 'execution reverted'),
      hash: receipt.transactionHash,
      blockNumber: receipt.blockNumber,
      gasUsed: receipt.actualGasUsed,
      fee: receipt.actualGasCost,
      revertData: receipt.reason && receipt.reason.startsWith('0x') ? receipt.reason : null,
      userOpHash: hash,
      sender: info.sender,
    }
  }

  // 自己打包：bundler 钱包发一笔 handleOps（带 7702 授权时一起带上）
  const bundlerSigner = ctx.so.selfBundle === true ? signer : await resolveSigner(ctx.so.selfBundle as SignerInput)
  if (!bundlerSigner.local) throw new Error('selfBundle requires a signer that can sign transactions locally (a private key or an ethers Wallet)')
  const packed = packUserOp(op)
  const data = entryPointInterface.encodeFunctionData('handleOps', [[packed], bundlerSigner.address])
  const job: TxJob = {
    signer: bundlerSigner,
    build: async (nonce) => {
      let authorizationList: Authorization[] | undefined
      if (info.needsAuth) {
        // 钱包自己发这笔交易时，交易先把 nonce 加一再处理授权
        const authNonce = bundlerSigner.address === signer.address ? (nonce as number) + 1 : await rpc.nonce(signer.address)
        authorizationList = [await signAuth(ctx, signer, authNonce)]
      }
      return { to: ctx.entryPoint, data, value: 0n, authorizationList }
    },
  }
  const [txOutcome] = await sendJobs(rpc, [job], { ...options, wait }, ctx.fees)
  const outcome = txOutcome as TxOutcome
  if (outcome.status === 'failed' && outcome.revertData) {
    outcome.error = decodeFailedOp(outcome.revertData) ?? outcome.error
  }
  const result: OpOutcome = { ...outcome, userOpHash: hash, sender: info.sender }
  if (outcome.status === 'confirmed' && outcome.hash) {
    // 交易成功不代表 UserOperation 成功：看 UserOperationEvent
    const receipt = await rpc.receipt(outcome.hash)
    const event = receipt?.logs.map((l) => parseLog(l)).find((e) => e?.name === 'UserOperationEvent' && String(e.args[0]).toLowerCase() === hash.toLowerCase())
    if (!event) {
      return { ...result, status: 'reverted', error: 'the UserOperation was not executed by the EntryPoint' }
    }
    const reason = receipt?.logs.map((l) => parseLog(l)).find((e) => e?.name === 'UserOperationRevertReason' && String(e.args[0]).toLowerCase() === hash.toLowerCase())
    result.gasUsed = event.args[6] as bigint
    result.fee = event.args[5] as bigint
    if (event.args[4] !== true) {
      const revert = reason ? String(reason.args[3]) : null
      return { ...result, status: 'reverted', error: 'execution reverted', revertData: revert }
    }
  }
  return result
}

const logInterface = new Interface(entryPointInterface.fragments)

function parseLog(log: { topics: readonly string[]; data: string }) {
  try {
    return logInterface.parseLog({ topics: [...log.topics], data: log.data })
  } catch {
    return null
  }
}

/** EntryPoint 的 FailedOp(opIndex, reason)：reason 形如 'AA24 signature error' */
function decodeFailedOp(data: string): string | null {
  try {
    const e = entryPointInterface.parseError(data)
    if (e?.name === 'FailedOp' || e?.name === 'FailedOpWithRevert') {
      const inner = e.name === 'FailedOpWithRevert' ? decodeRevertReason(String(e.args[2])) : null
      return `EntryPoint rejected the UserOperation: ${e.args[1]}${inner ? ` (${inner})` : ''}`
    }
  } catch {
    // 不是 EntryPoint 的错误
  }
  return null
}
