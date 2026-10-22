import { Interface, ZeroAddress, getAddress, getBigInt, hexlify, type Authorization, type BigNumberish } from 'ethers'

import { encodeCall, type Call } from '../call.js'
import { decodeRevertReason } from '../errors.js'
import type { Provider } from '../provider.js'
import { isTronChain } from '../tron.js'
import { WriteRpc } from './rpc.js'
import { emptyOutcome, sendJobs, toWriteResult, type SendOptions, type TronSendOptions, type TxJob, type TxOutcome, type WriteResult } from './send.js'
import type { Eip1193Like } from '../smartAccount/eip5792.js'
import type { SmartAccountOptions } from '../smartAccount/send.js'
import { resolveSigner, type ResolvedSigner, type SignerInput } from './signer.js'

/**
 * EIP-7702 批量执行合约：eth-infinitism 的 Simple7702Account（account-abstraction v0.8），各主流链上地址相同。
 * executeBatch 只允许账户自己（或 EntryPoint）调用，委托后别人无法通过它动用钱包里的资产
 */
export const SIMPLE_7702_ACCOUNT = '0x4Cd241E8d1510e30b2076397afc7508Ae59C66c9'

const accountInterface = new Interface([
  'function executeBatch((address target, uint256 value, bytes data)[] calls)',
  'error ExecuteError(uint256 index, bytes reason)',
])

/** 7702 委托后账户上的代码：0xef0100 + 委托合约地址 */
const DELEGATION_PREFIX = '0xef0100'

/** 一个写调用：目标地址 + calldata，或 Contract 生成的 Call */
export interface WriteCall {
  /** 发送的钱包：私钥或 ethers Signer */
  from: SignerInput
  /** 目标地址（与 data 一起用；不传 call 时必填） */
  to?: string
  /** calldata，默认 '0x'（普通转账） */
  data?: string
  /** 附带的主币（wei） */
  value?: BigNumberish
  /** 或者传 Contract 生成的 Call：`new Contract(token, ERC20_ABI).transfer(to, amount)`；`{ value }` overrides 作为 value */
  call?: Call
  /** 指定 gasLimit 时不预估（7702 模式下忽略，整笔交易统一预估） */
  gasLimit?: bigint
}

export type BatchCallMode = 'tx' | '7702' | '4337' | '5792'

export interface BatchCallOptions extends SendOptions, TronSendOptions {
  /**
   * - 'tx'（默认）：每个调用一笔交易，所有链都支持
   * - '7702'：钱包通过 EIP-7702 委托给批量执行合约，同一钱包的调用合成一笔交易（按 batchSize 拆分），一笔里的调用要么全部成功要么全部失败。
   *   需要链支持 EIP-7702，钱包需要能本地签名（私钥 / ethers Wallet）。委托会一直保留，可用 revokeDelegation 撤销。
   *   传 sponsor 时由 sponsor 钱包发交易并付 gas（用户只签授权和 UserOperation，不需要有主币），见 sponsor
   * - '4337'：ERC-4337 智能账户（smartAccount 选项：bundler / paymaster / selfBundle），一个 UserOperation 原子执行同一钱包的调用，可由 paymaster 代付 gas。
   *   默认账户是 owner 对应的 SimpleAccount（首次使用时部署，资产要放在账户地址里）。子路径 /smart-account
   * - '5792'：浏览器钱包的 EIP-5792（wallet_sendCalls）：钱包支持原子批量时一次确认原子执行，不支持时退回逐笔发送
   */
  mode?: BatchCallMode
  /**
   * 某个调用发送前失败（预估 revert、节点拒绝等）后，同一钱包后面的调用是否继续。默认 false（后面的标记为 skipped）。
   * 交易不等上一笔确认就连续发出，所以已经发出、之后在链上 revert 的交易拦不住后面已发出的交易
   */
  continueOnError?: boolean
  /** 7702：委托的合约，默认 SIMPLE_7702_ACCOUNT */
  delegate?: string
  /** 7702：每笔交易最多打包的调用数，默认 50 */
  batchSize?: number
  /** 7702：钱包已委托给其他合约时改为委托给 delegate。默认 false（报错，不动已有的委托） */
  redelegate?: boolean
  /**
   * '7702' 代付 gas：用这个钱包（私钥 / Signer）发 EntryPoint.handleOps 交易，付 gas 的是它，用户钱包不需要主币。
   * 用户签 EIP-7702 授权（未委托时）+ UserOperation；UserOperation 的 gas 价格为 0，sponsor 拿不到补偿，也不能改调用内容。
   * 用 EntryPoint v0.8 + Simple7702Account
   */
  sponsor?: SignerInput
  /** '4337' 的智能账户选项 */
  smartAccount?: SmartAccountOptions
  /** '5792'：钱包的 provider（EIP-1193 / BrowserProvider）。默认用 from 的 JsonRpcSigner 背后的 provider */
  eip1193?: Eip1193Like
  /** '5792'：要求原子执行，钱包不能原子批量时不退回逐笔发送，直接失败。默认 false */
  atomicRequired?: boolean
  /** '5792'：传给 wallet_sendCalls 的 capabilities（如 `{ paymasterService: { url } }`） */
  capabilities?: Record<string, unknown>
}

