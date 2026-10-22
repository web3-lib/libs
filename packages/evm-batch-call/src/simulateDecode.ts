/**
 * 模拟用的解码：calldata（ERC20 / 721 / 1155、WETH、Uniswap V2 / V3 Router、Universal Router、V3 仓位合约、Permit2、Multicall3、Disperse，
 * 其中 Router / 仓位合约的地址按内置协议表标出协议名）和 revert 数据（Error / Panic、常见的自定义错误）。
 * 不查网络（不用 4byte）：认不出的选择器返回 unknown 和原始选择器。
 */
import { Interface, dataSlice, type FunctionFragment, type Result } from 'ethers'

import { knownSpenders } from './approvals.js'
import { decodeRevertReason } from './errors.js'

export type DecodedType = 'transfer' | 'swap' | 'approve' | 'liquidity' | 'contract' | 'unknown'

export interface DecodedCall {
  type: DecodedType
  /** 协议 / 合约名：Router 地址在内置协议表里时用表里的名字，否则是 ABI 所属的类别（如 "Uniswap V2 Router"） */
  protocol?: string
  /** 方法名（unknown 时没有） */
  method?: string
  /** 一句话描述（simulate 会在有余额变化时补上数量） */
  summary: string
  /** 参数（地址 / 数字都是字符串，可以直接 JSON 序列化）；unknown 时是 { selector } */
  args?: Record<string, unknown>
  /** multicall / Universal Router 等里面包含的子调用 */
  calls?: DecodedCall[]
}

interface Group {
  name: string
  abi: string[]
}

const TOKEN_ID = 'tuple(address token, uint160 amount, uint48 expiration, uint48 nonce)'

