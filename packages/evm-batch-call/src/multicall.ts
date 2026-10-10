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
  // Mantle：标准地址上的合约字节码与其他链不同，但 aggregate3 / getBlockNumber / getEthBalance 行为一致（2026-10 实测）；
  // ethcall 表里的 0xd77b…5d6e 调 aggregate3 会 revert
  5000: { address: CANONICAL, block: 304717 },
  1666600000: { address: CANONICAL, block: 24185753 },
  73927: { address: '0x138A85647768815078DF1dD85C6121e611381A0b', block: 14080843 },
  // Tron 主网 TEazPvZwDjDtFeJupyo7QunvnrnUjPH8ED（链上合约名 Multicall3，2026-10 实测）
  728126428: { address: '0x32a4f47a74a6810bd0bf861cabab99656a75de9e', block: 0 },
  // Blast：ethcall 表里的 0x2392…cdcb1 调 aggregate3 会 revert，标准地址可用（2026-10 实测）
  81457: { address: CANONICAL, block: 88189 },

  // ---- 2026-10 实测补充：标准地址上 aggregate3 可用、区块号与节点一致 ----
  // 部署区块查到的按实际填写；节点不提供历史状态（或忽略区块参数）查不到的，保守地填核实时的区块：
  // 更早的历史查询走 deployless，最新状态照常用合约
  25: { address: CANONICAL, block: 98990812 }, // Cronos，部署区块未查到
  106: { address: CANONICAL, block: 70377223 }, // Velas，部署区块未查到
  130: { address: CANONICAL, block: 60854543 }, // Unichain，部署区块未查到
  143: { address: CANONICAL, block: 9248132 }, // Monad
  204: { address: CANONICAL, block: 193943883 }, // opBNB，部署区块未查到
  288: { address: CANONICAL, block: 40299030 }, // Boba，部署区块未查到
  321: { address: CANONICAL, block: 56352410 }, // KCC，部署区块未查到
  592: { address: CANONICAL, block: 761794 }, // Astar
  988: { address: CANONICAL, block: 42479473 }, // Stable，部署区块未查到
  999: { address: CANONICAL, block: 48135400 }, // HyperEVM，部署区块未查到
  1116: { address: CANONICAL, block: 6988931 }, // Core
  2818: { address: CANONICAL, block: 3654913 }, // Morph
  4663: { address: CANONICAL, block: 84683398 }, // Robinhood Chain，部署区块未查到
  4689: { address: CANONICAL, block: 53225909 }, // IoTeX，部署区块未查到
  9745: { address: CANONICAL, block: 0 }, // Plasma，创世预置
  34443: { address: CANONICAL, block: 2465882 }, // Mode
  57073: { address: CANONICAL, block: 58104502 }, // Ink，部署区块未查到
  59144: { address: CANONICAL, block: 42 }, // Linea
  80094: { address: CANONICAL, block: 0 }, // Berachain，创世预置
  534352: { address: CANONICAL, block: 14 }, // Scroll
  86233268: { address: CANONICAL, block: 10854614 }, // Winchain，部署区块未查到
  // 以下两条链不支持 deployless（合约创建式 eth_call 返回空 / 格式不对），只能用 Multicall3；
  // 早于部署区块的历史查询会失败
  42262: { address: CANONICAL, block: 22380155 }, // Oasis Emerald，部署区块未查到
  1313161554: { address: CANONICAL, block: 62907816 }, // Aurora
}

export function getMulticall3(chainId: number): Multicall | null {
  return MULTICALL3[chainId] ?? null
}
