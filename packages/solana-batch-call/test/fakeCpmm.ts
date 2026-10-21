/** 测试用的假链：两个 CPMM 池子（SOL / USDC、TKN / SOL）和假的 CPMM 程序（独立实现的恒定乘积），swap / risk 的单元测试共用 */
import { decodeAddress } from '../src/address.js'
import { NATIVE_MINT, SolanaClient, TOKEN_PROGRAM_ID } from '../src/index.js'
import { Bytes, anchorIx } from '../src/liquidity/common.js'
import { RAYDIUM_CPMM_PROGRAM_ID } from '../src/lp.js'
import { CLOCK_SYSVAR_ID } from '../src/swap/common.js'
import { createFakeSolana, keypair } from './fakeSolana.js'
import { tokenAccountData, type MockAccount } from './mock.js'

export const USER = keypair(1)
export const USDC = keypair(40).address
export const TKN = keypair(41).address
const CONFIG = keypair(60).address
export const SOL = 1_000_000_000n
export const fast = { pollInterval: 1, timeout: 5_000, priorityFee: 0 }
export const u64 = (data: Uint8Array, o: number) => new DataView(data.buffer, data.byteOffset).getBigUint64(o, true)
export const setU64 = (data: Uint8Array, o: number, v: bigint) => new DataView(data.buffer, data.byteOffset).setBigUint64(o, v, true)

interface FakePool {
  address: string
  mint0: string
  mint1: string
  vault0: string
  vault1: string
}

function poolData(p: FakePool): Uint8Array {
  const data = new Uint8Array(637)
  data.set(decodeAddress(CONFIG), 8)
  data.set(decodeAddress(p.vault0), 72)
  data.set(decodeAddress(p.vault1), 104)
  data.set(decodeAddress(keypair(99).address), 136)
  data.set(decodeAddress(p.mint0), 168)
  data.set(decodeAddress(p.mint1), 200)
  data.set(decodeAddress(keypair(98).address), 296)
  setU64(data, 333, 10n ** 9n)
  return data
}

/** 假的 CPMM：按 0.25% 手续费（向上取整）的恒定乘积，最少收到不够时失败 */
/** 不让卖出的代币（模拟貔貅盘：卖出 TKN 时失败）/ 不让买入 */
export const blocked = { sell: new Set<string>(), buy: new Set<string>() }

function fakeCpmm(ix: { keys: string[]; data: Uint8Array }, state: Record<string, MockAccount>) {
  if (!ix.data.slice(0, 8).every((b, i) => b === anchorIx('swap_base_input')[i])) throw new Error('unknown instruction')
  const [, , , , input, output, vaultIn, vaultOut] = ix.keys as string[]
  const amountIn = u64(ix.data, 8)
  const minOut = u64(ix.data, 16)
  const balance = (a: string) => u64(state[a]?.data as Uint8Array, 64)
  const add = (a: string, d: bigint) => {
    const account = state[a] as MockAccount
    if (balance(a) + d < 0n) throw new Error(`insufficient funds in ${a}`)
    setU64(account.data as Uint8Array, 64, balance(a) + d)
    if (new Bytes(account.data as Uint8Array).key(0) === NATIVE_MINT) account.lamports = (account.lamports ?? 0n) + d
  }
  const mintOf = (a: string) => new Bytes(state[a]?.data as Uint8Array).key(0)
  if (blocked.sell.has(mintOf(input as string))) throw new Error('sell is not allowed')
  if (blocked.buy.has(mintOf(output as string))) throw new Error('buy is not allowed')
  const afterFee = amountIn - (amountIn * 2500n + 999_999n) / 1_000_000n
  const out = (afterFee * balance(vaultOut as string)) / (balance(vaultIn as string) + afterFee)
  if (out < minOut) throw new Error('ExceededSlippage')
  add(input as string, -amountIn)
  add(vaultIn as string, amountIn)
  add(vaultOut as string, -out)
  add(output as string, out)
}

export const SOL_USDC: FakePool = { address: keypair(50).address, mint0: NATIVE_MINT, mint1: USDC, vault0: keypair(51).address, vault1: keypair(52).address }
export const TKN_SOL: FakePool = { address: keypair(53).address, mint0: TKN, mint1: NATIVE_MINT, vault0: keypair(54).address, vault1: keypair(55).address }

export function setupCpmmChain() {
  const chain = createFakeSolana({ programs: { [RAYDIUM_CPMM_PROGRAM_ID]: fakeCpmm } })
  chain.addMint(NATIVE_MINT, 9)
  chain.addMint(USDC, 6)
  chain.addMint(TKN, 6)
  chain.setSol(USER.address, 10n * SOL)
  chain.setToken(USER.address, TKN, 1000n * 10n ** 6n)
  const config = new Uint8Array(236)
  setU64(config, 12, 2500n) // trade_fee_rate 0.25%
  chain.accounts[CONFIG] = { lamports: 10n ** 7n, owner: RAYDIUM_CPMM_PROGRAM_ID, data: config }
  const clock = new Uint8Array(40)
  setU64(clock, 16, 700n)
  setU64(clock, 32, 1_800_000_000n)
  chain.accounts[CLOCK_SYSVAR_ID] = { lamports: 1n, owner: 'Sysvar1111111111111111111111111111111111111', data: clock }
  // SOL / USDC：100 SOL / 15000 USDC；TKN / SOL：50000 TKN / 100 SOL
  for (const [p, r0, r1] of [
    [SOL_USDC, 100n * SOL, 15_000n * 10n ** 6n],
    [TKN_SOL, 50_000n * 10n ** 6n, 100n * SOL],
  ] as const) {
    chain.accounts[p.address] = { lamports: 10n ** 7n, owner: RAYDIUM_CPMM_PROGRAM_ID, data: poolData(p) }
    chain.accounts[p.vault0] = { lamports: 2_039_280n + (p.mint0 === NATIVE_MINT ? r0 : 0n), owner: TOKEN_PROGRAM_ID, data: tokenAccountData(p.mint0, p.address, r0) }
    chain.accounts[p.vault1] = { lamports: 2_039_280n + (p.mint1 === NATIVE_MINT ? r1 : 0n), owner: TOKEN_PROGRAM_ID, data: tokenAccountData(p.mint1, p.address, r1) }
  }
  return { chain, client: new SolanaClient(chain.transport) }
}