/** 归一化后的调用 */
export interface NormalizedCall {
  signer: ResolvedSigner
  to: string
  data: string
  value: bigint
  gasLimit?: bigint
}

export async function normalizeCalls(calls: readonly WriteCall[]): Promise<NormalizedCall[]> {
  const cache = new Map()
  return Promise.all(
    calls.map(async (item, i) => {
      const signer = await resolveSigner(item.from, cache)
      if (item.call) {
        const request = encodeCall(item.call, false)
        const value = item.value ?? item.call.overrides?.value ?? 0n
        return { signer, to: request.target, data: request.callData, value: getBigInt(value), gasLimit: item.gasLimit }
      }
      if (!item.to) {
        throw new Error(`calls[${i}]: either to or call is required`)
      }
      return { signer, to: getAddress(item.to), data: item.data ? hexlify(item.data) : '0x', value: getBigInt(item.value ?? 0n), gasLimit: item.gasLimit }
    }),
  )
}

/**
 * 批量调用合约（写操作）。结果与 calls 一一对应。
 *
 * ```ts
 * const usdt = new Contract(USDT, ERC20_ABI)
 * await batchCall(multi, [
 *   { from: key1, call: usdt.approve(router, amount) },
 *   { from: key1, to: router, data: swapData },             // 依赖上一笔：预估失败时先等 approve 确认再预估
 *   { from: key2, to: someone, value: 10n ** 16n },         // 不同钱包并发发送
 * ])
 * // [{ index: 0, from, to, status: 'confirmed', hash: '0x…', nonce: 7, gasUsed: '46109', fee: '…', … }, …]
 * ```
 *
 * - 'tx' 模式：同一钱包按 nonce 顺序连续发出（不等上一笔确认），不同钱包并发（concurrency）
 * - 依赖前一笔结果的调用：预估失败且同一钱包还有未确认的交易时，先等它们确认再预估一次
 * - 结果的 status 见 WriteStatus；未上链的失败（预估 revert 等）不花手续费
 */
export async function batchCall(provider: Provider, calls: readonly WriteCall[], options: BatchCallOptions = {}): Promise<WriteResult[]> {
  const tron = await tronModule(provider)
  if (tron) {
    return tron.tronBatchCall(provider, calls, options)
  }
  const rpc = await WriteRpc.from(provider)
  const normalized = await normalizeCalls(calls)
  return sendByMode(rpc, normalized, options)
}

/** 按 mode 发送；智能账户 / 5792 的代码按需加载，不用时 /write 的体积不变 */
export async function sendByMode(rpc: WriteRpc, calls: readonly NormalizedCall[], options: BatchCallOptions): Promise<WriteResult[]> {
  const mode = options.mode ?? 'tx'
  if (mode === '7702' && options.sponsor) {
    const { sendSmartBatch } = await import('../smartAccount/send.js')
    return sendSmartBatch(rpc, calls, { ...options, smartAccount: { ...options.smartAccount, account: 'simple7702', entryPoint: '0.8', selfBundle: options.sponsor, bundler: undefined } })
  }
  if (mode === '7702') return send7702(rpc, calls, options)
  if (mode === '4337') {
    const { sendSmartBatch } = await import('../smartAccount/send.js')
    return sendSmartBatch(rpc, calls, options)
  }
  if (mode === '5792') {
    const { send5792 } = await import('../smartAccount/eip5792.js')
    return send5792(rpc, calls, options)
  }
  return sendEach(rpc, calls, options)
}

