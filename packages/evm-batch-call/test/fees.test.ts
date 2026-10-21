/** 手续费建议：按 eth_feeHistory 算三档，不支持时按 eth_gasPrice（假节点，不连网络） */
import { describe, expect, it } from 'vitest'

import { Provider } from '../src/index.js'
import { estimateFees } from '../src/subpaths/fees.js'

const gwei = (n: number) => `0x${BigInt(Math.round(n * 1e9)).toString(16)}`

function fakeNode(handlers: Record<string, (params: unknown[]) => unknown>) {
  const calls: Array<[string, unknown[]]> = []
  return {
    calls,
    node: {
      call: async () => '0x',
      getBalance: async () => 0n,
      async send(method: string, params: unknown[]) {
        calls.push([method, params])
        const h = handlers[method]
        if (!h) throw new Error(`method ${method} not supported`)
        return h(params)
      },
    },
  }
}

describe('estimateFees', () => {
  it('EIP-1559：下一个区块的 baseFee × 2 + 各百分位优先费的中位数（空区块的 0 不算），三档不递减', async () => {
    const { node, calls } = fakeNode({
      eth_feeHistory: () => ({
        baseFeePerGas: [gwei(10), gwei(11), gwei(12), gwei(13)],
        reward: [
          [gwei(1), gwei(2), gwei(5)],
          ['0x0', '0x0', '0x0'],
          [gwei(1), gwei(3), gwei(4)],
        ],
      }),
    })
    const fees = await estimateFees(new Provider(1, node as never), { blocks: 3 })
    expect(calls[0]).toEqual(['eth_feeHistory', ['0x3', 'latest', [10, 50, 90]]])
    expect(fees).toEqual({
      type: 'eip1559',
      baseFee: String(13e9),
      slow: { maxFeePerGas: String(27e9), maxPriorityFeePerGas: String(1e9) },
      normal: { maxFeePerGas: String(29e9), maxPriorityFeePerGas: String(3e9) },
      fast: { maxFeePerGas: String(31e9), maxPriorityFeePerGas: String(5e9) },
    })
  })

  it('不支持 feeHistory 或 baseFee 为 0（如 BSC）：按 gasPrice，快档 1.2 倍', async () => {
    const zeroBase = fakeNode({ eth_feeHistory: () => ({ baseFeePerGas: ['0x0', '0x0'], reward: [['0x0', '0x0', '0x0']] }), eth_gasPrice: () => gwei(1) })
    const unsupported = fakeNode({ eth_gasPrice: () => gwei(1) })
    for (const { node } of [zeroBase, unsupported]) {
      expect(await estimateFees(new Provider(56, node as never))).toEqual({
        type: 'legacy',
        baseFee: null,
        slow: { gasPrice: String(1e9) },
        normal: { gasPrice: String(1e9) },
        fast: { gasPrice: String(1.2e9) },
      })
    }
  })
})
