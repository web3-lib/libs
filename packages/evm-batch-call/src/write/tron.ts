/**
 * Tron 写操作的入口（按需加载：write/batch.ts 的 tronModule、/fees 的 estimateCost 动态 import 这个文件）。
 * 实现拆在 write/tron/ 下：
 * - codec.ts：protobuf 编码、签名与签名器解析
 * - rpc.ts：节点访问（TronRpc）与资源计费
 * - send.ts：发送与确认
 * - batch.ts：批量调用 / 转账 / 归集、手续费估算
 */
export { checkedSignature, encodeRawData, toTronWebTransaction, tronSignerAddress, type TronContract } from './tron/codec.js'
export { tronBatchCall, tronBatchCollect, tronBatchTransfer, tronEstimateCost, type TronCostEstimate } from './tron/batch.js'
