import { Interface, getAddress } from 'ethers'

import type { WriteRpc } from '../write/rpc.js'
import type { EntryPointVersion } from './userOp.js'

/** eth-infinitism 的 SimpleAccountFactory（account-abstraction v0.7 / v0.8），各主流链上地址相同 */
export const SIMPLE_ACCOUNT_FACTORY_V07 = '0x91E60e0613810449d098b0b5Ec8b51A0FE8c8985'
export const SIMPLE_ACCOUNT_FACTORY_V08 = '0x13E9ed32155810FDbd067D4522C492D6f68E5944'

/**
 * 账户类型：
 * - 'simple'：eth-infinitism SimpleAccount，工厂按 owner + salt 生成的合约账户（首次使用时随 UserOperation 部署）。账户地址不是 owner 的地址，资产要放在账户里
 * - 'simple7702'：钱包自己（EOA 通过 EIP-7702 委托给 Simple7702Account），UserOperation 的 sender 就是钱包地址，只能用 EntryPoint v0.8
 */
export type SmartAccountKind = 'simple' | 'simple7702'

const factoryInterface = new Interface(['function createAccount(address owner, uint256 salt) returns (address)', 'function getAddress(address owner, uint256 salt) view returns (address)'])

const callTuple = '(address target, uint256 value, bytes data)[]'
const batchV08 = new Interface([`function executeBatch(${callTuple} calls)`])
const batchV07 = new Interface(['function executeBatch(address[] dest, uint256[] value, bytes[] func)'])

export interface BatchItem {
  to: string
  value: bigint
  data: string
}

/** 账户执行一批调用的 calldata（v0.8 的账户用 Call[]，v0.7 的 SimpleAccount 用三个数组） */
export function encodeExecuteBatch(version: EntryPointVersion, calls: readonly BatchItem[]): string {
  if (version === '0.8') {
    return batchV08.encodeFunctionData('executeBatch', [calls.map((c) => [c.to, c.value, c.data])])
  }
  return batchV07.encodeFunctionData('executeBatch', [calls.map((c) => c.to), calls.map((c) => c.value), calls.map((c) => c.data)])
}

export function defaultFactory(version: EntryPointVersion): string {
  return version === '0.8' ? SIMPLE_ACCOUNT_FACTORY_V08 : SIMPLE_ACCOUNT_FACTORY_V07
}

export interface CounterfactualAccount {
  address: string
  deployed: boolean
  factory: string
  /** 还没部署时的 createAccount calldata */
  factoryData: string
}

/** SimpleAccount 的地址（部署前就能算出来：向工厂 getAddress）和部署状态 */
export async function resolveSimpleAccount(rpc: WriteRpc, owner: string, version: EntryPointVersion, salt: bigint | number | string = 0n, factory = defaultFactory(version)): Promise<CounterfactualAccount> {
  const factoryAddress = getAddress(factory)
  if ((await rpc.code(factoryAddress)) === '0x') {
    throw new Error(`The SimpleAccountFactory ${factoryAddress} is not deployed on chain ${rpc.chainId}; pass smartAccount.factory`)
  }
  const [address] = factoryInterface.decodeFunctionResult('getAddress', await rpc.call({ to: factoryAddress, data: factoryInterface.encodeFunctionData('getAddress', [owner, salt]) }))
  const code = await rpc.code(address as string)
  return { address: getAddress(address as string), deployed: code !== '0x', factory: factoryAddress, factoryData: factoryInterface.encodeFunctionData('createAccount', [owner, salt]) }
}

/** 查询账户地址（不发送任何东西），传入 owner 地址 */
export async function getSimpleAccountAddress(rpc: WriteRpc, owner: string, version: EntryPointVersion = '0.7', salt: bigint | number | string = 0n, factory?: string): Promise<string> {
  return (await resolveSimpleAccount(rpc, owner, version, salt, factory)).address
}
