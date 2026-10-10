import { AbiCoder, Interface, concat, dataSlice, id, makeError, type TransactionRequest } from 'ethers'

import { multicall3Interface } from '../src/aggregate.js'
import { DEPLOYLESS_MULTICALL3_BYTECODE } from '../src/deployless.js'
import { MULTICALL3_ADDRESS } from '../src/multicall.js'

export interface CallContext {
  from?: string
  value?: bigint
}

type Handler = (callData: string, ctx: CallContext) => { success: boolean; returnData: string }

interface Call3 {
  target: string
  allowFailure: boolean
  callData: string
}

export const erc20Interface = new Interface([
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function balanceOf(address owner) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
  'function boom() view returns (uint256)',
  'function deposit() payable returns (uint256 received)',
  'function whoami() view returns (address)',
])

/** 一个按 ERC20 规则应答的假合约 */
export function fakeToken(symbol: string, decimals: number, balances: Record<string, bigint> = {}): Handler {
  return (callData, ctx) => {
    const tx = erc20Interface.parseTransaction({ data: callData })
    if (!tx) {
      return { success: false, returnData: '0x' }
    }
    switch (tx.name) {
      case 'symbol':
        return { success: true, returnData: erc20Interface.encodeFunctionResult('symbol', [symbol]) }
      case 'decimals':
        return { success: true, returnData: erc20Interface.encodeFunctionResult('decimals', [decimals]) }
      case 'balanceOf':
        return {
          success: true,
          returnData: erc20Interface.encodeFunctionResult('balanceOf', [balances[String(tx.args[0]).toLowerCase()] ?? 0n]),
        }
      case 'allowance':
        return { success: true, returnData: erc20Interface.encodeFunctionResult('allowance', [123n]) }
      case 'getReserves':
        return { success: true, returnData: erc20Interface.encodeFunctionResult('getReserves', [1n, 2n, 3n]) }
      case 'deposit':
        return ctx.value
          ? { success: true, returnData: erc20Interface.encodeFunctionResult('deposit', [ctx.value]) }
          : { success: false, returnData: erc20Interface.encodeErrorResult('Error', ['no value']) }
      case 'whoami':
        return { success: true, returnData: erc20Interface.encodeFunctionResult('whoami', [ctx.from ?? ZERO]) }
      case 'boom':
        return { success: false, returnData: erc20Interface.encodeErrorResult('Error', ['boom!']) }
      default:
        return { success: false, returnData: '0x' }
    }
  }
}

const ZERO = '0x0000000000000000000000000000000000000000'

let dropRevertData = false

function revert(data: string): never {
  throw makeError('execution reverted', 'CALL_EXCEPTION', {
    action: 'call',
    data: dropRevertData ? null : data,
    reason: null,
    transaction: { to: null, data: '0x' },
    invocation: null,
    revert: null,
  })
}

export interface MockOptions {
  contracts?: Record<string, Handler>
  /** 部署了 Multicall3 的地址（小写）；其他地址被当作无代码 */
  multicallAddresses?: string[]
  balances?: Record<string, bigint>
  /** 模拟 EIP-170：deployless 返回超过这个字节数时改走 revert Aggregate3Result（默认 24576） */
  maxCodeSize?: number
  /** 模拟会丢掉 revert 数据的钱包 / 中间层 */
  dropRevertData?: boolean
  /** 模拟合约里读主币余额恒为 0 的链（getEthBalance / BALANCE 都返回 0，eth_getBalance 正常） */
  zeroNativeInContract?: boolean
  /** 节点当前的区块高度（默认 1 亿）；查询更高的区块时报 header not found */
  blockNumber?: number | (() => number)
  /** 模拟查询未来区块时不报错、直接按最新状态返回的节点（如 HyperEVM） */
  ignoreFutureBlock?: boolean
}

/**
 * 模拟节点：能执行部署在 multicallAddresses 上的 aggregate3 / getEthBalance，以及 deployless 的创建调用。
 * 记录每一次 call / getBalance 方便断言请求次数。
 */
