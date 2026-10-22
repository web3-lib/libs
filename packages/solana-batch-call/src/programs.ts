/**
 * 常见程序的名字、指令名（Anchor 程序按 sha256("global:<name>") 的前 8 字节识别）和自定义错误码，
 * 给 /simulate 和 /history 说明交易在做什么。只收录认得准的，其他程序只显示地址
 */
import { sha256 } from '@noble/hashes/sha2.js'

import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  SYSTEM_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from './constants.js'

// 与 lp.ts 里的同名常量相同；这里不 import 它，避免 /simulate、/history 把整个 LP 模块打进来
const RAYDIUM_CLMM_PROGRAM_ID = 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK'
const ORCA_WHIRLPOOL_PROGRAM_ID = 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc'
const RAYDIUM_AMM_PROGRAM_ID = '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8'
const RAYDIUM_CPMM_PROGRAM_ID = 'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C'

export const COMPUTE_BUDGET = 'ComputeBudget111111111111111111111111111111'
export const MEMO_V2 = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'
export const MEMO_V1 = 'Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo'
export const BPF_LOADER_UPGRADEABLE = 'BPFLoaderUpgradeab1e11111111111111111111111'

/** 指令的大类：交易的类型由它们和余额变化一起决定 */
export type IxType = 'transfer' | 'swap' | 'approve' | 'liquidity' | 'mint' | 'burn' | 'close' | 'setup' | 'budget' | 'memo' | 'contract' | 'unknown'

export interface ProgramInfo {
  name: string
  /** 内置程序（系统、代币、ATA、计算预算、备忘录等）：不算“不认识的程序” */
  builtin?: boolean
  /** 协议名（DEX / 借贷等），内置程序没有 */
  protocol?: string
}

const p = (name: string, protocol = name): ProgramInfo => ({ name, protocol })
const b = (name: string): ProgramInfo => ({ name, builtin: true })

