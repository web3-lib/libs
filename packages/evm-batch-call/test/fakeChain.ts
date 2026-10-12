import { Interface, Transaction, getAddress, makeError, verifyAuthorization, type TransactionRequest } from 'ethers'

import { MULTICALL3_ADDRESS } from '../src/multicall.js'
import { SIMPLE_7702_ACCOUNT } from '../src/write/batch.js'
import { DISPERSE_ADDRESS } from '../src/write/transfer.js'
import { createMockProvider } from './mockProvider.js'

export const CHAIN_ID = 56
export const GAS_PRICE = 1_000_000_000n // getFeeData：maxFee = 2 gwei，priority = 1 gwei
export const MAX_FEE = 2_000_000_000n

const tokenInterface = new Interface([
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function balanceOf(address owner) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'function transferFrom(address from, address to, uint256 amount) returns (bool)',
])
const disperseInterface = new Interface([
  'function disperseEther(address[] recipients, uint256[] values) payable',
  'function disperseToken(address token, address[] recipients, uint256[] values)',
])
const accountInterface = new Interface([
  'function executeBatch((address target, uint256 value, bytes data)[] calls)',
  'error ExecuteError(uint256 index, bytes reason)',
])
const errorInterface = new Interface(['error Error(string)'])

interface TokenState {
  symbol: string
  decimals: number
  balances: Map<string, bigint>
  allowances: Map<string, bigint>
  /** 转账时拒绝的收款地址（模拟黑名单） */
  blocked: Set<string>
}

interface State {
  native: Map<string, bigint>
  nonces: Map<string, number>
  code: Map<string, string>
  tokens: Map<string, TokenState>
}

class Revert extends Error {
  constructor(readonly data: string) {
    super('execution reverted')
  }
}

function revertWith(reason: string): never {
  throw new Revert(errorInterface.encodeErrorResult('Error', [reason]))
}

const k = (address: string) => address.toLowerCase()

function clone(state: State): State {
  return {
    native: new Map(state.native),
    nonces: new Map(state.nonces),
    code: new Map(state.code),
    tokens: new Map(
      [...state.tokens].map(([key, t]) => [key, { ...t, balances: new Map(t.balances), allowances: new Map(t.allowances), blocked: new Set(t.blocked) }]),
    ),
  }
}

export interface FakeChainOptions {
  /** 链上有没有 Disperse 合约，默认 true */
  disperse?: boolean
  /** 链上有没有 Simple7702Account，默认 true */
  simple7702?: boolean
  /** 广播后过几次查回执才出块，默认 0（立即出块） */
  mineAfterPolls?: number
  /** 不支持 7702 的链 */
  no7702?: boolean
  /** 前几次查回执时返回 null（节点落后，还没有这笔回执） */
  receiptLag?: number
  /** 广播时节点用这个 JSON-RPC 错误明确拒绝（不在已知的错误列表里） */
  rejectBroadcast?: string
  /** 预估 gas 时发送方没有主币就报余额不足（有的节点这样） */
  estimateNeedsGas?: boolean
  /** pending nonce 不算交易池里的交易（模拟多节点时先返回的节点还没收到刚发出的交易） */
  nonceIgnoresPending?: boolean
  /** 前几次广播：交易照常进交易池，但节点返回超时错误 */
  flakyBroadcasts?: number
}

/**
 * 假链：执行签名交易（主币转账、ERC20、Disperse、7702 executeBatch），读操作走 multicall（mockProvider），主币余额走 eth_getBalance（Provider 需配 nativeBalance: 'rpc'）
 */
