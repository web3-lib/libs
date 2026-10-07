import { Interface, type FunctionFragment, type InterfaceAbi, type JsonFragment, type JsonFragmentType } from 'ethers'

import type { BoundCall, Call, Params } from './call.js'

export type ContractAbi = InterfaceAbi | Interface

/** 绑定后执行 Call 的对象（即 Provider），避免 contract ⇄ provider 循环依赖 */
export interface ContractRunner {
  call(call: Call): Promise<any>
  staticCall(call: Call): Promise<any>
}

/** 绑定合约上的方法：调用得到可 await 的 Call，`.staticCall(...)` 预执行 */
export interface BoundMethod<T = any> {
  (...params: Params): BoundCall<T>
  /** 预执行（直接 eth_call，可在最后一个参数传 { from, value, gasLimit, blockTag }） */
  staticCall(...params: Params): Promise<T>
}

/**
 * 生成 Call 的合约包装，用法与 ethcall 的 Contract 一致：
 *
 * ```ts
 * const erc20 = new Contract(token, ['function balanceOf(address) view returns (uint256)'])
 * erc20.balanceOf(user) // => Call
 * ```
 *
 * 传入 runner（或用 `provider.contract(address, abi)`）得到绑定合约：
 *
 * ```ts
 * const usdt = multi.contract(token, ERC20_ABI)
 * const balance = await usdt.balanceOf(user)          // 同一 tick 内的调用自动合并成一次 multicall
 * const out = await router.swap.staticCall(params, { value, from }) // 预执行，写法同 ethers
 * ```
 *
 * 与 ethcall 的差异：
 * - ABI 直接支持人类可读字符串 / JSON / ethers Interface，不需要再 abiToJson 一遍
 * - 暴露 ABI 里的所有函数（不只 view/pure），可以用来模拟 nonpayable 的报价函数（如 Uniswap V3 Quoter）
 * - 重载函数可以用完整签名取：`contract['getAmount(uint256,address)'](...)`
 */
export class Contract {
  readonly #address: string
  readonly #runner: ContractRunner | undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [method: string]: any

  constructor(address: string, abi: ContractAbi, runner?: ContractRunner) {
    this.#address = address
    this.#runner = runner
    for (const fn of parseAbi(abi)) {
      const method = this.#makeMethod(fn)
      for (const key of fn.keys) {
        if (key in this) {
          continue
        }
        Object.defineProperty(this, key, { enumerable: true, value: method, writable: false })
      }
    }
  }

  get address(): string {
    return this.#address
  }

  #makeMethod({ name, inputs, outputs }: ParsedFunction) {
    const address = this.#address
    const runner = this.#runner

    const build = (params: Params): Call => {
      // 与 ethers 一致：多出来的最后一个参数是 overrides，如 router.swap(params, { value })
      if (params.length === inputs.length + 1 && isPlainObject(params[params.length - 1])) {
        const overrides = params[params.length - 1] as Call['overrides']
        return { contract: { address }, name, inputs, outputs, params: params.slice(0, -1), overrides }
      }
      return { contract: { address }, name, inputs, outputs, params }
    }

    if (!runner) {
      return (...params: Params): Call => build(params)
    }

    const method = (...params: Params): BoundCall => bindCall(build(params), runner)
    Object.defineProperty(method, 'staticCall', {
      value: (...params: Params) => runner.staticCall(build(params)),
    })
    return method
  }
}

interface ParsedFunction {
  /** 挂到 Contract 上的属性名：完整签名，以及不重载时的函数名 */
  keys: string[]
  name: string
  inputs: readonly JsonFragmentType[]
  outputs: readonly JsonFragmentType[]
}

// 按 ABI 对象（数组 / Interface）缓存解析结果：循环里 new Contract(token, ERC20ABI) 只解析一次，
// 生成的 Call 共享 inputs/outputs 数组，call.ts 的 Interface 缓存才能命中
const abiCache = new WeakMap<object, ParsedFunction[]>()

function parseAbi(abi: ContractAbi): ParsedFunction[] {
  const cacheable = typeof abi === 'object' && abi !== null
  const cached = cacheable ? abiCache.get(abi) : undefined
  if (cached) {
    return cached
  }
  const iface = abi instanceof Interface ? abi : new Interface(abi)
  const fragments: FunctionFragment[] = []
  iface.forEachFunction((fn) => fragments.push(fn))
  const counts = new Map<string, number>()
  fragments.forEach((fn) => counts.set(fn.name, (counts.get(fn.name) ?? 0) + 1))
  const parsed = fragments.map((fn) => {
    const json = JSON.parse(fn.format('json')) as JsonFragment
    return {
      keys: counts.get(fn.name) === 1 ? [fn.format('sighash'), fn.name] : [fn.format('sighash')],
      name: fn.name,
      inputs: json.inputs ?? [],
      outputs: json.outputs ?? [],
    }
  })
  if (cacheable) {
    abiCache.set(abi, parsed)
  }
  return parsed
}

/** 给 Call 加上不可枚举的 then：第一次 await 时才发请求（交给 runner.call 自动合并），结果复用 */
export function bindCall<T>(call: Call<T>, runner: ContractRunner): BoundCall<T> {
  let promise: Promise<T> | undefined
  Object.defineProperty(call, 'then', {
    enumerable: false,
    value: (onFulfilled?: (value: T) => unknown, onRejected?: (reason: unknown) => unknown) => {
      promise ??= runner.call(call)
      return promise.then(onFulfilled, onRejected)
    },
  })
  return call as BoundCall<T>
}

function isPlainObject(value: unknown): boolean {
  return value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype
}

export default Contract
