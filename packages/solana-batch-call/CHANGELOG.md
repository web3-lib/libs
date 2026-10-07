# Changelog

## 0.1.0

首个版本：

- 批量余额（SOL / SPL Token / Token-2022），指定代币时用 ATA + `getMultipleAccounts`，免费节点可用；扫描模式统计全部代币账户
- 代币详情（字段可选），Metaplex 与 Token-2022 TokenMetadata 扩展
- NFT 元数据、持有人、某地址持有的全部 NFT
- JSON-RPC 自动合并、批量降级、429 重试，多节点故障切换，按创世区块哈希校验网络
- 支持 URL、web3.js Connection、自定义传输