const GROUPS: Group[] = [
  {
    name: 'Token',
    abi: [
      'function transfer(address to, uint256 amount)',
      'function transferFrom(address from, address to, uint256 amount)',
      'function approve(address spender, uint256 amount)',
      'function increaseAllowance(address spender, uint256 amount)',
      'function decreaseAllowance(address spender, uint256 amount)',
      'function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)',
      'function setApprovalForAll(address operator, bool approved)',
      'function safeTransferFrom(address from, address to, uint256 tokenId)',
      'function safeTransferFrom(address from, address to, uint256 tokenId, bytes data)',
      'function safeTransferFrom(address from, address to, uint256 id, uint256 amount, bytes data)',
      'function safeBatchTransferFrom(address from, address to, uint256[] ids, uint256[] amounts, bytes data)',
      'function deposit() payable',
      'function withdraw(uint256 amount)',
    ],
  },
  {
    name: 'Uniswap V2 Router',
    abi: [
      'function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline)',
      'function swapTokensForExactTokens(uint256 amountOut, uint256 amountInMax, address[] path, address to, uint256 deadline)',
      'function swapExactETHForTokens(uint256 amountOutMin, address[] path, address to, uint256 deadline) payable',
      'function swapTokensForExactETH(uint256 amountOut, uint256 amountInMax, address[] path, address to, uint256 deadline)',
      'function swapExactTokensForETH(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline)',
      'function swapETHForExactTokens(uint256 amountOut, address[] path, address to, uint256 deadline) payable',
      'function swapExactTokensForTokensSupportingFeeOnTransferTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline)',
      'function swapExactETHForTokensSupportingFeeOnTransferTokens(uint256 amountOutMin, address[] path, address to, uint256 deadline) payable',
      'function swapExactTokensForETHSupportingFeeOnTransferTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline)',
      'function addLiquidity(address tokenA, address tokenB, uint256 amountADesired, uint256 amountBDesired, uint256 amountAMin, uint256 amountBMin, address to, uint256 deadline)',
      'function addLiquidityETH(address token, uint256 amountTokenDesired, uint256 amountTokenMin, uint256 amountETHMin, address to, uint256 deadline) payable',
      'function removeLiquidity(address tokenA, address tokenB, uint256 liquidity, uint256 amountAMin, uint256 amountBMin, address to, uint256 deadline)',
      'function removeLiquidityETH(address token, uint256 liquidity, uint256 amountTokenMin, uint256 amountETHMin, address to, uint256 deadline)',
      'function removeLiquidityETHSupportingFeeOnTransferTokens(address token, uint256 liquidity, uint256 amountTokenMin, uint256 amountETHMin, address to, uint256 deadline)',
    ],
  },
  {
    name: 'Uniswap V3 Router',
    abi: [
      // SwapRouter（struct 里有 deadline）和 SwapRouter02（没有）
      'function exactInputSingle(tuple(address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) payable',
      'function exactInput(tuple(bytes path, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum) params) payable',
      'function exactOutputSingle(tuple(address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 deadline, uint256 amountOut, uint256 amountInMaximum, uint160 sqrtPriceLimitX96) params) payable',
      'function exactOutput(tuple(bytes path, address recipient, uint256 deadline, uint256 amountOut, uint256 amountInMaximum) params) payable',
      'function exactInputSingle(tuple(address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) payable',
      'function exactInput(tuple(bytes path, address recipient, uint256 amountIn, uint256 amountOutMinimum) params) payable',
      'function exactOutputSingle(tuple(address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountOut, uint256 amountInMaximum, uint160 sqrtPriceLimitX96) params) payable',
      'function exactOutput(tuple(bytes path, address recipient, uint256 amountOut, uint256 amountInMaximum) params) payable',
      'function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to) payable',
      'function swapTokensForExactTokens(uint256 amountOut, uint256 amountInMax, address[] path, address to) payable',
      'function multicall(uint256 deadline, bytes[] data) payable',
      'function multicall(bytes32 previousBlockhash, bytes[] data) payable',
      'function multicall(bytes[] data) payable',
      'function unwrapWETH9(uint256 amountMinimum, address recipient) payable',
      'function unwrapWETH9(uint256 amountMinimum) payable',
      'function wrapETH(uint256 value) payable',
      'function refundETH() payable',
      'function sweepToken(address token, uint256 amountMinimum, address recipient) payable',
      'function sweepToken(address token, uint256 amountMinimum) payable',
    ],
  },
  {
    name: 'Uniswap V3 Positions',
    abi: [
      'function mint(tuple(address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint256 amount0Desired, uint256 amount1Desired, uint256 amount0Min, uint256 amount1Min, address recipient, uint256 deadline) params) payable',
      'function increaseLiquidity(tuple(uint256 tokenId, uint256 amount0Desired, uint256 amount1Desired, uint256 amount0Min, uint256 amount1Min, uint256 deadline) params) payable',
      'function decreaseLiquidity(tuple(uint256 tokenId, uint128 liquidity, uint256 amount0Min, uint256 amount1Min, uint256 deadline) params) payable',
      'function collect(tuple(uint256 tokenId, address recipient, uint128 amount0Max, uint128 amount1Max) params) payable',
      'function burn(uint256 tokenId) payable',
      'function createAndInitializePoolIfNecessary(address token0, address token1, uint24 fee, uint160 sqrtPriceX96) payable',
      'function modifyLiquidities(bytes unlockData, uint256 deadline) payable',
    ],
  },
  {
    name: 'Universal Router',
    abi: ['function execute(bytes commands, bytes[] inputs, uint256 deadline) payable', 'function execute(bytes commands, bytes[] inputs) payable'],
  },
  {
    name: 'Permit2',
    abi: [
      'function approve(address token, address spender, uint160 amount, uint48 expiration)',
      `function permit(address owner, tuple(${TOKEN_ID} details, address spender, uint256 sigDeadline) permitSingle, bytes signature)`,
      `function permit(address owner, tuple(${TOKEN_ID}[] details, address spender, uint256 sigDeadline) permitBatch, bytes signature)`,
      'function transferFrom(address from, address to, uint160 amount, address token)',
      'function lockdown(tuple(address token, address spender)[] approvals)',
      'function invalidateNonces(address token, address spender, uint48 newNonce)',
    ],
  },
  {
    name: 'Multicall3',
    abi: [
      'function aggregate(tuple(address target, bytes callData)[] calls) payable',
      'function tryAggregate(bool requireSuccess, tuple(address target, bytes callData)[] calls) payable',
      'function aggregate3(tuple(address target, bool allowFailure, bytes callData)[] calls) payable',
      'function aggregate3Value(tuple(address target, bool allowFailure, uint256 value, bytes callData)[] calls) payable',
    ],
  },
  {
    name: 'Disperse',
    abi: ['function disperseEther(address[] recipients, uint256[] values) payable', 'function disperseToken(address token, address[] recipients, uint256[] values)'],
  },
  { name: 'Smart account', abi: ['function executeBatch(tuple(address target, uint256 value, bytes data)[] calls)'] },
]