export const PROGRAMS: Readonly<Record<string, ProgramInfo>> = {
  [SYSTEM_PROGRAM_ID]: b('System Program'),
  [TOKEN_PROGRAM_ID]: b('SPL Token'),
  [TOKEN_2022_PROGRAM_ID]: b('Token-2022'),
  [ASSOCIATED_TOKEN_PROGRAM_ID]: b('Associated Token Account'),
  [COMPUTE_BUDGET]: b('Compute Budget'),
  [MEMO_V2]: b('Memo'),
  [MEMO_V1]: b('Memo'),
  [BPF_LOADER_UPGRADEABLE]: b('BPF Loader Upgradeable'),
  AddressLookupTab1e1111111111111111111111111: b('Address Lookup Table'),
  Stake11111111111111111111111111111111111111: b('Stake Program'),
  Vote111111111111111111111111111111111111111: b('Vote Program'),
  Ed25519SigVerify111111111111111111111111111: b('Ed25519 Program'),
  KeccakSecp256k11111111111111111111111111111: b('Secp256k1 Program'),
  metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s: b('Metaplex Token Metadata'),
  JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4: p('Jupiter Aggregator v6', 'Jupiter'),
  JUP4Fb2cqiRUcaTHdrPC8h2gNsA2ETXiPDD33WcGuJB: p('Jupiter Aggregator v4', 'Jupiter'),
  DCA265Vj8a9CEuX1eb1LWRnDT7uK6q1xMipnNyatn23M: p('Jupiter DCA', 'Jupiter'),
  j1o2qRpjcyUwEvwtcfhEQefh773ZgjxcVRry7LDqg5X: p('Jupiter Limit Order', 'Jupiter'),
  jupoNjAxXgZ4rjzxzPMP4oxduvQsQtZzyknqvzYNrNu: p('Jupiter Limit Order v2', 'Jupiter'),
  PERPHjGBqRHArX4DySjwM6UJHiR3sWAatqfdBS2qQJu: p('Jupiter Perpetuals', 'Jupiter'),
  [RAYDIUM_AMM_PROGRAM_ID]: p('Raydium AMM v4', 'Raydium'),
  [RAYDIUM_CLMM_PROGRAM_ID]: p('Raydium CLMM', 'Raydium'),
  [RAYDIUM_CPMM_PROGRAM_ID]: p('Raydium CPMM', 'Raydium'),
  routeUGWgWzqBWFcrCfv8tritsqukccJPu3q5GPP3xS: p('Raydium Route', 'Raydium'),
  [ORCA_WHIRLPOOL_PROGRAM_ID]: p('Orca Whirlpool', 'Orca'),
  '9W959DqEETiGZocYWCQPaJ6sBmUzgfxXfqGeTEdp3aQP': p('Orca v2', 'Orca'),
  LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo: p('Meteora DLMM', 'Meteora'),
  Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB: p('Meteora Pools', 'Meteora'),
  cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG: p('Meteora DAMM v2', 'Meteora'),
  dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN: p('Meteora Dynamic Bonding Curve', 'Meteora'),
  '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P': p('Pump.fun', 'Pump.fun'),
  pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA: p('PumpSwap', 'Pump.fun'),
  PhoeNiXZ8ByJGLkxNfZRnkUfjvmuYqLR89jjFHGqdXY: p('Phoenix'),
  srmqPvymJeFKQ4zGQed1GFppgkRHL9kaELCbyksJtPX: p('OpenBook v1', 'OpenBook'),
  opnb2LAfJYbRMAHHvqjCwQxanZn7ReEHp1k81EohpZb: p('OpenBook v2', 'OpenBook'),
  LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj: p('Lifinity v2', 'Lifinity'),
  MarBmsSgKXdrN1egZf5sqe1TMai9K1rChYNDJgjq7aD: p('Marinade'),
  MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA: p('marginfi v2', 'marginfi'),
  KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD: p('Kamino Lending', 'Kamino'),
  dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH: p('Drift v2', 'Drift'),
  So1endDq2YkqhipRh3WViPa8hdiSpxWy6z3Z6tMCpAo: p('Solend'),
  SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf: p('Squads v4', 'Squads'),
  wormDTUJ6AWPNvk59vGQbDvGJmqbDTdgWgAqcLBCgUb: p('Wormhole Token Bridge', 'Wormhole'),
  CndyV3LdqHUfDLmE5naZjVN8rBZz4tqhdefbAnjHG3JR: p('Candy Machine v3', 'Metaplex'),
  Guard1JwRhJkVH6XZhzoYxeBVQe872VH6QggF4BWmS9g: p('Candy Guard', 'Metaplex'),
  CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d: p('Metaplex Core', 'Metaplex'),
  TSWAPaqyCSx2KABk68Shruf4rp7CxcNi8hAsbdwmHbN: p('Tensor Swap', 'Tensor'),
  M2mx93ekt1fmXSVkTrUL9xVFHkmME8HTUi5Cyc5aF7K: p('Magic Eden v2', 'Magic Eden'),
}

/** 按指令名（snake_case）识别的 Anchor 程序：指令名 → 大类 */
const JUPITER_METHODS: Record<string, IxType> = {
  ...Object.fromEntries(['route', 'route_with_token_ledger', 'shared_accounts_route', 'shared_accounts_route_with_token_ledger', 'exact_out_route', 'shared_accounts_exact_out_route'].map((n) => [n, 'swap'])),
  set_token_ledger: 'setup',
}

