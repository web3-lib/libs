import { ASSOCIATED_TOKEN_PROGRAM_ID, SYSTEM_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '../constants.js'
import type { Instruction } from './transaction.js'

export const COMPUTE_BUDGET_PROGRAM_ID = 'ComputeBudget111111111111111111111111111111'

/** 单笔交易的计算单元上限 */
export const MAX_COMPUTE_UNITS = 1_400_000

function bytes(size: number, write: (view: DataView) => void): Uint8Array {
  const out = new Uint8Array(size)
  write(new DataView(out.buffer))
  return out
}

/** System Program Transfer：转 SOL */
export function systemTransfer(from: string, to: string, lamports: bigint): Instruction {
  return {
    programId: SYSTEM_PROGRAM_ID,
    keys: [
      { pubkey: from, isSigner: true, isWritable: true },
      { pubkey: to, isSigner: false, isWritable: true },
    ],
    data: bytes(12, (v) => {
      v.setUint32(0, 2, true)
      v.setBigUint64(4, lamports, true)
    }),
  }
}

/** SPL Token / Token-2022 TransferChecked（校验 mint 和精度） */
export function transferChecked(source: string, mint: string, destination: string, owner: string, amount: bigint, decimals: number, tokenProgram: string): Instruction {
  return {
    programId: tokenProgram,
    keys: [
      { pubkey: source, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: destination, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
    data: bytes(10, (v) => {
      v.setUint8(0, 12)
      v.setBigUint64(1, amount, true)
      v.setUint8(9, decimals)
    }),
  }
}

/** 创建关联代币账户（已存在时什么都不做），租金由 payer 付 */
export function createAssociatedTokenAccountIdempotent(payer: string, ata: string, owner: string, mint: string, tokenProgram: string): Instruction {
  return {
    programId: ASSOCIATED_TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: ata, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: tokenProgram, isSigner: false, isWritable: false },
    ],
    data: new Uint8Array([1]),
  }
}

/** 关闭代币账户（余额必须为 0），租金退给 destination */
export function closeAccount(account: string, destination: string, owner: string, tokenProgram: string): Instruction {
  return {
    programId: tokenProgram,
    keys: [
      { pubkey: account, isSigner: false, isWritable: true },
      { pubkey: destination, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
    data: new Uint8Array([9]),
  }
}

/** 撤销代币账户的授权（Approve 设置的 delegate），owner 签名 */
export function revoke(account: string, owner: string, tokenProgram: string): Instruction {
  return {
    programId: tokenProgram,
    keys: [
      { pubkey: account, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
    data: new Uint8Array([5]),
  }
}

/**
 * Token-2022 HarvestWithheldTokensToMint：把代币账户里暂存的转账手续费收到 mint 上（任何人都可以调用，不需要签名）。
 * 账户里有未提取的手续费时关不掉，关闭前先调用它
 */
export function harvestWithheldTokensToMint(mint: string, accounts: readonly string[]): Instruction {
  return {
    programId: TOKEN_2022_PROGRAM_ID,
    keys: [{ pubkey: mint, isSigner: false, isWritable: true }, ...accounts.map((pubkey) => ({ pubkey, isSigner: false, isWritable: true }))],
    // TransferFeeExtension（26）的 HarvestWithheldTokensToMint（4）
    data: new Uint8Array([26, 4]),
  }
}

export function setComputeUnitLimit(units: number): Instruction {
  return {
    programId: COMPUTE_BUDGET_PROGRAM_ID,
    keys: [],
    data: bytes(5, (v) => {
      v.setUint8(0, 2)
      v.setUint32(1, units, true)
    }),
  }
}

/** 优先费用：每个计算单元多付多少 micro-lamports */
export function setComputeUnitPrice(microLamports: bigint): Instruction {
  return {
    programId: COMPUTE_BUDGET_PROGRAM_ID,
    keys: [],
    data: bytes(9, (v) => {
      v.setUint8(0, 3)
      v.setBigUint64(1, microLamports, true)
    }),
  }
}
