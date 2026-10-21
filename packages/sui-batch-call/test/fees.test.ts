/**
 * 手续费估算：参考 gas 价格、模拟一笔交易的 gas 明细和 gas 上限（假节点，不连网络）
 */
import { describe, expect, it } from 'vitest'

import { SUI_COIN_TYPE, SuiClient, normalizeSuiAddress } from '../src/index.js'
import { GrpcError, type GrpcResponse, type GrpcTransport } from '../src/grpc.js'
import { ProtoMessage, ProtoWriter } from '../src/proto.js'
import { estimateCost, estimateFees } from '../src/subpaths/fees.js'
import { PtbBuilder, pure } from '../src/subpaths/write.js'

const OWNER = normalizeSuiAddress('0xa1')
const SPONSOR = normalizeSuiAddress('0xb2')
const D = '11111111111111111111111111111111'

/** 假节点：GetEpoch、GetServiceInfo、gas 币（ListOwnedObjects）、地址余额、模拟（结果由测试设定） */
class FakeSui implements GrpcTransport {
  readonly label = 'fake'
  readonly calls: Array<[string, ProtoMessage]> = []
  /** owner → SUI Coin 的余额 */
  coins = new Map<string, bigint[]>()
  gas = { computation: 750_000n, storage: 1_976_000n, rebate: 978_120n, nonRefundable: 9_880n }
  simulationError: string | null = null

  async unary(method: string, request: Uint8Array): Promise<GrpcResponse> {
    const name = method.split('/').pop() as string
    const req = ProtoMessage.decode(request)
    this.calls.push([name, req])
    const w = new ProtoWriter()
    switch (name) {
      case 'GetEpoch':
        w.message(1, new ProtoWriter().uint(1, 1043).uint(8, 500))
        break
      case 'GetServiceInfo':
        w.string(1, 'fake-chain').string(2, 'mainnet').uint(3, 1043).uint(4, 100)
        break
      case 'GetBalance':
        w.message(1, new ProtoWriter().string(1, req.string(2) as string).uint(3, 0).uint(4, 0).uint(5, 0))
        break
      case 'ListOwnedObjects':
        ;(this.coins.get(req.string(1) as string) ?? []).forEach((balance, i) => {
          w.message(1, new ProtoWriter().string(2, normalizeSuiAddress(`0x${(i + 100).toString(16)}`)).uint(3, 5).string(4, D).string(6, `0x2::coin::Coin<${SUI_COIN_TYPE}>`).uint(101, balance))
        })
        break
      case 'SimulateTransaction': {
        const status = this.simulationError ? new ProtoWriter().uint(1, 0).message(2, new ProtoWriter().string(1, this.simulationError)) : new ProtoWriter().uint(1, 1)
        const g = this.gas
        const gas = new ProtoWriter().uint(1, g.computation).uint(2, g.storage).uint(3, g.rebate).uint(4, g.nonRefundable)
        w.message(1, new ProtoWriter().message(4, new ProtoWriter().message(4, status).message(6, gas)))
        break
      }
      default:
        throw new GrpcError(12, `unimplemented ${method}`)
    }
    return { message: ProtoMessage.decode(w.finish()), checkpoint: 100, chain: 'mainnet' }
  }

  count(name: string) {
    return this.calls.filter(([n]) => n === name).length
  }
}

const transfer = () => {
  const ptb = new PtbBuilder()
  const split = ptb.command({ kind: 'splitCoins', coin: ptb.gas, amounts: [ptb.pure(pure.u64(1_000_000n))] })
  ptb.command({ kind: 'transferObjects', objects: [ptb.nested(split, 0)], address: ptb.pure(pure.address('0x5')) })
  return ptb.build()
}

describe('estimateFees', () => {
  it('当前 epoch 的参考 gas 价格（一次 GetEpoch）', async () => {
    const node = new FakeSui()
    expect(await estimateFees(new SuiClient(node))).toEqual({ epoch: '1043', referenceGasPrice: '500' })
    expect(node.calls.map(([n]) => n)).toEqual(['GetEpoch'])
  })
})

describe('estimateCost', () => {
  it('模拟一次：gas 明细、净花费 = 计算 + 存储 − 返还、gas 上限 = (计算 + 存储) × 1.2；不签名、不执行', async () => {
    const node = new FakeSui()
    node.coins.set(OWNER, [10n ** 9n])
    const cost = await estimateCost(new SuiClient(node), { from: '0xa1', kind: transfer() })
    expect(cost).toEqual({
      gasPrice: '500',
      computationCost: '750000',
      storageCost: '1976000',
      storageRebate: '978120',
      nonRefundableStorageFee: '9880',
      total: '1747880',
      totalFormatted: '0.00174788',
      gasBudget: '3271200',
      gasBudgetFormatted: '0.0032712',
      symbol: 'SUI',
    })
    expect(node.count('SimulateTransaction')).toBe(1)
    expect(node.count('ExecuteTransaction')).toBe(0)
  })

  it('gasPrice / gasMultiplier；上限不低于 0.002 SUI；返还多于花费时净花费为负', async () => {
    const node = new FakeSui()
    node.coins.set(OWNER, [10n ** 9n])
    node.gas = { computation: 100_000n, storage: 0n, rebate: 5_000_000n, nonRefundable: 50_000n }
    const cost = await estimateCost(new SuiClient(node), { from: OWNER, kind: transfer() }, { gasPrice: 1000n, gasMultiplier: 2 })
    expect(cost).toMatchObject({ gasPrice: '1000', total: '-4900000', totalFormatted: '-0.0049', gasBudget: '2000000' })
  })

  it('赞助交易：gas 币从付款地址选；gas 上限不超过可用的 SUI', async () => {
    const node = new FakeSui()
    node.coins.set(SPONSOR, [2_500_000n])
    node.gas = { computation: 1_000_000n, storage: 2_000_000n, rebate: 0n, nonRefundable: 0n }
    const cost = await estimateCost(new SuiClient(node), { from: OWNER, sponsor: SPONSOR, kind: { inputs: [], commands: [] } })
    expect(cost.gasBudget).toBe('2500000')
    const owners = node.calls.filter(([n]) => n === 'ListOwnedObjects').map(([, req]) => req.string(1))
    expect(owners).toEqual([SPONSOR])
  })

  it('模拟失败、付款地址没有 SUI 时抛出', async () => {
    const node = new FakeSui()
    await expect(estimateCost(new SuiClient(node), { from: OWNER, kind: transfer() })).rejects.toThrow(/does not have enough SUI to pay gas/)
    node.coins.set(OWNER, [10n ** 9n])
    node.simulationError = 'MoveAbort in 0x2::coin::split'
    await expect(estimateCost(new SuiClient(node), { from: OWNER, kind: transfer() })).rejects.toThrow(/simulation failed: MoveAbort/)
    await expect(estimateCost(new SuiClient(node), { from: 'bad', kind: transfer() })).rejects.toThrow(/Invalid Sui address/)
  })
})
