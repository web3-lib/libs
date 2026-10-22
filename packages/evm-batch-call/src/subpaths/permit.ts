/**
 * 免 gas 授权（子路径 `@w3lib/evm-batch-call/permit`）：EIP-2612 permit、DAI 风格 permit、Permit2（PermitSingle / PermitBatch / permitTransferFrom）。
 * 构建 EIP-712 数据 → 用 ethers Signer 签名 → 本地验证 → 生成上链的 calldata。不放在主入口，不用时打包不会带上。
 *
 * ```ts
 * import { buildPermit, signPermit, permitCalldata } from '@w3lib/evm-batch-call/permit'
 *
 * const permit = await buildPermit(provider, { token: USDC, owner, spender: router, value: 100_000_000n }) // 精确额度，30 分钟有效
 * const signed = await signPermit(signer, permit)      // signer：Wallet / 浏览器钱包的 JsonRpcSigner
 * const data = permitCalldata(signed)                  // token.permit(...) 的 calldata，谁都可以提交
 * ```
 */
export {
  DEFAULT_PERMIT_DEADLINE,
  MAX_PERMIT_DEADLINE,
  MAX_UINT160,
  PERMIT2_ADDRESS,
  assertPermitSafe,
  buildPermit,
  buildPermit2Batch,
  buildPermit2Single,
  buildPermit2Transfer,
  detectPermit,
  permit2Calldata,
  permitCalldata,
  permitTransferFromCalldata,
  signPermit,
  verifyPermitSignature,
  type BuildPermitParams,
  type Permit,
  type Permit2AllowanceParams,
  type Permit2BatchParams,
  type Permit2TransferParams,
  type PermitKind,
  type PermitOptions,
  type PermitSupport,
  type SignedPermit,
  type TypedData,
} from '../permit.js'