/** Tron 链上用 Tron 的实现（按需加载：只用 EVM 时打包不会带上） */
export async function tronModule(provider: Provider): Promise<typeof import('./tron.js') | null> {
  return isTronChain(await provider.getChainId()) ? import('./tron.js') : null
}

/** 每个调用一笔交易 */
export async function sendEach(rpc: WriteRpc, calls: readonly NormalizedCall[], options: BatchCallOptions): Promise<WriteResult[]> {
  const results: WriteResult[] = calls.map((c, i) => toWriteResult(i, c.signer.address, c.to, emptyOutcome('skipped')))
  const jobs: TxJob[] = calls.map((c, i) => ({
    signer: c.signer,
    gasLimit: c.gasLimit,
    continueOnError: options.continueOnError,
    build: async () => ({ to: c.to, data: c.data, value: c.value }),
    onUpdate: (outcome) => {
      results[i] = toWriteResult(i, c.signer.address, c.to, outcome)
      options.onUpdate?.(results[i] as WriteResult)
    },
  }))
  const outcomes = await sendJobs(rpc, jobs, options)
  return outcomes.map((outcome, i) => toWriteResult(i, (calls[i] as NormalizedCall).signer.address, (calls[i] as NormalizedCall).to, outcome))
}

/** 钱包当前的委托状态 */
export async function delegationOf(rpc: WriteRpc, address: string): Promise<{ delegated: boolean; to: string | null }> {
  const code = (await rpc.code(address)).toLowerCase()
  if (code === '0x' || code === '') {
    return { delegated: false, to: null }
  }
  if (code.startsWith(DELEGATION_PREFIX) && code.length === 2 + 46) {
    return { delegated: true, to: getAddress(`0x${code.slice(8)}`) }
  }
  throw new Error(`${address} is a contract, not an EOA`)
}

/** 7702 授权：发送者自己就是授权人时，授权的 nonce 要用交易 nonce + 1（交易先把 nonce 加一，再处理授权） */
async function authorize(rpc: WriteRpc, signer: ResolvedSigner, delegate: string, txNonce: number): Promise<Authorization> {
  if (!signer.local || typeof signer.signer.authorize !== 'function') {
    throw new Error("mode '7702' requires a signer that can sign EIP-7702 authorizations locally (a private key or an ethers Wallet)")
  }
  return signer.signer.authorize({ address: delegate, nonce: txNonce + 1, chainId: rpc.chainId })
}