const ANCHOR: Record<string, Record<string, IxType>> = {
  JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4: JUPITER_METHODS,
  JUP4Fb2cqiRUcaTHdrPC8h2gNsA2ETXiPDD33WcGuJB: JUPITER_METHODS,
  dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN: { swap: 'swap', swap2: 'swap' },
  CndyV3LdqHUfDLmE5naZjVN8rBZz4tqhdefbAnjHG3JR: { mint: 'mint', mint_v2: 'mint' },
  Guard1JwRhJkVH6XZhzoYxeBVQe872VH6QggF4BWmS9g: { mint: 'mint', mint_v2: 'mint' },
  [ORCA_WHIRLPOOL_PROGRAM_ID]: {
    ...Object.fromEntries(['swap', 'swap_v2', 'two_hop_swap', 'two_hop_swap_v2'].map((n) => [n, 'swap'])),
    ...Object.fromEntries(
      [
        'increase_liquidity', 'increase_liquidity_v2', 'decrease_liquidity', 'decrease_liquidity_v2', 'open_position', 'open_position_with_metadata',
        'open_position_with_token_extensions', 'close_position', 'close_position_with_token_extensions', 'collect_fees', 'collect_fees_v2', 'collect_reward',
        'collect_reward_v2', 'open_bundled_position', 'close_bundled_position', 'increase_liquidity_by_token_amounts_v2',
      ].map((n) => [n, 'liquidity']),
    ),
    initialize_tick_array: 'setup',
    initialize_dynamic_tick_array: 'setup',
  },
  [RAYDIUM_CLMM_PROGRAM_ID]: {
    ...Object.fromEntries(['swap', 'swap_v2', 'swap_router_base_in'].map((n) => [n, 'swap'])),
    ...Object.fromEntries(
      ['open_position', 'open_position_v2', 'open_position_with_token22_nft', 'increase_liquidity', 'increase_liquidity_v2', 'decrease_liquidity', 'decrease_liquidity_v2', 'close_position', 'collect_fund_fee'].map((n) => [n, 'liquidity']),
    ),
  },
  [RAYDIUM_CPMM_PROGRAM_ID]: { swap_base_input: 'swap', swap_base_output: 'swap', deposit: 'liquidity', withdraw: 'liquidity' },
  LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo: {
    ...Object.fromEntries(['swap', 'swap_exact_out', 'swap_with_price_impact'].map((n) => [n, 'swap'])),
    ...Object.fromEntries(
      [
        'add_liquidity', 'add_liquidity_by_weight', 'add_liquidity_by_strategy', 'add_liquidity_by_strategy_one_side', 'add_liquidity_one_side', 'remove_liquidity',
        'remove_liquidity_by_range', 'remove_all_liquidity', 'claim_fee', 'claim_reward', 'close_position', 'initialize_position',
      ].map((n) => [n, 'liquidity']),
    ),
  },
  Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB: {
    swap: 'swap',
    add_balance_liquidity: 'liquidity',
    add_imbalance_liquidity: 'liquidity',
    remove_balance_liquidity: 'liquidity',
    remove_liquidity_single_side: 'liquidity',
  },
  cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG: {
    swap: 'swap',
    swap2: 'swap',
    add_liquidity: 'liquidity',
    remove_liquidity: 'liquidity',
    remove_all_liquidity: 'liquidity',
    claim_position_fee: 'liquidity',
    create_position: 'liquidity',
    close_position: 'liquidity',
  },
  '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P': { buy: 'swap', sell: 'swap', create: 'mint', create_v2: 'mint' },
  pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA: { buy: 'swap', sell: 'swap', deposit: 'liquidity', withdraw: 'liquidity', create_pool: 'liquidity' },
}

/** Raydium AMM v4：第一个字节是指令编号 */
const AMM_V4: Record<number, [string, IxType]> = {
  3: ['deposit', 'liquidity'],
  4: ['withdraw', 'liquidity'],
  9: ['swapBaseIn', 'swap'],
  11: ['swapBaseOut', 'swap'],
  16: ['swapBaseInV2', 'swap'],
  17: ['swapBaseOutV2', 'swap'],
}

let discriminators: Map<string, Map<string, [string, IxType]>> | undefined

const hex = (bytes: Uint8Array) => Array.from(bytes, (x) => x.toString(16).padStart(2, '0')).join('')

/** 认得的程序指令：返回指令名和大类；不认识的指令（程序认得）返回 null */
export function knownMethod(programId: string, data: Uint8Array): [method: string, type: IxType] | null {
  if (programId === RAYDIUM_AMM_PROGRAM_ID) return AMM_V4[data[0] as number] ?? null
  const methods = ANCHOR[programId]
  if (!methods || data.length < 8) return null
  if (!discriminators) {
    discriminators = new Map(
      Object.entries(ANCHOR).map(([program, list]) => [
        program,
        new Map(Object.entries(list).map(([name, type]) => [hex(sha256(new TextEncoder().encode(`global:${name}`)).slice(0, 8)), [name, type] as [string, IxType]])),
      ]),
    )
  }
  return discriminators.get(programId)?.get(hex(data.slice(0, 8))) ?? null
}

