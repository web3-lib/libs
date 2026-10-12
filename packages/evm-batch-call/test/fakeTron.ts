import { Interface, SigningKey, computeAddress, getBytes, hexlify, sha256, toUtf8String } from 'ethers'

import { multicall3Interface } from '../src/aggregate.js'
import { toEvmAddress, toTronAddress } from '../src/tron.js'

export const MULTICALL = 'TEazPvZwDjDtFeJupyo7QunvnrnUjPH8ED'
const GENESIS = '00000000000000001ebf88508a03865c71d452e25f4d51194196a1d22b6653dc'
/** 能量单价（sun） */
export const ENERGY_FEE = 210n
/** 带宽单价（sun / 字节） */
export const BANDWIDTH_FEE = 1000n
/** 激活新账户：激活费 1 TRX + 创建账户的带宽（没有质押带宽时烧 0.1 TRX），不再收普通带宽费 */
export const NEW_ACCOUNT_FEE = 1_000_000n
export const CREATE_ACCOUNT_FEE = 100_000n
export const ACTIVATION_FEE = NEW_ACCOUNT_FEE + CREATE_ACCOUNT_FEE
/** 代币转账消耗的能量（收款人没有余额时更多） */
export const TRANSFER_ENERGY = 30_000
export const TRANSFER_ENERGY_NEW_HOLDER = 65_000

const erc20 = new Interface([
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function balanceOf(address) view returns (uint256)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function faucet()',
])
const errorInterface = new Interface(['error Error(string)'])

/** 通用 protobuf 解码：字段号 → 值列表（varint 为 bigint，长度分隔为 Uint8Array） */
function decode(bytes: Uint8Array): Map<number, Array<bigint | Uint8Array>> {
  const out = new Map<number, Array<bigint | Uint8Array>>()
  let o = 0
  const varint = () => {
    let v = 0n
    for (let shift = 0n; ; shift += 7n) {
      const b = bytes[o++] as number
      v |= BigInt(b & 0x7f) << shift
      if (!(b & 0x80)) return v
    }
  }
  while (o < bytes.length) {
    const key = Number(varint())
    const field = key >> 3
    let value: bigint | Uint8Array
    if ((key & 7) === 0) {
      value = varint()
    } else {
      const length = Number(varint())
      value = bytes.slice(o, (o += length))
    }
    out.set(field, [...(out.get(field) ?? []), value])
  }
  return out
}

const one = <T>(m: Map<number, Array<bigint | Uint8Array>>, f: number, fallback: T): T => ((m.get(f)?.[0] as T | undefined) ?? fallback)
const tronOf = (bytes: Uint8Array) => toTronAddress(hexlify(bytes.slice(1)))

interface Account {
  balance: bigint
  freeNetUsed: number
}

export interface FakeTronOptions {
  /** 广播后过几次查询才上链，默认 0 */
  landAfterPolls?: number
  /** 前几次广播丢弃（不会上链） */
  drop?: number
  /** 链上时间，默认 Date.now（测试里拨快 Date.now 时节点也跟着变）；传固定的真实时钟可以模拟本地时钟不准 */
  clock?: () => number
  /** 前几次查交易信息时报错（模拟限频 / 节点故障） */
  infoErrors?: number
  /** 前几次广播返回这个错误码，但交易其实被收下了（模拟前一个超时的节点已经收下） */
  broadcastCode?: { code: string; times: number }
  /** 账户的质押资源 */
  staked?: Record<string, { NetLimit?: number; NetUsed?: number; EnergyLimit?: number; EnergyUsed?: number }>
}

/** 拦截请求：返回 undefined 时照常处理；可以抛错、返回别的结果，或调用 next 后再处理 */
export type TronInterceptor = (path: string, body: Record<string, any>, next: () => Promise<any>) => unknown