/** 7702：同一钱包的调用合成一笔发给自己的 executeBatch 交易 */
export async function send7702(rpc: WriteRpc, calls: readonly NormalizedCall[], options: BatchCallOptions): Promise<WriteResult[]> {
  const delegate = getAddress(options.delegate ?? SIMPLE_7702_ACCOUNT)
  const batchSize = Math.max(1, options.batchSize ?? 50)
  const results: WriteResult[] = calls.map((c, i) => toWriteResult(i, c.signer.address, c.to, emptyOutcome('skipped')))
  const report = (i: number, outcome: TxOutcome) => {
    const c = calls[i] as NormalizedCall
    results[i] = toWriteResult(i, c.signer.address, c.to, outcome)
    options.onUpdate?.(results[i] as WriteResult)
  }

  // 按钱包分组、拆成每 batchSize 个一笔
  const byWallet = new Map<string, number[]>()
  calls.forEach((c, i) => {
    const key = c.signer.address.toLowerCase()
    byWallet.set(key, [...(byWallet.get(key) ?? []), i])
  })
  const chunks: number[][] = []
  for (const indexes of byWallet.values()) {
    for (let start = 0; start < indexes.length; start += batchSize) {
      chunks.push(indexes.slice(start, start + batchSize))
    }
  }

  // 委托合约必须有代码：EIP-7702 委托给没有代码的地址时调用直接“成功”、什么都不执行，结果会全部报 confirmed
  let deployed: Promise<boolean> | null = null
  const assertDeployed = async () => {
    deployed ??= rpc.code(delegate).then((code) => Boolean(code && code !== '0x'))
    if (!(await deployed)) {
      throw new Error(`The delegate contract ${delegate} is not deployed on chain ${rpc.chainId}; pass delegate to use another one`)
    }
  }

  // 每笔交易发送前查一次委托状态（同一钱包上一笔带授权时，sendJobs 会先等它确认，这时已经委托好了，不必再带授权）
  const checkDelegation = async (signer: ResolvedSigner): Promise<boolean> => {
    const { delegated, to } = await delegationOf(rpc, signer.address)
    if (!delegated) {
      return true
    }
    if (to === delegate) {
      return false
    }
    if (!options.redelegate) {
      throw new Error(`${signer.address} is already delegated to ${to}; pass redelegate: true to replace it`)
    }
    return true
  }

  const jobs: TxJob[] = chunks.map((chunk) => {
    const signer = (calls[chunk[0] as number] as NormalizedCall).signer
    const data = accountInterface.encodeFunctionData('executeBatch', [
      chunk.map((i) => {
        const c = calls[i] as NormalizedCall
        return [c.to, c.value, c.data]
      }),
    ])
    return {
      signer,
      continueOnError: options.continueOnError,
      build: async (nonce) => {
        if (!signer.local || nonce === null) {
          throw new Error("mode '7702' requires a signer that can sign locally (a private key or an ethers Wallet)")
        }
        await assertDeployed()
        let auth: Authorization[] | undefined
        if (await checkDelegation(signer)) {
          // 预估 gas 按 latest 状态执行：钱包还有未确认的交易时，授权 nonce（按 pending 算）在预估里对不上、授权被跳过，
          // 预估出来的 gas 不含批量执行，上链后执行失败、手续费白付。要求先等这些交易确认
          if ((await rpc.latestNonce(signer.address)) !== nonce) {
            throw new Error('The wallet has unconfirmed transactions; EIP-7702 delegation needs them to be confirmed first')
          }
          auth = [await authorize(rpc, signer, delegate, nonce)]
        }
        return { to: signer.address, data, value: 0n, authorizationList: auth }
      },
      onUpdate: (outcome) => {
        if (outcome.status === 'failed' && outcome.revertData) {
          // 预估时 revert：找出是第几个调用失败，其他调用标记为 skipped（整笔没有发出）
          const failed = failedIndex(outcome.revertData, chunk.length)
          if (failed) {
            chunk.forEach((i, k) =>
              report(i, k === failed.index ? { ...outcome, error: failed.reason } : { ...outcome, status: 'skipped', error: 'skipped: another call in the same batch failed' }),
            )
            return
          }
        }
        chunk.forEach((i) => report(i, outcome))
      },
    }
  })
  await sendJobs(rpc, jobs, options)
  return results
}

/** 解析 executeBatch 的 ExecuteError(index, error)；只有一个调用时合约直接透传 revert 数据 */
export function failedIndex(data: string, size: number): { index: number; reason: string } | null {
  if (size === 1) {
    const reason = decodeRevertReason(data)
    return { index: 0, reason: reason ? `execution reverted: ${reason}` : 'execution reverted' }
  }
  try {
    const parsed = accountInterface.parseError(data)
    if (parsed?.name !== 'ExecuteError') {
      return null
    }
    const index = Number(parsed.args[0])
    const reason = decodeRevertReason(String(parsed.args[1]))
    return index < size ? { index, reason: reason ? `execution reverted: ${reason}` : 'execution reverted' } : null
  } catch {
    return null
  }
}

/**
 * 撤销钱包的 EIP-7702 委托（授权给零地址，账户恢复成普通 EOA）。没有委托时直接返回 null，不发交易。
 *
 * ```ts
 * await revokeDelegation(multi, privateKey)
 * ```
 */
export async function revokeDelegation(provider: Provider, from: SignerInput, options: SendOptions = {}): Promise<WriteResult | null> {
  const rpc = await WriteRpc.from(provider) // Tron 没有 EIP-7702：这里会报不支持
  const signer = await resolveSigner(from)
  if (!(await delegationOf(rpc, signer.address)).delegated) {
    return null
  }
  const [outcome] = await sendJobs(
    rpc,
    [
      {
        signer,
        build: async (nonce) => {
          if (nonce === null) {
            throw new Error('revokeDelegation requires a signer that can sign locally (a private key or an ethers Wallet)')
          }
          return { to: signer.address, data: '0x', value: 0n, authorizationList: [await authorize(rpc, signer, ZeroAddress, nonce)] }
        },
        onUpdate: (o) => options.onUpdate?.(toWriteResult(0, signer.address, signer.address, o)),
      },
    ],
    options,
  )
  return toWriteResult(0, signer.address, signer.address, outcome as TxOutcome)
}
