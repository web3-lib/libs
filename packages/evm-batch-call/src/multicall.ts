/**
 * Multicall3 部署地址表，来自 ethcall (MIT, https://github.com/Destiner/ethcall)，另补充了 Tron。
 * 表里没有的链（或地址在该链上无效）会自动走 deployless（见 contracts/DeploylessMulticall3.sol），
 * 不需要链上部署任何合约。
 */

export interface Multicall {
  address: string
  /** 合约部署所在区块；查询更早的区块时改走 deployless */
  block: number
}

export const MULTICALL3_ADDRESS = '0xcA11bde05977b3631167028862bE2a173976CA11'

const CANONICAL = MULTICALL3_ADDRESS

const MULTICALL3: Record<number, Multicall> = {
  1: { address: CANONICAL, block: 14353601 },
  3: { address: CANONICAL, block: 12063863 },
  4: { address: CANONICAL, block: 10299530 },
  5: { address: CANONICAL, block: 6507670 },
  10: { address: CANONICAL, block: 4286263 },
  14: { address: CANONICAL, block: 3002461 },
  16: { address: CANONICAL, block: 276388 },
  19: { address: CANONICAL, block: 13382504 },
  42: { address: CANONICAL, block: 30285908 },
  56: { address: CANONICAL, block: 15921452 },
  69: { address: CANONICAL, block: 1418387 },
  97: { address: CANONICAL, block: 17422483 },
  100: { address: CANONICAL, block: 21022491 },
  114: { address: CANONICAL, block: 508735 },
  137: { address: CANONICAL, block: 25770160 },
  196: { address: CANONICAL, block: 47416 },
  250: { address: CANONICAL, block: 33001987 },
  252: { address: CANONICAL, block: 0 },
  324: { address: '0x413fEb613604D46586c22801949A5b88b224c260', block: 9531414 },
  420: { address: CANONICAL, block: 49461 },
  1284: { address: CANONICAL, block: 609002 },
  1285: { address: CANONICAL, block: 1597904 },
  1287: { address: CANONICAL, block: 1850686 },
  2222: { address: '0x1578f6d2D3168acF41b506AA666A521994F6BAB6', block: 1176602 },
  4002: { address: CANONICAL, block: 8328688 },
  8453: { address: CANONICAL, block: 5022 },
  42161: { address: CANONICAL, block: 7654707 },
  42220: { address: CANONICAL, block: 13112599 },
  43113: { address: CANONICAL, block: 7096959 },
  43114: { address: CANONICAL, block: 11907934 },
  80001: { address: CANONICAL, block: 25444704 },
  421611: { address: CANONICAL, block: 10228837 },
  5000: { address: '0xd77b59d4cb13bea71f3cc093e401720867355d6e', block: 18877383 },
  1666600000: { address: CANONICAL, block: 24185753 },
  73927: { address: '0x138A85647768815078DF1dD85C6121e611381A0b', block: 14080843 },
  // Tron 主网 TEazPvZwDjDtFeJupyo7QunvnrnUjPH8ED（链上合约名 Multicall3，2026-10 实测）
  728126428: { address: '0x32a4f47a74a6810bd0bf861cabab99656a75de9e', block: 0 },
  81457: { address: '0x23928c6f823e0d78eadc9d2f69ace652ff3cdcb1', block: 368182 },
}

export function getMulticall3(chainId: number): Multicall | null {
  return MULTICALL3[chainId] ?? null
}
