import { normalizeSuiAddress } from '../address.js'
import type { Argument, CallArg, Command, ObjectArg, ObjectRef, ProgrammableTransaction } from './bcs.js'

/** 拼可编程交易（PTB）：输入去重，命令的结果按下标引用 */
export class PtbBuilder {
  readonly inputs: CallArg[] = []
  readonly commands: Command[] = []
  readonly #pure = new Map<string, number>()
  readonly #objects = new Map<string, number>()

  readonly gas: Argument = { kind: 'gas' }

  pure(bytes: Uint8Array): Argument {
    const key = [...bytes].join(',')
    let index = this.#pure.get(key)
    if (index === undefined) {
      index = this.inputs.push({ kind: 'pure', bytes }) - 1
      this.#pure.set(key, index)
    }
    return { kind: 'input', index }
  }

  object(arg: ObjectArg): Argument {
    const id = normalizeSuiAddress(arg.kind === 'shared' ? arg.objectId : arg.ref.objectId)
    let index = this.#objects.get(id)
    if (index === undefined) {
      index = this.inputs.push({ kind: 'object', object: arg }) - 1
      this.#objects.set(id, index)
    } else if (arg.kind === 'shared' && arg.mutable) {
      // 同一个共享对象被要求可写时，按可写引用
      const existing = this.inputs[index] as { kind: 'object'; object: ObjectArg }
      if (existing.object.kind === 'shared') existing.object = { ...existing.object, mutable: true }
    }
    return { kind: 'input', index }
  }

  owned(ref: ObjectRef): Argument {
    return this.object({ kind: 'owned', ref })
  }

  /** 从发送者的地址余额取款（最多 amount） */
  withdrawal(amount: bigint, coinType: string): Argument {
    const index = this.inputs.push({ kind: 'withdrawal', amount, coinType }) - 1
    return { kind: 'input', index }
  }

  command(c: Command): Argument {
    const index = this.commands.push(c) - 1
    return { kind: 'result', index }
  }

  /** 命令有多个返回值时取第 i 个（如 SplitCoins 的第 i 个新币） */
  nested(result: Argument, i: number): Argument {
    if (result.kind !== 'result') throw new Error('nested() needs a command result')
    return { kind: 'nested', index: result.index, result: i }
  }

  moveCall(target: string, typeArguments: readonly string[], args: readonly Argument[]): Argument {
    const [pkg, module, fn] = target.split('::') as [string, string, string]
    return this.command({ kind: 'moveCall', package: pkg, module, function: fn, typeArguments: [...typeArguments], arguments: [...args] })
  }

  /** 被引用的 Coin 对象 ID（选 gas 币时要排除） */
  ownedObjectIds(): string[] {
    return this.inputs.flatMap((i) => (i.kind === 'object' && i.object.kind !== 'shared' ? [normalizeSuiAddress(i.object.ref.objectId)] : []))
  }

  build(): ProgrammableTransaction {
    return { inputs: [...this.inputs], commands: [...this.commands] }
  }
}