interface Entry {
  fragment: FunctionFragment
  iface: Interface
  group: string
}

let table: Map<string, Entry> | null = null

function entries(): Map<string, Entry> {
  if (!table) {
    table = new Map()
    for (const group of GROUPS) {
      const iface = new Interface(group.abi)
      iface.forEachFunction((fragment) => {
        // 同一个选择器的第一个为准（Token 组里的 approve / transferFrom 同时是 ERC20 和 ERC721 的）
        if (!table?.has(fragment.selector)) table?.set(fragment.selector, { fragment, iface, group: group.name })
      })
    }
  }
  return table
}

const typeOf = (method: string): DecodedType => {
  if (/^swap|^exact(Input|Output)/.test(method)) return 'swap'
  if (/Liquidity|^collect$|^burn$|^mint$|^modifyLiquidities$|^createAndInitializePool/.test(method)) return 'liquidity'
  if (/^(transfer|safeTransfer|safeBatchTransfer|disperse)/.test(method)) return 'transfer'
  if (/^(approve|permit|setApprovalForAll|increaseAllowance|decreaseAllowance|lockdown|invalidate)/.test(method)) return 'approve'
  return 'contract'
}

/** 子调用里最重要的类型，决定外层 multicall 的类型 */
const PRIORITY: DecodedType[] = ['swap', 'liquidity', 'transfer', 'approve', 'contract', 'unknown']

/** Universal Router 的命令字节（低 6 位）→ 名字 */
const UR_COMMANDS: Record<number, string> = {
  0x00: 'V3_SWAP_EXACT_IN',
  0x01: 'V3_SWAP_EXACT_OUT',
  0x02: 'PERMIT2_TRANSFER_FROM',
  0x03: 'PERMIT2_PERMIT_BATCH',
  0x04: 'SWEEP',
  0x05: 'TRANSFER',
  0x06: 'PAY_PORTION',
  0x08: 'V2_SWAP_EXACT_IN',
  0x09: 'V2_SWAP_EXACT_OUT',
  0x0a: 'PERMIT2_PERMIT',
  0x0b: 'WRAP_ETH',
  0x0c: 'UNWRAP_WETH',
  0x0d: 'PERMIT2_TRANSFER_FROM_BATCH',
  0x0e: 'BALANCE_CHECK_ERC20',
  0x10: 'V4_SWAP',
  0x11: 'V3_POSITION_MANAGER_PERMIT',
  0x12: 'V3_POSITION_MANAGER_CALL',
  0x13: 'V4_INITIALIZE_POOL',
  0x14: 'V4_POSITION_MANAGER_CALL',
  0x21: 'EXECUTE_SUB_PLAN',
}

const urType = (name: string): DecodedType => (/SWAP/.test(name) ? 'swap' : /POSITION_MANAGER_CALL/.test(name) ? 'liquidity' : /PERMIT/.test(name) ? 'approve' : /TRANSFER|SWEEP|PAY_PORTION/.test(name) ? 'transfer' : 'contract')

