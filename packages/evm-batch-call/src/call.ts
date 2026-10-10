import { FunctionFragment, Interface, Utf8ErrorFuncs, getAddress, toBeHex, toUtf8String, zeroPadValue, type JsonFragmentType, type ParamType, type Result } from 'ethers'

import { isTronAddress, toEvmAddress } from './tron.js'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Params = any[]

/**
 * 一次只读调用的描述。结构与 ethcall 的 Call 保持一致，手工构造的 Call 也能直接用。
 * 类型参数 T 是解码后的结果类型（仅用于类型推断，运行时不存在）。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface Call<T = any> {
  contract: {
    address: string
  }
  name: string
  inputs: readonly JsonFragmentType[]
  outputs: readonly JsonFragmentType[]
  params: Params
  /**
   * 调用自带的 overrides（`contract.method(...args, overrides)`）。
   * blockTag / from 对 await 绑定 Call、provider.call、staticCall 生效；value / gasLimit 只对预执行生效。
   * 传给 all / tryAll 时以批次的 overrides 为准（一批只能在同一个区块、同一个 from 下执行）。
   */
  overrides?: {
    blockTag?: number | bigint | string
    from?: string
    value?: bigint | string | number
    gasLimit?: bigint | string | number
  }
  /**
   * 内部标记：
   * - ethBalance：原生币余额查询（见 Provider.getEthBalance）
   * - blockNumber：当前区块号（Multicall3.getBlockNumber；deployless 合约里直接返回 block.number）
   * - stringOrBytes32：string 返回值，解码失败时按 bytes32 解析（MKR 等老代币的 symbol / name）
   */
  kind?: 'ethBalance' | 'blockNumber' | 'stringOrBytes32'
  /** 仅用于类型推断 */
  readonly __result?: T
}

/** 绑定了 Provider 的 Call：可以直接 await（自动合并成 multicall），也可以照常传给 all / tryAll */
export type BoundCall<T = any> = Call<T> & PromiseLike<T>

export interface FailableCall extends Call {
  canFail: boolean
}

/** multicall 返回的单条原始结果 */
export interface RawResult {
  success: boolean
  returnData: string
}

/**
 * 单条调用的失败原因：
 * - invalid-address：合约地址或参数里的地址非法
 * - invalid-argument：其他参数编码失败（个数不对、数值超出范围等）
 * - no-contract：调用成功但返回空数据，多半是目标地址上没有合约
 * - reverted：执行 revert
 * - decode-failed：有返回数据但无法按 ABI 解码（如合约不是预期的标准）
 * - not-configured：没有发请求的信息缺失，如主币不在内置链信息表里、也没有配置 nativeName / nativeSymbol
 */
export type FailureReason = 'invalid-address' | 'invalid-argument' | 'no-contract' | 'reverted' | 'decode-failed' | 'not-configured'

/** 单条调用的结果：成功的值，或失败原因 */
export type Settled<T = any> = { ok: true; value: T } | { ok: false; reason: FailureReason }

/** 按 multicall 的原始结果判断成功 / 失败原因 */
export function settleResult<T>(call: Call, result: RawResult): Settled<T> {
  if (!result.success) {
    return { ok: false, reason: 'reverted' }
  }
  // 没有返回值的函数成功时本来就返回空数据，照常解码；有返回值却拿到空数据，多半是地址上没有合约
  if ((!result.returnData || result.returnData === '0x') && call.outputs.length > 0) {
    return { ok: false, reason: 'no-contract' }
  }
  try {
    return { ok: true, value: decodeCall<T>(call, result.returnData) }
  } catch {
    return { ok: false, reason: 'decode-failed' }
  }
}

/** 参数编码失败的原因：地址非法，还是其他参数问题 */
export function encodeFailureReason(err: unknown): FailureReason {
  const e = err as { code?: unknown; argument?: unknown; message?: unknown } | null
  return /address/i.test(String(e?.argument ?? '')) || /address/i.test(String(e?.message ?? '')) ? 'invalid-address' : 'invalid-argument'
}

/** 发给 aggregate3 前的单条请求 */
export interface CallRequest {
  target: string
  allowFailure: boolean
  callData: string
  /** 原生币余额查询：默认有 multicall 合约时走 getEthBalance、deployless 时用 BALANCE；其他读取方式见 NativeBalanceMode */
  ethBalanceOf?: string
  /** 区块号查询：目标换成实际的 multicall 地址（deployless 时由合约内部处理） */
  blockNumber?: boolean
}

