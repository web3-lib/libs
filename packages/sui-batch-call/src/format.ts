/** 最小单位 → 按精度换算的十进制字符串（"1234.5"；整数不带小数点） */
export function formatUnits(value: bigint, decimals: number): string {
  const negative = value < 0n
  const digits = (negative ? -value : value).toString().padStart(decimals + 1, '0')
  const whole = digits.slice(0, digits.length - decimals)
  const fraction = digits.slice(digits.length - decimals).replace(/0+$/, '')
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`
}

/** 十进制字符串 → 最小单位；小数位超过精度时报错 */
export function parseUnits(value: string, decimals: number): bigint {
  const match = /^(-)?(\d*)(?:\.(\d*))?$/.exec(value.trim())
  if (!match || (!match[2] && !match[3])) {
    throw new Error(`Invalid amount: ${JSON.stringify(value)}`)
  }
  const fraction = match[3] ?? ''
  if (/[1-9]/.test(fraction.slice(decimals))) {
    throw new Error(`Too many decimals: ${value} (max ${decimals})`)
  }
  const amount = BigInt((match[2] || '0') + fraction.slice(0, decimals).padEnd(decimals, '0'))
  return match[1] ? -amount : amount
}
