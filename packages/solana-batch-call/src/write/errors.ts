import { SYSTEM_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '../constants.js'

// 交易错误的可读说明（发送、/swap 的交易检查、/fees 共用）

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// ---- 交易错误 ----

const TX_ERRORS: Record<string, string> = {
  InsufficientFundsForFee: 'insufficient SOL for the transaction fee',
  AccountNotFound: 'fee payer account not found (it has no SOL)',
  BlockhashNotFound: 'blockhash not found',
  AlreadyProcessed: 'transaction already processed',
}

/**
 * 日志里最有用的一行：程序打印的 “Program log: Error: …”，其次是系统程序直接打印的说明（如 “Transfer: insufficient lamports …”，
 * 不以 “Program ” 开头），最后才是运行时的 “Program … failed: custom program error: 0x1”
 */
function logDetail(logs: readonly string[]): string | undefined {
  const reversed = [...logs].reverse()
  const programError = reversed.find((line) => /^Program log: (Error|error)/.test(line))
  if (programError) return programError.replace(/^Program log: /, '')
  const plain = reversed.find((line) => !line.startsWith('Program '))
  if (plain) return plain
  return reversed.find((line) => / failed: /.test(line))?.replace(/^Program \w+ failed: /, '')
}

// 常见程序的自定义错误码（上链失败时没有日志，只有错误码）
const SYSTEM_ERRORS = ['account already in use', 'insufficient lamports', 'invalid program id', 'invalid account data length']
const TOKEN_ERRORS: Record<number, string> = {
  0: 'account not rent-exempt',
  1: 'insufficient funds',
  2: 'invalid mint',
  3: 'account not associated with this mint',
  4: 'owner does not match',
  9: 'account is not initialized',
  11: 'non-native account can only be closed if its balance is zero',
  17: 'account is frozen',
  18: 'mint decimals mismatch',
}

function customErrorText(program: string | undefined, code: number): string | undefined {
  if (program === SYSTEM_PROGRAM_ID) return SYSTEM_ERRORS[code]
  if (program === TOKEN_PROGRAM_ID || program === TOKEN_2022_PROGRAM_ID) return TOKEN_ERRORS[code]
  return undefined
}

/**
 * 交易错误的可读说明：优先取日志（见 logDetail），否则按错误类型；
 * programs 是每条指令的程序（按下标），用来翻译常见程序的自定义错误码
 */
export function transactionErrorText(err: unknown, logs?: readonly string[] | null, programs?: readonly string[]): string {
  const detail = logDetail(logs ?? [])
  if (typeof err === 'string') {
    return TX_ERRORS[err] ?? err
  }
  const instruction = (err as { InstructionError?: [number, unknown] } | null)?.InstructionError
  if (instruction) {
    const [index, reason] = instruction
    const custom = (reason as { Custom?: number } | null)?.Custom
    const known = custom === undefined ? undefined : customErrorText(programs?.[index], custom)
    return detail ?? known ?? (typeof reason === 'string' ? reason : JSON.stringify(reason))
  }
  if ((err as { InsufficientFundsForRent?: unknown } | null)?.InsufficientFundsForRent) {
    return 'account would be left with less SOL than the rent-exempt minimum'
  }
  return detail ?? JSON.stringify(err)
}

export function isBudgetExceeded(err: unknown, logs?: readonly string[] | null): boolean {
  const reason = (err as { InstructionError?: [number, unknown] } | null)?.InstructionError?.[1]
  return reason === 'ComputationalBudgetExceeded' || (logs ?? []).some((l) => /exceeded CUs meter|compute units/i.test(l) && /exceed/i.test(l))
}

/** 用户在钱包里拒绝签名 */
export function isRejection(err: unknown): boolean {
  const e = err as { code?: unknown; name?: unknown; message?: unknown } | null
  return e?.code === 4001 || /reject|denied|cancel|declined/i.test(`${String(e?.name ?? '')} ${String(e?.message ?? '')}`)
}
