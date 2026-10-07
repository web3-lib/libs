// 内置公共节点表，手动维护；修改后用 `pnpm check:rpc` 检查可用性。
// 节点按优先级排序，要求能在浏览器里直连：放行跨域、支持 batch 请求、chainId 正确、不要求 API Key。

/** 各 EVM 链的公共 RPC 节点（按优先级排序） */
export const DEFAULT_RPC_URLS: Readonly<Record<number, readonly string[]>> = {
  // eth
  1: [
    'https://rpc.mevblocker.io',
    'https://eth.blockrazor.xyz',
    'https://ethereum-rpc.publicnode.com',
  ],
  // base
  8453: [
    'https://base-rpc.publicnode.com',
    'https://mainnet.base.org',
    'https://base.api.pocket.network',
  ],
  // bsc
  56: [
    'https://bsc.blockrazor.xyz',
    'https://bsc-dataseed1.bnbchain.org',
    'https://bsc-dataseed2.bnbchain.org',
    'https://bsc-dataseed.bnbchain.org',
    'https://bsc-dataseed3.bnbchain.org',
    'https://bsc-dataseed4.bnbchain.org',
    'https://bsc-rpc.publicnode.com',
    'https://bsc.publicnode.com',
  ],
  // arbitrum
  42161: [
    'https://arb1.arbitrum.io/rpc',
    'https://arbitrum-one-rpc.publicnode.com',
    'https://arb-one.api.pocket.network',
  ],
  // optimism
  10: [
    'https://mainnet.optimism.io',
    'https://op.api.pocket.network',
  ],
  // polygon
  137: [
    'https://polygon.drpc.org',
    'https://poly.api.pocket.network',
  ],
  // avax
  43114: [
    'https://api.avax.network/ext/bc/C/rpc',
    'https://avax.api.pocket.network',
  ],
  // scroll
  534352: [
    'https://rpc.scroll.io',
    'https://scroll-rpc.publicnode.com',
    'https://scroll.api.pocket.network',
  ],
  // linea
  59144: [
    'https://rpc.linea.build',
    'https://linea.api.pocket.network',
  ],
  // blast
  81457: [
    'https://rpc.blast.io',
    'https://blast.api.pocket.network',
  ],
  // zksync
  324: [
    'https://mainnet.era.zksync.io',
    'https://zksync-era.api.pocket.network',
  ],
  // mode
  34443: [
    'https://mainnet.mode.network',
  ],
  // mantle
  5000: [
    'https://rpc.mantle.xyz',
    'https://mantle.api.pocket.network',
  ],
  // xlayer
  196: [
    'https://rpc.xlayer.tech',
    'https://xlayerrpc.okx.com',
  ],
  // monad
  143: [
    'https://rpc.monad.xyz',
    'https://rpc2.monad.xyz',
    'https://rpc3.monad.xyz',
  ],
  // core
  1116: [
    'https://rpc.coredao.org',
    'https://rpc.ankr.com/core',
  ],
  // plasma
  9745: [
    'https://rpc.plasma.to',
  ],
  // morph
  2818: [
    'https://rpc-quicknode.morphl2.io',
    'https://rpc.morphl2.io',
  ],
  // hyperevm
  999: [
    'https://rpc.hyperliquid.xyz/evm',
    'https://rpc.hypurrscan.io',
  ],
  // eni
  173: [
    'https://rpc.eniac.network',
    'https://jp.enirpc.com',
    'https://rpc1.eniac.network',
    'https://rpc2.eniac.network',
    'https://jp.eniacrpc.net',
  ],
  // fsc
  201022: [
    'https://fsc-dataseed1.fonscan.io',
    'https://fsc-dataseed2.fonscan.io',
    'https://fsc-dataseed3.fonscan.io',
    'https://rpc.hieswap.com',
  ],
  // anubis
  6714: [
    'https://rpc.anubispace.org',
  ],
  // opbnb
  204: [
    'https://opbnb-mainnet-rpc.bnbchain.org',
    'https://opbnb-rpc.publicnode.com',
    'https://opbnb.api.pocket.network',
  ],
  // safe
  6666665: [
    'https://safe4.anwang.com/rpc',
  ],
  // berachain
  80094: [
    'https://rpc.berachain.com',
    'https://berachain-rpc.publicnode.com',
    'https://bera.api.pocket.network',
  ],
  // fusnchain
  8379: [
    'https://rpc.fusn.network',
  ],
  // ma
  20260131: [
    'https://rpc.ma-chain.xyz',
  ],
  // robinhood
  4663: [
    'https://rpc.mainnet.chain.robinhood.com',
    'https://robinhood.api.pocket.network',
  ],
  // mychain
  210400: [
    'https://rpc.mychain.my',
  ],
  // stable
  988: [
    'https://rpc.stable.xyz',
  ],
  // unichain
  130: [
    'https://unichain-rpc.publicnode.com',
    'https://mainnet.unichain.org',
  ],
  // botchain
  677: [
    'https://rpc.botchain.ai',
  ],
  // winchain
  86233268: [
    'https://rpc.winchain.win',
    'https://rpc2.winchain.win',
  ],
  // ink
  57073: [
    'https://rpc-gel.inkonchain.com',
    'https://rpc-qnd.inkonchain.com',
    'https://ink.api.pocket.network',
  ],
}

/** Tron 主网全节点 HTTP API（均支持跨域与 deployless） */
export const DEFAULT_TRON_HOSTS: readonly string[] = [
  'https://api.trongrid.io',
  'https://tron-rpc.publicnode.com',
  'https://api.tronstack.io',
  'https://tron-mainnet.token.im',
]