const MAX_DEPTH = 2

/** 参数转成可 JSON 序列化的值（bigint → 字符串，Result → 数组 / 对象） */
function plain(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString()
  if (Array.isArray(value)) return value.map(plain)
  if (value && typeof value === 'object' && typeof (value as { toObject?: unknown }).toObject === 'function') return plain((value as { toObject(): unknown }).toObject())
  return value
}

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`

/**
 * 解码一笔交易的 calldata。`to` 和 `chainId` 用来按内置协议表给 Router 标协议名。
 *
 * ```ts
 * decodeCalldata(data, { to: router, chainId: 1 })
 * // { type: 'swap', protocol: 'Uniswap SwapRouter02', method: 'exactInputSingle', summary: 'Uniswap SwapRouter02 exactInputSingle', args: {…} }
 * ```
 */
export function decodeCalldata(data: string | undefined, ctx: { to?: string; chainId?: number; value?: bigint } = {}, depth = 0): DecodedCall {
  const hex = data && data !== '0x' ? data : '0x'
  const name = ctx.to && ctx.chainId !== undefined ? knownSpenders(ctx.chainId).find((s) => s.address.toLowerCase() === ctx.to?.toLowerCase())?.name : undefined
  if (hex === '0x') {
    return ctx.value && ctx.value > 0n ? { type: 'transfer', method: 'transfer', summary: `Send native token${ctx.to ? ` to ${short(ctx.to)}` : ''}`, args: { to: ctx.to, value: ctx.value.toString() } } : { type: 'unknown', summary: 'Empty call' }
  }
  if (hex.length < 10) return { type: 'unknown', summary: 'Unknown call', args: { selector: hex } }
  const selector = dataSlice(hex, 0, 4)
  const entry = entries().get(selector)
  if (!entry) return { type: 'unknown', ...(name ? { protocol: name } : {}), summary: `Unknown method ${selector}${name ? ` on ${name}` : ''}`, args: { selector } }
  const method = entry.fragment.name
  const args: Record<string, unknown> = {}
  let parsed: Result
  try {
    parsed = entry.iface.decodeFunctionData(entry.fragment, hex)
    // Result 按需解码，数据残缺时在读取参数时才报错
    entry.fragment.inputs.forEach((input, i) => {
      args[input.name || String(i)] = plain(parsed[i])
    })
  } catch {
    return { type: 'unknown', ...(name ? { protocol: name } : {}), summary: `Undecodable ${method} call`, args: { selector, method } }
  }
  const protocol = name ?? (entry.group === 'Token' ? undefined : entry.group)
  let type = typeOf(method)
  const out: DecodedCall = { type, ...(protocol ? { protocol } : {}), method, summary: protocol ? `${protocol} ${method}` : method, args }

  // 子调用：multicall / aggregate / executeBatch / Universal Router
  if (depth < MAX_DEPTH) {
    const inner = innerCalls(method, parsed, ctx.chainId, depth)
    if (inner?.length) {
      out.calls = inner
      type = PRIORITY.find((t) => inner.some((c) => c.type === t)) ?? 'contract'
      out.type = type
      out.summary = `${protocol ? `${protocol} ` : ''}${method}: ${inner.map((c) => c.method ?? 'unknown').join(' + ')}`
    }
  }
  return out
}

function innerCalls(method: string, parsed: ReadonlyArray<any>, chainId: number | undefined, depth: number): DecodedCall[] | null {
  const sub = (to: string | undefined, data: string, value?: bigint) => decodeCalldata(data, { to, chainId, value }, depth + 1)
  if (method === 'multicall') {
    const list = parsed[parsed.length - 1] as string[]
    return list.map((d) => sub(undefined, d))
  }
  if (method === 'aggregate' || method === 'tryAggregate' || method === 'aggregate3' || method === 'aggregate3Value') {
    const calls = parsed[parsed.length - 1] as Array<{ target: string; callData: string; value?: bigint }>
    return calls.map((c) => sub(c.target, c.callData, c.value))
  }
  if (method === 'executeBatch') return (parsed[0] as Array<{ target: string; value: bigint; data: string }>).map((c) => sub(c.target, c.data, c.value))
  if (method === 'execute') {
    const commands = (parsed[0] as string).slice(2).match(/../g) ?? []
    return commands.map((byte) => {
      const cmd = UR_COMMANDS[Number.parseInt(byte, 16) & 0x3f] ?? `COMMAND_0x${byte}`
      return { type: urType(cmd), method: cmd, summary: cmd }
    })
  }
  return null
}

// ---------------------------------------------------------------------------
// revert 原因
// ---------------------------------------------------------------------------

const customErrors = new Interface([
  // Universal Router
  'error ExecutionFailed(uint256 commandIndex, bytes message)',
  'error InvalidCommandType(uint256 commandType)',
  'error TransactionDeadlinePassed()',
  'error V3TooLittleReceived()',
  'error V3TooMuchRequested()',
  'error V2TooLittleReceived()',
  'error V2TooMuchRequested()',
  'error V3InvalidSwap()',
  'error InsufficientETH()',
  'error InsufficientToken()',
  'error BalanceTooLow()',
  'error InvalidBips()',
  'error LengthMismatch()',
  // Permit2
  'error AllowanceExpired(uint256 deadline)',
  'error InsufficientAllowance(uint256 amount)',
  'error InvalidSigner()',
  'error InvalidNonce()',
  'error SignatureExpired(uint256 signatureDeadline)',
  // OpenZeppelin 5
  'error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed)',
  'error ERC20InsufficientAllowance(address spender, uint256 allowance, uint256 needed)',
  'error ERC20InvalidSender(address sender)',
  'error ERC20InvalidReceiver(address receiver)',
  'error ERC721InsufficientApproval(address operator, uint256 tokenId)',
  'error ERC721NonexistentToken(uint256 tokenId)',
  'error OwnableUnauthorizedAccount(address account)',
  'error EnforcedPause()',
  'error ReentrancyGuardReentrantCall()',
  'error AddressEmptyCode(address target)',
  'error SafeERC20FailedOperation(address token)',
  'error FailedCall()',
])

const PANIC: Record<string, string> = {
  '1': 'assertion failed',
  '17': 'arithmetic overflow / underflow',
  '18': 'division by zero',
  '33': 'invalid enum value',
  '50': 'array index out of bounds',
  '65': 'out of memory',
}

/**
 * revert 数据 → 可读的原因：Error(string)、Panic（带含义），常见的自定义错误（Universal Router、Permit2、OpenZeppelin）带参数，
 * 认不出的是 `custom error 0x选择器`。没有数据时返回 null
 */
export function decodeRevert(data: string | null | undefined, depth = 0): string | null {
  if (!data || data === '0x' || data.length < 10) return null
  const basic = decodeRevertReason(data)
  if (basic) {
    const panic = /^Panic\((\d+)\)$/.exec(basic)
    return panic ? `${basic}${PANIC[panic[1] as string] ? ` ${PANIC[panic[1] as string]}` : ''}` : basic
  }
  try {
    const parsed = customErrors.parseError(data)
    if (parsed) {
      if (parsed.name === 'ExecutionFailed' && depth < 2) {
        const inner = decodeRevert(String(parsed.args[1]), depth + 1)
        return `ExecutionFailed(command ${parsed.args[0]}${inner ? `: ${inner}` : ''})`
      }
      return `${parsed.name}(${parsed.args.map((a: unknown) => String(a)).join(', ')})`
    }
  } catch {
    // 落到下面
  }
  return `custom error ${dataSlice(data, 0, 4)}`
}
