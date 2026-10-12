const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

export function base58(bytes: Uint8Array): string {
  let zeros = 0
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++
  const digits: number[] = []
  for (let i = zeros; i < bytes.length; i++) {
    let carry = bytes[i] as number
    for (let j = 0; j < digits.length; j++) {
      carry += (digits[j] as number) << 8
      digits[j] = carry % 58
      carry = (carry / 58) | 0
    }
    while (carry) {
      digits.push(carry % 58)
      carry = (carry / 58) | 0
    }
  }
  return '1'.repeat(zeros) + digits.reverse().map((d) => BASE58[d]).join('')
}

export function hex(bytes: Uint8Array): string {
  return `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`
}

export function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

export function base64(bytes: Uint8Array): string {
  let binary = ''
  bytes.forEach((b) => (binary += String.fromCharCode(b)))
  return btoa(binary)
}

/** 签名结果可能是 Uint8Array、number[] 或已经编码好的字符串 */
export function toBytes(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) return value
  if (Array.isArray(value) && value.every((n) => typeof n === 'number')) return Uint8Array.from(value as number[])
  return null
}
