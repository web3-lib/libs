import { AbiCoder, Interface, TypedDataEncoder, concat, getAddress, getBytes, keccak256, toBeHex, zeroPadValue, type Authorization } from 'ethers'

/** ERC-4337 EntryPoint 的两个版本，各主流链上地址相同 */
export const ENTRY_POINT_V07 = '0x0000000071727De22E5E9d8BAf0edAc6f37da032'
export const ENTRY_POINT_V08 = '0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108'

export type EntryPointVersion = '0.7' | '0.8'

export function entryPointAddress(version: EntryPointVersion): string {
  return version === '0.8' ? ENTRY_POINT_V08 : ENTRY_POINT_V07
}

/** EntryPoint v0.8 把 initCode 以 0x7702 开头（至少 20 字节）的 UserOperation 当作 EIP-7702 账户 */
export const EIP7702_MARKER = '0x7702000000000000000000000000000000000000'

/** UserOperation（bundler JSON-RPC 的“拆开”格式，数值用 bigint） */
export interface UserOperation {
  sender: string
  nonce: bigint
  /** 账户还没部署时创建它的工厂 + calldata；EIP-7702 账户用 EIP7702_MARKER 作为 factory */
  factory?: string
  factoryData?: string
  callData: string
  callGasLimit: bigint
  verificationGasLimit: bigint
  preVerificationGas: bigint
  maxFeePerGas: bigint
  maxPriorityFeePerGas: bigint
  paymaster?: string
  paymasterVerificationGasLimit?: bigint
  paymasterPostOpGasLimit?: bigint
  paymasterData?: string
  signature: string
  /** EIP-7702 授权（账户还没委托时随 UserOperation 一起交给 bundler） */
  eip7702Auth?: Authorization
}

/** 打包后的 UserOperation（EntryPoint.handleOps 的参数） */
export interface PackedUserOperation {
  sender: string
  nonce: bigint
  initCode: string
  callData: string
  accountGasLimits: string
  preVerificationGas: bigint
  gasFees: string
  paymasterAndData: string
  signature: string
}

const u128 = (value: bigint) => zeroPadValue(toBeHex(value), 16)

export function initCodeOf(op: Pick<UserOperation, 'factory' | 'factoryData'>): string {
  return op.factory ? concat([op.factory, op.factoryData ?? '0x']) : '0x'
}

export function paymasterAndDataOf(op: UserOperation): string {
  if (!op.paymaster) {
    return '0x'
  }
  return concat([op.paymaster, u128(op.paymasterVerificationGasLimit ?? 0n), u128(op.paymasterPostOpGasLimit ?? 0n), op.paymasterData ?? '0x'])
}

export function packUserOp(op: UserOperation): PackedUserOperation {
  return {
    sender: getAddress(op.sender),
    nonce: op.nonce,
    initCode: initCodeOf(op),
    callData: op.callData,
    accountGasLimits: concat([u128(op.verificationGasLimit), u128(op.callGasLimit)]),
    preVerificationGas: op.preVerificationGas,
    gasFees: concat([u128(op.maxPriorityFeePerGas), u128(op.maxFeePerGas)]),
    paymasterAndData: paymasterAndDataOf(op),
    signature: op.signature,
  }
}

/** v0.8 的 EIP-712 类型（userOpHash 就是它的摘要，所以钱包可以直接 signTypedData 签） */
export const USER_OP_TYPES = {
  PackedUserOperation: [
    { name: 'sender', type: 'address' },
    { name: 'nonce', type: 'uint256' },
    { name: 'initCode', type: 'bytes' },
    { name: 'callData', type: 'bytes' },
    { name: 'accountGasLimits', type: 'bytes32' },
    { name: 'preVerificationGas', type: 'uint256' },
    { name: 'gasFees', type: 'bytes32' },
    { name: 'paymasterAndData', type: 'bytes' },
  ],
}

/**
 * v0.8 的 EIP-712 数据。EIP-7702 账户（initCode 以 0x7702 开头）：EntryPoint 算哈希时把 initCode 换成
 * “账户当前委托的合约地址 ‖ initCode[20:]”，所以要传 delegate（账户将要委托 / 已委托的合约）
 */