// inputs → name → outputs → Interface。同一份 ABI 生成的 Call 共享 inputs/outputs 数组（见 contract.ts 的 ABI 缓存），
// 按引用缓存，避免每条 Call 都重新解析；三者都参与 key，手工构造的 Call 共用数组时也不会串
const interfaceCache = new WeakMap<readonly JsonFragmentType[], Map<string, WeakMap<readonly JsonFragmentType[], Interface>>>()

function getInterface(call: Call): Interface {
  let byName = interfaceCache.get(call.inputs)
  if (!byName) {
    byName = new Map()
    interfaceCache.set(call.inputs, byName)
  }
  let byOutputs = byName.get(call.name)
  if (!byOutputs) {
    byOutputs = new WeakMap()
    byName.set(call.name, byOutputs)
  }
  let iface = byOutputs.get(call.outputs)
  if (!iface) {
    const fragment = FunctionFragment.from({
      type: 'function',
      name: call.name,
      inputs: call.inputs,
      outputs: call.outputs,
      stateMutability: 'view',
    })
    iface = new Interface([fragment])
    byOutputs.set(call.outputs, iface)
  }
  return iface
}

export function encodeCall(call: Call, allowFailure: boolean): CallRequest {
  const iface = getInterface(call)
  const fragment = iface.fragments[0] as FunctionFragment
  const params = normalizeAddresses(fragment, call.params)
  return {
    target: getAddress(toEvmAddress(call.contract.address)),
    allowFailure,
    callData: iface.encodeFunctionData(fragment, params),
    ethBalanceOf: call.kind === 'ethBalance' ? toEvmAddress(params[0] as string) : undefined,
    blockNumber: call.kind === 'blockNumber' ? true : undefined,
  }
}

// Tron 的 T 开头地址在 ABI 里就是去掉 0x41 前缀的 20 字节，这里统一转成 0x 形式再编码
function normalizeAddresses(fragment: FunctionFragment, params: Params): Params {
  if (params.length !== fragment.inputs.length) {
    // 参数个数不对交给 ethers 报错（overrides 不在 params 里，见 Provider.staticCall）
    return params
  }
  return fragment.inputs.map((input, i) => normalizeValue(input, params[i]))
}

// ethers 的 ParamType.walk 不接受对象形式的 struct，这里自己递归
function normalizeValue(type: ParamType, value: unknown): unknown {
  if (type.baseType === 'address') {
    return isTronAddress(value) ? toEvmAddress(value as string) : value
  }
  if (type.isArray() && Array.isArray(value)) {
    return value.map((v) => normalizeValue(type.arrayChildren, v))
  }
  if (type.isTuple() && value !== null && typeof value === 'object') {
    if (Array.isArray(value)) {
      return value.map((v, i) => (type.components[i] ? normalizeValue(type.components[i], v) : v))
    }
    const out: Record<string, unknown> = { ...value }
    for (const component of type.components) {
      if (component.name in out) {
        out[component.name] = normalizeValue(component, out[component.name])
      }
    }
    return out
  }
  return value
}

/** 单返回值直接返回该值，多返回值返回 ethers Result（可按下标或名字取） */
export function decodeCall<T>(call: Call, returnData: string): T {
  if (call.kind === 'stringOrBytes32') {
    return decodeStringOrBytes32(call, returnData) as T
  }
  const iface = getInterface(call)
  const fragment = iface.fragments[0] as FunctionFragment
  const result: Result = iface.decodeFunctionResult(fragment, returnData)
  return (call.outputs.length === 1 ? result[0] : result) as T
}

/** 标记 string 返回值的调用：解码失败时按 bytes32 解析（MKR 等老代币的 symbol / name） */
export function asStringOrBytes32<T>(call: Call<T>): Call<T> {
  call.kind = 'stringOrBytes32'
  return call
}

function decodeStringOrBytes32(call: Call, returnData: string): string {
  try {
    const iface = getInterface(call)
    return iface.decodeFunctionResult(iface.fragments[0] as FunctionFragment, returnData)[0] as string
  } catch (err) {
    // bytes32：恰好 32 字节，按 UTF-8 解析并去掉末尾的 \0
    if (/^0x[0-9a-fA-F]{64}$/.test(returnData)) {
      const text = toUtf8String(returnData, Utf8ErrorFuncs.ignore).replace(/\0+$/, '')
      if (text) {
        return text
      }
    }
    throw err
  }
}

export function encodeUint256(value: bigint): string {
  return zeroPadValue(toBeHex(value), 32)
}