export function createFakeChain(options: FakeChainOptions = {}) {
  let state: State = { native: new Map(), nonces: new Map(), code: new Map(), tokens: new Map() }
  if (options.disperse ?? true) {
    state.code.set(k(DISPERSE_ADDRESS), '0x6080')
  }
  if (options.simple7702 ?? true) {
    state.code.set(k(SIMPLE_7702_ACCOUNT), '0x6080')
  }
  let block = 1000
  let fees = { gasPrice: GAS_PRICE, maxFeePerGas: MAX_FEE, maxPriorityFeePerGas: GAS_PRICE }
  let flaky = options.flakyBroadcasts ?? 0
  /** 代币 transfer 消耗的 gas（默认 50000） */
  const transferGas = new Map<string, number>()
  /** 每出一个块后调用（测试里模拟时间流逝、费用变化） */
  const hooks: { afterMine?: (tx: Transaction) => void } = {}
  const receipts = new Map<string, { status: number; gasUsed: bigint; fee: bigint; blockNumber: number; hash: string }>()
  const pending: Array<{ hash: string; polls: number; tx: Transaction }> = []
  const broadcasts: Transaction[] = []
  let receiptLag = options.receiptLag ?? 0

  const token = (address: string) => state.tokens.get(k(address))

  // 读：view 函数对当前状态应答（multicall 内部调用）
  const viewHandler = (address: string) => (callData: string) => {
    const t = token(address) as TokenState
    const parsed = tokenInterface.parseTransaction({ data: callData })
    switch (parsed?.name) {
      case 'symbol':
        return { success: true, returnData: tokenInterface.encodeFunctionResult('symbol', [t.symbol]) }
      case 'decimals':
        return { success: true, returnData: tokenInterface.encodeFunctionResult('decimals', [t.decimals]) }
      case 'balanceOf':
        return { success: true, returnData: tokenInterface.encodeFunctionResult('balanceOf', [t.balances.get(k(parsed.args[0])) ?? 0n]) }
      case 'allowance':
        return { success: true, returnData: tokenInterface.encodeFunctionResult('allowance', [t.allowances.get(`${k(parsed.args[0])}:${k(parsed.args[1])}`) ?? 0n]) }
      default:
        return { success: false, returnData: '0x' }
    }
  }
  const contracts: Record<string, ReturnType<typeof viewHandler>> = {}
  // mockProvider 创建时复制 contracts，这里每次读都按当前的代币表新建
  const read = (tx: TransactionRequest) => createMockProvider({ contracts, multicallAddresses: [MULTICALL3_ADDRESS] }).call(tx)

  /** 执行一个调用（msg.sender = from），失败抛 Revert */
  function exec(s: State, from: string, to: string, value: bigint, data: string): number {
    const fromBal = s.native.get(k(from)) ?? 0n
    if (fromBal < value) {
      revertWith('insufficient native balance')
    }
    s.native.set(k(from), fromBal - value)
    s.native.set(k(to), (s.native.get(k(to)) ?? 0n) + value)
    const code = s.code.get(k(to))
    const t = s.tokens.get(k(to))
    if (t) {
      const parsed = tokenInterface.parseTransaction({ data })
      const move = (src: string, dst: string, amount: bigint) => {
        if (t.blocked.has(k(dst))) {
          revertWith('blocked recipient')
        }
        const bal = t.balances.get(k(src)) ?? 0n
        if (bal < amount) {
          revertWith('ERC20: transfer amount exceeds balance')
        }
        t.balances.set(k(src), bal - amount)
        t.balances.set(k(dst), (t.balances.get(k(dst)) ?? 0n) + amount)
      }
      switch (parsed?.name) {
        case 'transfer':
          move(from, parsed.args[0], parsed.args[1])
          return transferGas.get(k(to)) ?? 50_000
        case 'approve':
          t.allowances.set(`${k(from)}:${k(parsed.args[0])}`, parsed.args[1])
          return 46_000
        case 'transferFrom': {
          const key = `${k(parsed.args[0])}:${k(from)}`
          const allowance = t.allowances.get(key) ?? 0n
          if (allowance < parsed.args[2]) {
            revertWith('ERC20: insufficient allowance')
          }
          t.allowances.set(key, allowance - parsed.args[2])
          move(parsed.args[0], parsed.args[1], parsed.args[2])
          return 60_000
        }
        default:
          revertWith('unknown token method')
      }
    }
    if (k(to) === k(DISPERSE_ADDRESS) && code) {
      const parsed = disperseInterface.parseTransaction({ data })
      if (parsed?.name === 'disperseEther') {
        const [recipients, values] = parsed.args as unknown as [string[], bigint[]]
        recipients.forEach((r, i) => exec(s, DISPERSE_ADDRESS, r, values[i] as bigint, '0x'))
        return 30_000 * recipients.length
      }
      if (parsed?.name === 'disperseToken') {
        const [tokenAddress, recipients, values] = parsed.args as unknown as [string, string[], bigint[]]
        const total = values.reduce((a, b) => a + b, 0n)
        exec(s, DISPERSE_ADDRESS, tokenAddress, 0n, tokenInterface.encodeFunctionData('transferFrom', [from, DISPERSE_ADDRESS, total]))
        recipients.forEach((r, i) => exec(s, DISPERSE_ADDRESS, tokenAddress, 0n, tokenInterface.encodeFunctionData('transfer', [r, values[i]])))
        return 40_000 * recipients.length
      }
      revertWith('unknown disperse method')
    }
    // 委托给没有代码的地址：与真实 EVM 一致，按空代码执行，调用直接成功、什么都不做
    if (code?.startsWith('0xef0100') && !s.code.has(`0x${code.slice(8)}`)) {
      return 21_000
    }
    // 委托给有代码的合约：按 Simple7702Account 执行
    if (code?.startsWith('0xef0100') && s.code.has(`0x${code.slice(8)}`) && data !== '0x') {
      if (k(from) !== k(to)) {
        revertWith('NotFromEntryPoint')
      }
      const parsed = accountInterface.parseTransaction({ data })
      const calls = parsed?.args[0] as Array<[string, bigint, string]>
      let gas = 30_000
      calls.forEach(([target, v, d], i) => {
        try {
          gas += exec(s, to, target, v, d)
        } catch (err) {
          if (calls.length === 1) {
            throw err
          }
          throw new Revert(accountInterface.encodeErrorResult('ExecuteError', [i, (err as Revert).data ?? '0x']))
        }
      })
      return gas
    }
    if (code && data !== '0x') {
      revertWith('no such method')
    }
    return 21_000
  }

  /** 执行整笔交易（含 7702 授权），返回 gasUsed；失败抛 Revert（授权已生效、nonce 已加） */
  function apply(s: State, from: string, tx: TransactionRequest & { authorizationList?: Transaction['authorizationList'] }): number {
    let gas = 0
    for (const auth of tx.authorizationList ?? []) {
      if (options.no7702) {
        throw makeError('transaction type not supported', 'UNKNOWN_ERROR', {})
      }
      const authority = verifyAuthorization({ address: auth.address, nonce: auth.nonce, chainId: auth.chainId }, auth.signature)
      const expected = BigInt(s.nonces.get(k(authority)) ?? 0)
      if (BigInt(auth.nonce) !== expected) {
        continue // nonce 不对：跳过（与链上一致）
      }
      s.nonces.set(k(authority), Number(expected) + 1)
      s.code.set(k(authority), getAddress(auth.address) === getAddress('0x0000000000000000000000000000000000000000') ? '0x' : `0xef0100${k(auth.address).slice(2)}`)
      gas += 25_000
    }
    return gas + exec(s, from, String(tx.to), BigInt(tx.value ?? 0n), String(tx.data ?? '0x'))
  }

  function revertError(err: unknown): never {
    if (err instanceof Revert) {
      throw makeError('execution reverted', 'CALL_EXCEPTION', { action: 'estimateGas', data: err.data, reason: null, transaction: { to: null, data: '0x' }, invocation: null, revert: null })
    }
    throw err
  }

  function mine(entry: { hash: string; tx: Transaction }) {
    const tx = entry.tx
    const from = tx.from as string
    const price = tx.maxFeePerGas ?? tx.gasPrice ?? 0n
    const next = clone(state)
    next.nonces.set(k(from), (next.nonces.get(k(from)) ?? 0) + 1)
    let status = 1
    let gasUsed: number
    const attempt = clone(next)
    try {
      gasUsed = apply(attempt, from, tx)
      state = attempt
    } catch {
      status = 0
      gasUsed = Number(tx.gasLimit)
      state = next
    }
    if (BigInt(gasUsed) > tx.gasLimit) {
      status = 0
      gasUsed = Number(tx.gasLimit)
      state = next
    }
    const fee = BigInt(gasUsed) * price
    state.native.set(k(from), (state.native.get(k(from)) ?? 0n) - fee)
    receipts.set(entry.hash, { status, gasUsed: BigInt(gasUsed), fee, blockNumber: ++block, hash: entry.hash })
    hooks.afterMine?.(tx)
  }

  const node = {
    call: read,
    async getBalance(address: string): Promise<bigint> {
      return state.native.get(k(address)) ?? 0n
    },
    async getTransactionCount(address: string, blockTag?: string): Promise<number> {
      const queued = options.nonceIgnoresPending || blockTag === 'latest' ? 0 : pending.filter((p) => k(p.tx.from as string) === k(address)).length
      return (state.nonces.get(k(address)) ?? 0) + queued
    },
    async getCode(address: string): Promise<string> {
      return state.code.get(k(address)) ?? '0x'
    },
    async getFeeData() {
      return fees
    },
    async estimateGas(tx: TransactionRequest & { authorizationList?: Transaction['authorizationList'] }): Promise<bigint> {
      const s = clone(state)
      if (options.estimateNeedsGas && (s.native.get(k(String(tx.from))) ?? 0n) === 0n) {
        throw makeError('insufficient funds for gas * price + value', 'INSUFFICIENT_FUNDS', { transaction: {} })
      }
      // 待确认的交易不计入（与真实节点按 latest 预估一致）
      if (tx.authorizationList?.length) {
        s.nonces.set(k(String(tx.from)), (s.nonces.get(k(String(tx.from))) ?? 0) + 1)
      }
      try {
        return BigInt(apply(s, String(tx.from), tx))
      } catch (err) {
        revertError(err)
      }
    },
    async broadcastTransaction(signed: string) {
      const tx = Transaction.from(signed)
      broadcasts.push(tx)
      const hash = tx.hash as string
      if (options.rejectBroadcast) {
        throw makeError('could not coalesce error', 'UNKNOWN_ERROR', { error: { code: -32000, message: options.rejectBroadcast } })
      }
      // 与 geth 一致：已上链的交易再发报 nonce too low，还在交易池里的报 already known
      if (receipts.has(hash)) {
        throw makeError('nonce too low', 'NONCE_EXPIRED', { transaction: tx })
      }
      if (pending.some((p) => p.hash === hash)) {
        throw makeError('already known', 'UNKNOWN_ERROR', {})
      }
      const from = tx.from as string
      const expected = (state.nonces.get(k(from)) ?? 0) + pending.filter((p) => k(p.tx.from as string) === k(from)).length
      if (tx.nonce < expected) {
        throw makeError('nonce too low', 'NONCE_EXPIRED', { transaction: tx })
      }
      if (tx.chainId !== BigInt(CHAIN_ID)) {
        throw makeError('invalid chain id', 'UNKNOWN_ERROR', {})
      }
      const cost = tx.gasLimit * (tx.maxFeePerGas ?? tx.gasPrice ?? 0n) + tx.value
      const queuedCost = pending.filter((p) => k(p.tx.from as string) === k(from)).reduce((sum, p) => sum + p.tx.gasLimit * (p.tx.maxFeePerGas ?? p.tx.gasPrice ?? 0n) + p.tx.value, 0n)
      if ((state.native.get(k(from)) ?? 0n) < cost + queuedCost) {
        throw makeError('insufficient funds for gas * price + value', 'INSUFFICIENT_FUNDS', { transaction: tx })
      }
      const entry = { hash, polls: 0, tx }
      if (!options.mineAfterPolls) {
        mine(entry)
      } else {
        pending.push(entry)
      }
      if (flaky > 0) {
        flaky--
        throw makeError('request timeout', 'TIMEOUT', { operation: 'broadcastTransaction', reason: 'timeout' })
      }
      return { hash }
    },
    async getTransactionReceipt(hash: string) {
      if (receiptLag > 0) {
        receiptLag--
        return null
      }
      // 按顺序出块：先到期的先出
      for (const entry of [...pending]) {
        if (++entry.polls > (options.mineAfterPolls ?? 0)) {
          pending.splice(pending.indexOf(entry), 1)
          mine(entry)
        } else {
          break
        }
      }
      return receipts.get(hash) ?? null
    },
  }

  return {
    node,
    hooks,
    broadcasts,
    receipts,
    get state() {
      return state
    },
    setNative(address: string, amount: bigint) {
      state.native.set(k(address), amount)
    },
    setFees(gasPrice: bigint, maxFeePerGas: bigint) {
      fees = { gasPrice, maxFeePerGas, maxPriorityFeePerGas: gasPrice }
    },
    setTransferGas(tokenAddress: string, gas: number) {
      transferGas.set(k(tokenAddress), gas)
    },
    native(address: string) {
      return state.native.get(k(address)) ?? 0n
    },
    addToken(address: string, symbol: string, decimals: number, balances: Record<string, bigint> = {}) {
      state.tokens.set(k(address), { symbol, decimals, balances: new Map(Object.entries(balances).map(([a, b]) => [k(a), b])), allowances: new Map(), blocked: new Set() })
      contracts[k(address)] = viewHandler(address)
      state.code.set(k(address), '0x6080')
    },
    tokenBalance(tokenAddress: string, owner: string) {
      return token(tokenAddress)?.balances.get(k(owner)) ?? 0n
    },
    allowance(tokenAddress: string, owner: string, spender: string) {
      return token(tokenAddress)?.allowances.get(`${k(owner)}:${k(spender)}`) ?? 0n
    },
    block(tokenAddress: string, recipient: string) {
      token(tokenAddress)?.blocked.add(k(recipient))
    },
    code(address: string) {
      return state.code.get(k(address)) ?? '0x'
    },
  }
}