export function userOpTypedData(op: UserOperation, entryPoint: string, chainId: number, delegate?: string) {
  const packed = packUserOp(op)
  let initCode = packed.initCode
  if (initCode.toLowerCase().startsWith('0x7702') && getBytes(initCode).length >= 20) {
    if (!delegate) {
      throw new Error('delegate is required to hash an EIP-7702 UserOperation')
    }
    initCode = concat([getAddress(delegate), `0x${initCode.slice(2 + 40)}`])
  }
  const { signature: _signature, ...message } = packed
  return {
    domain: { name: 'ERC4337', version: '1', chainId, verifyingContract: getAddress(entryPoint) },
    types: USER_OP_TYPES,
    message: { ...message, initCode },
  }
}

/** UserOperation 哈希（与 EntryPoint.getUserOpHash 一致） */
export function getUserOpHash(op: UserOperation, entryPoint: string, chainId: number, version: EntryPointVersion, delegate?: string): string {
  if (version === '0.8') {
    const { domain, types, message } = userOpTypedData(op, entryPoint, chainId, delegate)
    return TypedDataEncoder.hash(domain, types, message)
  }
  const p = packUserOp(op)
  const coder = AbiCoder.defaultAbiCoder()
  const inner = keccak256(
    coder.encode(
      ['address', 'uint256', 'bytes32', 'bytes32', 'bytes32', 'uint256', 'bytes32', 'bytes32'],
      [p.sender, p.nonce, keccak256(p.initCode), keccak256(p.callData), p.accountGasLimits, p.preVerificationGas, p.gasFees, keccak256(p.paymasterAndData)],
    ),
  )
  return keccak256(coder.encode(['bytes32', 'address', 'uint256'], [inner, getAddress(entryPoint), chainId]))
}

/** JSON-RPC 数值：0x 十六进制、没有前导零 */
export const quantity = (v: bigint | number): string => `0x${v.toString(16)}`

/** bundler JSON-RPC 的 UserOperation（数值为 0x 十六进制） */
export function userOpToRpc(op: UserOperation): Record<string, unknown> {
  const q = quantity
  const rpc: Record<string, unknown> = { sender: getAddress(op.sender), nonce: q(op.nonce), callData: op.callData }
  if (op.factory) {
    rpc.factory = op.factory
    rpc.factoryData = op.factoryData ?? '0x'
  }
  Object.assign(rpc, {
    callGasLimit: q(op.callGasLimit),
    verificationGasLimit: q(op.verificationGasLimit),
    preVerificationGas: q(op.preVerificationGas),
    maxFeePerGas: q(op.maxFeePerGas),
    maxPriorityFeePerGas: q(op.maxPriorityFeePerGas),
  })
  if (op.paymaster) {
    Object.assign(rpc, {
      paymaster: op.paymaster,
      paymasterVerificationGasLimit: q(op.paymasterVerificationGasLimit ?? 0n),
      paymasterPostOpGasLimit: q(op.paymasterPostOpGasLimit ?? 0n),
      paymasterData: op.paymasterData ?? '0x',
    })
  }
  rpc.signature = op.signature
  if (op.eip7702Auth) {
    const a = op.eip7702Auth
    rpc.eip7702Auth = { chainId: q(BigInt(a.chainId)), address: a.address, nonce: q(BigInt(a.nonce)), yParity: a.signature.yParity === 0 ? '0x0' : '0x1', r: a.signature.r, s: a.signature.s }
  }
  return rpc
}

/** 估算 gas 时用的占位签名（65 字节、格式合法的 ECDSA 签名，账户校验时不会因为长度 / 格式直接 revert） */
export const DUMMY_SIGNATURE = `0x${'f'.repeat(31)}0${'0'.repeat(32)}7${'a'.repeat(63)}1c`

export const entryPointInterface = new Interface([
  'function handleOps((address sender, uint256 nonce, bytes initCode, bytes callData, bytes32 accountGasLimits, uint256 preVerificationGas, bytes32 gasFees, bytes paymasterAndData, bytes signature)[] ops, address beneficiary)',
  'function getNonce(address sender, uint192 key) view returns (uint256)',
  'function getUserOpHash((address sender, uint256 nonce, bytes initCode, bytes callData, bytes32 accountGasLimits, uint256 preVerificationGas, bytes32 gasFees, bytes paymasterAndData, bytes signature) userOp) view returns (bytes32)',
  'error FailedOp(uint256 opIndex, string reason)',
  'error FailedOpWithRevert(uint256 opIndex, string reason, bytes inner)',
  'event UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)',
  'event UserOperationRevertReason(bytes32 indexed userOpHash, address indexed sender, uint256 nonce, bytes revertReason)',
])

/** 十六进制数值 → bigint（bundler 返回的字段） */
export function hexToBigInt(value: unknown): bigint {
  return value === undefined || value === null ? 0n : BigInt(value as string)
}