export function createMockProvider(options: MockOptions = {}) {
  const contracts = Object.fromEntries(
    Object.entries(options.contracts ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
  )
  const multicalls = new Set((options.multicallAddresses ?? []).map((a) => a.toLowerCase()))
  const balances = Object.fromEntries(Object.entries(options.balances ?? {}).map(([k, v]) => [k.toLowerCase(), v]))

  const maxCodeSize = options.maxCodeSize ?? 24576

  const calls: TransactionRequest[] = []
  const balanceCalls: string[] = []
  const height = () => (typeof options.blockNumber === 'function' ? options.blockNumber() : (options.blockNumber ?? 100_000_000))
  /** 本次请求读取的区块：指定了数字区块就是它，否则是当前高度 */
  const currentBlock = (tag: unknown) =>
    typeof tag === 'number' || typeof tag === 'bigint' || (typeof tag === 'string' && /^0x/.test(tag)) ? Math.min(Number(tag), options.ignoreFutureBlock ? height() : Number(tag)) : height()
  let currentTag: unknown
  const checkBlock = (tag: unknown) => {
    if (!options.ignoreFutureBlock && currentBlock(tag) > height()) {
      // 节点还没有这个区块（geth：header not found）；ethers 包装成 CALL_EXCEPTION，但不是执行错误
      throw makeError('missing revert data', 'CALL_EXCEPTION', {
        action: 'call',
        data: null,
        reason: null,
        transaction: { to: null, data: '0x' },
        invocation: null,
        revert: null,
        info: { error: { code: -32000, message: 'header not found' } },
      })
    }
  }

  function exec(call3s: Call3[], multicallAddress: string | null) {
    return call3s.map((c) => {
      const target = c.target.toLowerCase()
      let result: { success: boolean; returnData: string }
      const balanceTarget = multicallAddress ?? MULTICALL3_ADDRESS.toLowerCase()
      if (target === balanceTarget && c.callData === multicall3Interface.encodeFunctionData('getBlockNumber')) {
        result = { success: true, returnData: multicall3Interface.encodeFunctionResult('getBlockNumber', [BigInt(currentBlock(currentTag))]) }
      } else if (target === balanceTarget && c.callData.startsWith(multicall3Interface.getFunction('getEthBalance')!.selector)) {
        const parsed = multicall3Interface.parseTransaction({ data: c.callData })
        const balance = options.zeroNativeInContract ? 0n : (balances[String(parsed?.args[0]).toLowerCase()] ?? 0n)
        result = { success: true, returnData: multicall3Interface.encodeFunctionResult('getEthBalance', [balance]) }
      } else if (contracts[target]) {
        // multicall 内部调用时 msg.sender 是 multicall 合约
        result = contracts[target](c.callData, { from: multicallAddress ?? undefined })
      } else {
        // 对无代码地址的调用：成功但返回空数据
        result = { success: true, returnData: '0x' }
      }
      if (!result.success && !c.allowFailure) {
        revert(multicall3Interface.encodeErrorResult('Error', ['Multicall3: call failed']))
      }
      return [result.success, result.returnData] as const
    })
  }

  const provider = {
    calls,
    balanceCalls,
    async call(tx: TransactionRequest): Promise<string> {
      calls.push(tx)
      checkBlock(tx.blockTag)
      currentTag = tx.blockTag
      dropRevertData = Boolean(options.dropRevertData)
      const data = String(tx.data)
      if (!tx.to) {
        const args = dataSlice(data, (DEPLOYLESS_MULTICALL3_BYTECODE.length - 2) / 2)
        const [call3s] = AbiCoder.defaultAbiCoder().decode(['tuple(address target, bool allowFailure, bytes callData)[]'], args)
        const results = exec(call3s as Call3[], null)
        const out = AbiCoder.defaultAbiCoder().encode(['tuple(bool success, bytes returnData)[]'], [results])
        if ((out.length - 2) / 2 > maxCodeSize) {
          revert(concat([id('Aggregate3Result((bool,bytes)[])').slice(0, 10), out]))
        }
        return out
      }
      const to = String(tx.to).toLowerCase()
      if (contracts[to]) {
        const result = contracts[to](data, {
          from: tx.from ? String(tx.from) : undefined,
          value: tx.value ? BigInt(tx.value) : undefined,
        })
        return result.success ? result.returnData : revert(result.returnData)
      }
      if (!multicalls.has(to)) {
        return '0x'
      }
      const parsed = multicall3Interface.parseTransaction({ data })
      return multicall3Interface.encodeFunctionResult('aggregate3', [exec(parsed?.args[0] as Call3[], to)])
    },
    async getBalance(address: string, blockTag?: unknown): Promise<bigint> {
      balanceCalls.push(address)
      checkBlock(blockTag)
      return balances[address.toLowerCase()] ?? 0n
    },
  }
  return provider
}
