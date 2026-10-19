/** Sui 地址 / 对象 ID：32 字节，0x 开头的 64 位十六进制 */
const HEX_RE = /^0x[0-9a-fA-F]{1,64}$/

/** 是不是合法的 Sui 地址或对象 ID：0x 开头，允许省略前导 0（如 0x2） */
export function isValidSuiAddress(value: unknown): value is string {
  return typeof value === 'string' && HEX_RE.test(value)
}

/** 统一成 0x + 64 位小写十六进制（补足前导 0）；不合法时抛错 */
export function normalizeSuiAddress(value: string): string {
  if (!isValidSuiAddress(value)) {
    throw new Error(`Invalid Sui address: ${value}`)
  }
  return `0x${value.slice(2).toLowerCase().padStart(64, '0')}`
}

/** 0x2::sui::SUI */
export const SUI_COIN_TYPE = '0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI'

/**
 * Move 类型（代币类型等）统一成节点返回的格式：地址补足 64 位、小写，泛型参数同样处理。
 * 如 '0x2::sui::SUI' → '0x000…002::sui::SUI'；'0x2::coin::Coin<0x2::sui::SUI>' → 全部展开
 */
export function normalizeStructTag(type: string): string {
  const text = type.trim()
  let o = 0
  const parse = (): string => {
    const start = o
    while (o < text.length && !'<>,'.includes(text[o] as string)) o++
    const head = text.slice(start, o).trim()
    const parts = head.split('::')
    let out: string
    if (parts.length === 3) {
      const [address, module, name] = parts as [string, string, string]
      if (!isValidSuiAddress(address) || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(module) || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
        throw new Error(`Invalid Move type: ${type}`)
      }
      out = `${normalizeSuiAddress(address)}::${module}::${name}`
    } else if (parts.length === 1 && /^(u8|u16|u32|u64|u128|u256|bool|address|signer|vector)$/.test(head)) {
      out = head
    } else {
      throw new Error(`Invalid Move type: ${type}`)
    }
    if (text[o] === '<') {
      o++
      const args: string[] = []
      for (;;) {
        args.push(parse())
        if (text[o] === ',') {
          o++
          continue
        }
        if (text[o] === '>') {
          o++
          break
        }
        throw new Error(`Invalid Move type: ${type}`)
      }
      out += `<${args.join(', ')}>`
    }
    return out
  }
  const result = parse()
  if (o !== text.length) {
    throw new Error(`Invalid Move type: ${type}`)
  }
  return result
}

/** 0x2::coin::Coin<T> 的 T；不是 Coin 对象时为 null */
export function coinTypeOfObject(objectType: string): string | null {
  const m = /^0x0{63}2::coin::Coin<(.+)>$/.exec(objectType)
  return m ? (m[1] as string) : null
}