// ---------------------------------------------------------------------------
// 自定义错误码
// ---------------------------------------------------------------------------

const list = (names: string): Record<number, string> => Object.fromEntries(names.split(',').map((n, i) => [i, n]))

const SYSTEM_ERRORS = list('AccountAlreadyInUse,ResultWithNegativeLamports,InvalidProgramId,InvalidAccountDataLength,MaxSeedLengthExceeded,AddressWithSeedMismatch,NonceNoRecentBlockhashes,NonceBlockhashNotExpired,NonceUnexpectedBlockhashValue')
const TOKEN_ERRORS = list(
  'NotRentExempt,InsufficientFunds,InvalidMint,MintMismatch,OwnerMismatch,FixedSupply,AlreadyInUse,InvalidNumberOfProvidedSigners,InvalidNumberOfRequiredSigners,UninitializedState,NativeNotSupported,NonNativeHasBalance,InvalidInstruction,InvalidState,Overflow,AuthorityTypeNotSupported,MintCannotFreeze,AccountFrozen,MintDecimalsMismatch,NonNativeNotSupported',
)
const JUPITER_ERRORS: Record<number, string> = Object.fromEntries(
  'EmptyRoute,SlippageToleranceExceeded,InvalidCalculation,MissingPlatformFeeAccount,InvalidSlippage,NotEnoughPercent,InvalidInputIndex,InvalidOutputIndex,NotEnoughAccountKeys,NonZeroMinimumOutAmountNotSupported,InvalidRoutePlan,InvalidReferralAuthority,LedgerTokenAccountDoesNotMatch,InvalidTokenLedger,IncorrectTokenProgramID,TokenProgramNotProvided,SwapNotSupported,ExactOutAmountNotMatched,SourceAndDestinationMintCannotBeTheSame'
    .split(',')
    .map((n, i) => [6000 + i, n]),
)
const RAYDIUM_AMM_ERRORS: Record<number, string> = { 22: 'InvalidStatus', 23: 'InvalidInstruction', 30: 'ExceededSlippage', 40: 'InsufficientFunds' }
/** Anchor 框架自带的错误码（2000 起是账户约束） */
const ANCHOR_ERRORS: Record<number, string> = {
  100: 'InstructionMissing', 101: 'InstructionFallbackNotFound', 102: 'InstructionDidNotDeserialize', 2000: 'ConstraintMut', 2001: 'ConstraintHasOne',
  2002: 'ConstraintSigner', 2003: 'ConstraintRaw', 2004: 'ConstraintOwner', 2006: 'ConstraintSeeds', 2012: 'ConstraintAddress', 2014: 'ConstraintTokenMint',
  2015: 'ConstraintTokenOwner', 3001: 'AccountDiscriminatorNotFound', 3002: 'AccountDiscriminatorMismatch', 3003: 'AccountDidNotDeserialize',
  3007: 'AccountOwnedByWrongProgram', 3010: 'AccountNotSigner', 3012: 'AccountNotInitialized',
}

const PROGRAM_ERRORS: Record<string, Record<number, string>> = {
  [SYSTEM_PROGRAM_ID]: SYSTEM_ERRORS,
  [TOKEN_PROGRAM_ID]: TOKEN_ERRORS,
  [TOKEN_2022_PROGRAM_ID]: TOKEN_ERRORS,
  JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4: JUPITER_ERRORS,
  [RAYDIUM_AMM_PROGRAM_ID]: RAYDIUM_AMM_ERRORS,
}

/** 自定义错误码的名字：先看这个程序自己的表，再看 Anchor 框架的；认不出时返回 undefined */
export function programErrorName(programId: string | undefined, code: number): string | undefined {
  return (programId ? PROGRAM_ERRORS[programId]?.[code] : undefined) ?? ANCHOR_ERRORS[code]
}
