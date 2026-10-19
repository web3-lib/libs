/**
 * 合约 get 方法（toncenter v3 的 runGetMethod）：参数和返回值的栈编码
 */
import { toRawAddress, type TonAddress } from './address.js'
import type { RequestOptions, TonTransport } from './http.js'
import { Cell, beginCell } from './write/cell.js'

export type StackArg = { type: 'num'; value: bigint | number } | { type: 'slice'; cell: Cell } | { type: 'address'; address: string | TonAddress }

interface StackEntry {
  type: string
  value: unknown
}

export class GetMethodError extends Error {
  constructor(
    readonly method: string,
    readonly exitCode: number,
  ) {
    super(`get method ${method} failed with exit code ${exitCode}`)
    this.name = 'GetMethodError'
  }
}

/** 返回值的栈：按顺序读 */
export class Stack {
  #i = 0
  constructor(readonly entries: readonly StackEntry[]) {}

  #next(): StackEntry {
    const e = this.entries[this.#i++]
    if (!e) throw new Error('Get method result: stack underflow')
    return e
  }

  num(): bigint {
    const e = this.#next()
    if (e.type !== 'num') throw new Error(`Get method result: expected a number, got ${e.type}`)
    const s = String(e.value)
    return s.startsWith('-') ? -BigInt(s.slice(1)) : BigInt(s)
  }

  cell(): Cell {
    const e = this.#next()
    if (e.type !== 'cell' && e.type !== 'slice') throw new Error(`Get method result: expected a cell, got ${e.type}`)
    return Cell.fromBase64(String(e.value))
  }

  /** 地址（cell / slice 里的 MsgAddress）；addr_none 为 null */
  address(): string | null {
    const a = this.cell().beginParse().loadAddress()
    return a ? toRawAddress(a) : null
  }

  /** snake 格式的字符串（如 get_pool_type） */
  string(): string {
    const s = this.cell().beginParse()
    return new TextDecoder().decode(s.loadBytes(Math.floor(s.remainingBits / 8)))
  }

  skip(n = 1): this {
    this.#i += n
    return this
  }
}

function encodeArg(a: StackArg): { type: string; value: string } {
  if (a.type === 'num') {
    const v = BigInt(a.value)
    return { type: 'num', value: v < 0n ? `-0x${(-v).toString(16)}` : `0x${v.toString(16)}` }
  }
  const cell = a.type === 'slice' ? a.cell : beginCell().storeAddress(a.address).endCell()
  return { type: 'slice', value: cell.toBase64() }
}

/** 调用 get 方法；exit code 不是 0 / 1 时抛 GetMethodError */
export async function runGetMethod(t: TonTransport, address: string, method: string, args: readonly StackArg[] = [], options?: RequestOptions): Promise<Stack> {
  const res = await t.post<{ exit_code?: number; stack?: StackEntry[] }>('runGetMethod', { address, method, stack: args.map(encodeArg) }, options)
  const code = res.exit_code ?? 0
  if (code !== 0 && code !== 1) throw new GetMethodError(method, code)
  return new Stack(res.stack ?? [])
}