/** 假 Tron 全节点：解码 / 验签 / 执行 TransferContract 与 TRC20 的 TriggerSmartContract，按能量和带宽收费 */
export function createFakeTron(options: FakeTronOptions = {}) {
  const accounts = new Map<string, Account>()
  const tokens = new Map<string, { decimals: number; balances: Map<string, bigint>; blocked: Set<string> }>()
  const infos = new Map<string, Record<string, unknown>>()
  const pending: Array<{ txId: string; run: () => void; polls: number }> = []
  let toDrop = options.drop ?? 0
  let block = 5000
  const now = () => (options.clock ?? Date.now)()
  const broadcasts: string[] = []
  /** 能接收 TRX 的合约（receive 消耗 500 能量） */
  const vaults = new Set<string>()
  let infoErrors = options.infoErrors ?? 0
  let codeTimes = options.broadcastCode?.times ?? 0

  const account = (address: string) => accounts.get(address)
  const tokenOf = (address: string) => tokens.get(toTronAddress(toEvmAddress(address)))

  /** 执行代币调用（msg.sender = from）；返回能量和返回值，失败时 revert 带原因 */
  function execToken(from: string, contract: string, data: string, state: Map<string, bigint> | null): { energy: number; output: string; reverted: string | null } {
    const token = tokenOf(contract)
    if (!token) return { energy: 0, output: '0x', reverted: 'no contract' }
    const parsed = erc20.parseTransaction({ data })
    switch (parsed?.name) {
      case 'decimals':
        return { energy: 300, output: erc20.encodeFunctionResult('decimals', [token.decimals]), reverted: null }
      case 'symbol':
        return { energy: 300, output: erc20.encodeFunctionResult('symbol', ['TKN']), reverted: null }
      case 'balanceOf':
        return { energy: 300, output: erc20.encodeFunctionResult('balanceOf', [token.balances.get(toTronAddress(parsed.args[0])) ?? 0n]), reverted: null }
      case 'faucet': {
        // 测试用：给调用者 1000（后一笔转账依赖它时用来测“等前一笔确认再模拟”）
        if (state === null) token.balances.set(from, (token.balances.get(from) ?? 0n) + 1000n)
        else state.set(from, (state.get(from) ?? 0n) + 1000n)
        return { energy: 20_000, output: '0x', reverted: null }
      }
      case 'transfer': {
        const to = toTronAddress(parsed.args[0])
        const amount = parsed.args[1] as bigint
        const balances = state ?? token.balances
        const energy = (balances.get(to) ?? 0n) > 0n ? TRANSFER_ENERGY : TRANSFER_ENERGY_NEW_HOLDER
        if (token.blocked.has(to)) return { energy, output: errorInterface.encodeErrorResult('Error', ['blocked']), reverted: 'blocked' }
        const have = balances.get(from) ?? 0n
        if (have < amount) return { energy, output: errorInterface.encodeErrorResult('Error', ['insufficient balance']), reverted: 'insufficient balance' }
        if (state === null) {
          balances.set(from, have - amount)
          balances.set(to, (balances.get(to) ?? 0n) + amount)
        }
        return { energy, output: erc20.encodeFunctionResult('transfer', [true]), reverted: null }
      }
      default:
        return { energy: 1000, output: '0x', reverted: 'unknown method' }
    }
  }

  function constant(body: Record<string, string>) {
    const owner = tronOf(getBytes(`0x${body.owner_address}`))
    const contract = tronOf(getBytes(`0x${body.contract_address}`))
    const data = `0x${body.data ?? ''}`
    if (vaults.has(contract)) {
      return { result: { result: true }, energy_used: 500, constant_result: [''], transaction: { ret: [{}] } }
    }
    if (contract === MULTICALL) {
      const parsed = multicall3Interface.parseTransaction({ data })
      const out = (parsed?.args[0] as Array<{ target: string; callData: string }>).map((c) => {
        const r = execToken(MULTICALL, c.target, c.callData, new Map())
        return [r.reverted === null, r.output]
      })
      return { result: { result: true }, energy_used: 1000, constant_result: [multicall3Interface.encodeFunctionResult('aggregate3', [out]).slice(2)], transaction: { ret: [{}] } }
    }
    if (!tokenOf(contract)) {
      return { result: { code: 'CONTRACT_VALIDATE_ERROR', message: Buffer.from('Smart contract is not exist.').toString('hex') } }
    }
    const token = tokenOf(contract)!
    const r = execToken(owner, contract, data, new Map(token.balances))
    return {
      result: r.reverted ? { result: true, message: Buffer.from('REVERT opcode executed').toString('hex') } : { result: true },
      energy_used: r.energy,
      constant_result: [r.output.slice(2)],
      transaction: { ret: [r.reverted ? { ret: 'FAILED' } : {}] },
    }
  }

  function broadcast(hex: string) {
    const tx = decode(getBytes(`0x${hex}`))
    const raw = one(tx, 1, new Uint8Array())
    const signature = one(tx, 2, new Uint8Array())
    const txId = sha256(raw).slice(2)
    broadcasts.push(txId)
    const rawFields = decode(raw)
    const contract = decode(one(rawFields, 11, new Uint8Array()))
    const type = Number(one(contract, 1, 0n))
    const any = decode(one(contract, 2, new Uint8Array()))
    const typeUrl = toUtf8String(one(any, 1, new Uint8Array()))
    const param = decode(one(any, 2, new Uint8Array()))
    const owner = tronOf(one(param, 1, new Uint8Array()))
    const fail = (code: string, message: string) => ({ code, txid: txId, message: Buffer.from(message).toString('hex') })

    const signer = toTronAddress(computeAddress(SigningKey.recoverPublicKey(`0x${txId}`, hexlify(signature))))
    if (signer !== owner) return fail('SIGERROR', 'validate signature error')
    if (Number(one(rawFields, 8, 0n)) < now()) return fail('TRANSACTION_EXPIRATION_ERROR', 'transaction expired')
    if (infos.has(txId) || pending.some((p) => p.txId === txId)) return fail('DUP_TRANSACTION_ERROR', 'dup transaction')
    const from = account(owner)
    if (!from) return fail('CONTRACT_VALIDATE_ERROR', `Validate TransferContract error, no OwnerAccount.`)
    // 带宽：免费带宽（600 / 天）够用时不收费，否则按字节烧 TRX
    const bytes = hex.length / 2 + 64
    const freeNet = Math.max(0, 600 - from.freeNetUsed)
    const stake = staked.get(owner)
    const stakedNet = stake ? Math.max(0, stake.NetLimit - stake.NetUsed) : 0
    // 与 java-tron 一致：质押带宽够用先用质押的，否则免费带宽够用用免费的，都不够整笔烧 TRX
    const netFee = stakedNet >= bytes || freeNet >= bytes ? 0n : BigInt(bytes) * BANDWIDTH_FEE
    /** 上链时消耗带宽 */
    const useNet = () => {
      if (stake && stakedNet >= bytes) stake.NetUsed += bytes
      else if (!netFee) from.freeNetUsed += bytes
    }
    /** 合约调用的能量：先用质押的，不够的部分烧 TRX；返回要烧的 sun（受余额和 fee_limit 限制时为 null） */
    const burnFor = (energy: number, feeLimit: bigint): bigint | null => {
      const fromStake = Math.min(energy, stake ? Math.max(0, stake.EnergyLimit - stake.EnergyUsed) : 0)
      const cost = BigInt(energy - fromStake) * ENERGY_FEE
      if (cost > (from.balance < feeLimit ? from.balance : feeLimit)) return null
      if (stake) stake.EnergyUsed += fromStake
      return cost
    }

    let run: () => void
    if (type === 1 && typeUrl.endsWith('TransferContract')) {
      const to = tronOf(one(param, 2, new Uint8Array()))
      if (vaults.has(to) || tokenOf(to)) return fail('CONTRACT_VALIDATE_ERROR', 'Cannot transfer TRX to a smartContract.')
      const amount = one(param, 3, 0n)
      // 给没激活的地址转：按创建账户计费（激活费 + 质押带宽或 0.1 TRX），不收普通带宽费、不用免费带宽
      const creates = !account(to)
      const fee = creates ? NEW_ACCOUNT_FEE + (stakedNet >= bytes ? 0n : CREATE_ACCOUNT_FEE) : netFee
      if (from.balance < amount + fee) return fail('CONTRACT_VALIDATE_ERROR', 'Validate TransferContract error, balance is not sufficient.')
      run = () => {
        from.balance -= amount + fee
        if (creates) {
          if (stake && stakedNet >= bytes) stake.NetUsed += bytes
        } else {
          useNet()
        }
        const target = account(to) ?? { balance: 0n, freeNetUsed: 0 }
        target.balance += amount
        accounts.set(to, target)
        infos.set(txId, { id: txId, blockNumber: ++block, fee: Number(fee), receipt: { net_usage: fee ? 0 : bytes } })
      }
    } else if (type === 31 && vaults.has(tronOf(one(param, 2, new Uint8Array())))) {
      // 给合约转 TRX：空 calldata 带 call_value
      const vault = tronOf(one(param, 2, new Uint8Array()))
      const callValue = one(param, 3, 0n)
      const feeLimit = one(rawFields, 18, 0n)
      if (from.balance < callValue + netFee) return fail('CONTRACT_VALIDATE_ERROR', 'balance is not sufficient')
      run = () => {
        from.balance -= netFee + callValue
        useNet()
        const burned = burnFor(500, feeLimit) ?? (from.balance < feeLimit ? from.balance : feeLimit)
        from.balance -= burned
        const target = account(vault) ?? { balance: 0n, freeNetUsed: 0 }
        target.balance += callValue
        accounts.set(vault, target)
        infos.set(txId, { id: txId, blockNumber: ++block, fee: Number(netFee + burned), receipt: { energy_usage_total: 500, result: 'SUCCESS' } })
      }
    } else if (type === 31) {
      const contractAddress = tronOf(one(param, 2, new Uint8Array()))
      const data = hexlify(one(param, 4, new Uint8Array()))
      const feeLimit = one(rawFields, 18, 0n)
      if (from.balance < netFee) return fail('BANDWITH_ERROR', 'Account resource insufficient error.')
      run = () => {
        from.balance -= netFee
        useNet()
        const preview = execToken(owner, contractAddress, data, new Map(tokenOf(contractAddress)?.balances ?? []))
        const cost = burnFor(preview.energy, feeLimit)
        let result = 'SUCCESS'
        let burned = cost ?? 0n
        let output = preview.output
        if (cost === null) {
          result = 'OUT_OF_ENERGY'
          burned = from.balance < feeLimit ? from.balance : feeLimit
          output = '0x'
        } else if (preview.reverted) {
          result = 'REVERT'
        } else {
          execToken(owner, contractAddress, data, null)
        }
        from.balance -= burned
        infos.set(txId, {
          id: txId,
          blockNumber: ++block,
          fee: Number(burned + netFee),
          contractResult: [output.slice(2)],
          receipt: { energy_usage_total: preview.energy, energy_fee: Number(burned), result },
          ...(result === 'SUCCESS' ? {} : { result: 'FAILED', resMessage: Buffer.from(result === 'REVERT' ? 'REVERT opcode executed' : 'Not enough energy').toString('hex') }),
        })
      }
    } else {
      return fail('CONTRACT_VALIDATE_ERROR', 'unsupported contract')
    }
    if (toDrop > 0) {
      toDrop--
      return { result: true, txid: txId } // 节点收下了，但永远不会上链
    }
    if (!options.landAfterPolls) run()
    else pending.push({ txId, run, polls: 0 })
    if (codeTimes > 0) {
      codeTimes--
      return fail(options.broadcastCode!.code, 'node problem')
    }
    return { result: true, txid: txId }
  }

  /** 各账户的质押资源（执行交易时会消耗） */
  const staked = new Map(Object.entries(options.staked ?? {}).map(([a, s]) => [a, { NetLimit: 0, NetUsed: 0, EnergyLimit: 0, EnergyUsed: 0, ...s }]))
  let interceptor: TronInterceptor | null = null
  const request = async (path: string, body: Record<string, any>): Promise<any> => {
    if (interceptor) {
      const result = await interceptor(path, body, () => handle(path, body))
      if (result !== undefined) return result
    }
    return handle(path, body)
  }
  const handle = async (path: string, body: Record<string, any>): Promise<any> => {
    switch (path) {
      case 'wallet/getblockbynum':
        return { blockID: GENESIS }
      case 'wallet/getblock':
      case 'walletsolidity/getblock':
        return { blockID: `${block.toString(16).padStart(16, '0')}${'ab'.repeat(24)}`, block_header: { raw_data: { number: block, timestamp: now() } } }
      case 'wallet/getcontract': {
        const address = tronOf(getBytes(`0x${body.value}`))
        return vaults.has(address) || tokenOf(address) ? { contract_address: body.value, bytecode: '00' } : {}
      }
      case 'walletsolidity/gettransactioninfobyid':
        return infos.get(body.value) ?? {}
      case 'wallet/getchainparameters':
        return {
          chainParameter: [
            { key: 'getEnergyFee', value: Number(ENERGY_FEE) },
            { key: 'getTransactionFee', value: Number(BANDWIDTH_FEE) },
            { key: 'getCreateNewAccountFeeInSystemContract', value: Number(NEW_ACCOUNT_FEE) },
            { key: 'getCreateAccountFee', value: Number(CREATE_ACCOUNT_FEE) },
          ],
        }
      case 'wallet/getaccount': {
        const address = tronOf(getBytes(`0x${body.address}`))
        const a = account(address)
        return a ? { address: body.address, balance: Number(a.balance) } : {}
      }
      case 'wallet/getaccountresource': {
        const address = tronOf(getBytes(`0x${body.address}`))
        const a = account(address)
        return a ? { freeNetLimit: 600, freeNetUsed: a.freeNetUsed, ...staked.get(address) } : {}
      }
      case 'wallet/triggerconstantcontract':
        return constant(body)
      case 'wallet/broadcasthex':
        return broadcast(body.transaction)
      case 'wallet/gettransactioninfobyid': {
        if (infoErrors > 0) {
          infoErrors--
          throw new Error('HTTP 429')
        }
        for (const entry of [...pending]) {
          if (++entry.polls > (options.landAfterPolls ?? 0)) {
            pending.splice(pending.indexOf(entry), 1)
            entry.run()
          }
        }
        return infos.get(body.value) ?? {}
      }
      default:
        throw new Error(`fake tron: unsupported ${path}`)
    }
  }

  return {
    request,
    intercept(fn: TronInterceptor | null) {
      interceptor = fn
    },
    broadcasts,
    infos,
    setTrx(address: string, balance: bigint) {
      accounts.set(address, { balance, freeNetUsed: 0 })
    },
    /** 把今天的免费带宽用完 */
    exhaustFreeBandwidth(address: string) {
      const a = account(address)
      if (a) a.freeNetUsed = 600
    },
    trx(address: string): bigint | null {
      return account(address)?.balance ?? null
    },
    addVault(address: string) {
      vaults.add(address)
    },
    addToken(address: string, decimals: number, balances: Record<string, bigint> = {}) {
      tokens.set(address, { decimals, balances: new Map(Object.entries(balances)), blocked: new Set() })
    },
    token(address: string, owner: string) {
      return tokenOf(address)?.balances.get(owner) ?? 0n
    },
    block(token: string, recipient: string) {
      tokenOf(token)?.blocked.add(recipient)
    },
  }
}
