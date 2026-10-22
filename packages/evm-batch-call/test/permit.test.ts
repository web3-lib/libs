import { Interface, MaxUint256, TypedDataEncoder, Wallet } from 'ethers'
import { describe, expect, it } from 'vitest'

import { MULTICALL3_ADDRESS, Provider } from '../src/index.js'
import {
  MAX_UINT160,
  PERMIT2_ADDRESS,
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
} from '../src/subpaths/permit.js'
import { createMockProvider } from './mockProvider.js'

const TOKEN = '0x1000000000000000000000000000000000000001'
const BAD = '0x1000000000000000000000000000000000000002'
const DAI = '0x1000000000000000000000000000000000000003'
const NO_PERMIT = '0x1000000000000000000000000000000000000004'
const SPENDER = '0x5000000000000000000000000000000000000005'
const wallet = Wallet.createRandom()
const OWNER = wallet.address

const iface = new Interface([
  'function name() view returns (string)',
  'function version() view returns (string)',
  'function DOMAIN_SEPARATOR() view returns (bytes32)',
  'function nonces(address) view returns (uint256)',
  'function PERMIT_TYPEHASH() view returns (bytes32)',
  'function allowance(address owner, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)',
])

/** 按名字应答的假合约：值是返回值数组；没有的函数 revert */
function token(values: Record<string, unknown[]>) {
  return (callData: string) => {
    const fn = iface.parseTransaction({ data: callData })
    const v = fn && values[fn.name]
    return v ? { success: true, returnData: iface.encodeFunctionResult(fn.name, v) } : { success: false, returnData: '0x' }
  }
}

const domain = (verifyingContract: string, version = '1') => ({ name: 'Test', version, chainId: 1, verifyingContract })
const separator = (verifyingContract: string, version = '1') => TypedDataEncoder.hashDomain(domain(verifyingContract, version))

function setup() {
  const mock = createMockProvider({
    multicallAddresses: [MULTICALL3_ADDRESS],
    contracts: {
      [TOKEN]: token({ name: ['Test'], version: ['1'], DOMAIN_SEPARATOR: [separator(TOKEN)], nonces: [7n] }),
      // domain 对不上（实现里 domain 用了别的参数）
      [BAD]: token({ name: ['Test'], version: ['1'], DOMAIN_SEPARATOR: [separator(TOKEN)], nonces: [0n] }),
      // 没有 version()，靠 '2' 猜出（USDC 类）
      [DAI]: token({ name: ['Test'], DOMAIN_SEPARATOR: [separator(DAI, '2')], nonces: [3n], PERMIT_TYPEHASH: ['0xea2aa0a1be11a07ed86d755c93467f4f82362b452371d1ba94d1715123511acb'] }),
      [NO_PERMIT]: token({ name: ['Test'] }),
      [PERMIT2_ADDRESS]: token({ allowance: [0n, 0n, 4n] }),
    },
  })
  return new Provider(1, mock)
}

describe('detectPermit', () => {
  it('domain 和 DOMAIN_SEPARATOR 逐位一致才算支持；没有 nonces / domain 对不上都报原因', async () => {
    const p = setup()
    expect(await detectPermit(p, TOKEN)).toMatchObject({ kind: 'eip2612', domain: { name: 'Test', version: '1', chainId: 1 } })
    expect((await detectPermit(p, BAD)).kind).toBeNull()
    expect((await detectPermit(p, BAD)).reason).toMatch(/does not match/)
    expect((await detectPermit(p, NO_PERMIT)).reason).toMatch(/no nonces/)
  })

  it('没有 version() 时试 1 / 2；DAI 风格由 PERMIT_TYPEHASH 识别', async () => {
    const support = await detectPermit(setup(), DAI)
    expect(support.domain?.version).toBe('2')
    expect(support.kind).toBe('dai')
  })
})

describe('EIP-2612 permit', () => {
  it('精确额度、默认 30 分钟、读 owner 当前 nonce；签名本地可验证；calldata 可解码', async () => {
    const p = setup()
    const permit = await buildPermit(p, { token: TOKEN, owner: OWNER, spender: SPENDER, value: 123n })
    expect(permit.nonces).toEqual(['7'])
    expect(permit.deadline - Math.floor(Date.now() / 1000)).toBeGreaterThan(1700)
    expect(permit.deadline - Math.floor(Date.now() / 1000)).toBeLessThanOrEqual(1800)
    const signed = await signPermit(wallet, permit, { chainId: 1 })
    expect(verifyPermitSignature(permit, signed.signature)).toBe(true)
    expect(verifyPermitSignature(permit, await Wallet.createRandom().signTypedData(permit.typedData.domain, permit.typedData.types, permit.typedData.message))).toBe(false)
    const data = new Interface(['function permit(address,address,uint256,uint256,uint8,bytes32,bytes32)']).decodeFunctionData('permit', permitCalldata(signed))
    expect([data[0], data[1], data[2]]).toEqual([OWNER, SPENDER, 123n])
  })

  it('拒绝空白 / 无限额度 / 零 spender / 过长有效期 / 已过期；DAI 风格要显式允许无限', async () => {
    const p = setup()
    const base = { token: TOKEN, owner: OWNER, spender: SPENDER, value: 1n }
    await expect(buildPermit(p, { ...base, value: 0n })).rejects.toThrow(/blank/)
    await expect(buildPermit(p, { ...base, value: MaxUint256 })).rejects.toThrow(/unlimited/)
    await expect(buildPermit(p, { ...base, value: MaxUint256 }, { allowUnlimited: true })).resolves.toBeTruthy()
    await expect(buildPermit(p, { ...base, spender: '0x0000000000000000000000000000000000000000' })).rejects.toThrow(/zero address/)
    await expect(buildPermit(p, base, { deadline: 7 * 86_400 })).rejects.toThrow(/24 hours/)
    await expect(buildPermit(p, base, { deadlineAt: 100 })).rejects.toThrow(/future/)
    await expect(buildPermit(p, { ...base, token: BAD })).rejects.toThrow(/does not support permit/)
    await expect(buildPermit(p, { ...base, token: DAI })).rejects.toThrow(/DAI-style/)
    expect((await buildPermit(p, { ...base, token: DAI }, { allowUnlimited: true, deadline: 600 })).kind).toBe('dai')
  })

  it('签名前核对：签名者不是 owner、链不对、内容被替换、verifyingContract 被替换都拒绝，钱包不会被调用', async () => {
    const p = setup()
    const permit = await buildPermit(p, { token: TOKEN, owner: OWNER, spender: SPENDER, value: 5n })
    let signs = 0
    const spy = { getAddress: async () => OWNER, signTypedData: async () => (signs++, '0x') }
    await expect(signPermit({ ...spy, getAddress: async () => Wallet.createRandom().address }, permit)).rejects.toThrow(/not the owner/)
    await expect(signPermit(spy, permit, { chainId: 56 })).rejects.toThrow(/chain/)
    const evil = (patch: (m: Record<string, unknown>) => void) => {
      const message = { ...permit.typedData.message }
      patch(message)
      return { ...permit, typedData: { ...permit.typedData, message } }
    }
    await expect(signPermit(spy, evil((m) => (m.spender = Wallet.createRandom().address)))).rejects.toThrow(/spender/)
    await expect(signPermit(spy, evil((m) => (m.value = MaxUint256)))).rejects.toThrow(/amounts/)
    await expect(signPermit(spy, { ...permit, typedData: { ...permit.typedData, domain: { ...permit.typedData.domain, verifyingContract: BAD } } })).rejects.toThrow(/verifyingContract/)
    expect(signs).toBe(0)
    // 钱包返回了别人的签名
    await expect(signPermit({ getAddress: async () => OWNER, signTypedData: (d, t, m) => Wallet.createRandom().signTypedData(d, t, m) }, permit)).rejects.toThrow(/recover/)
  })
})

describe('Permit2', () => {
  it('PermitSingle / PermitBatch：读 Permit2 里的 nonce，精确额度，签名后能编码 permit() calldata', async () => {
    const p = setup()
    const single = await buildPermit2Single(p, { token: TOKEN, owner: OWNER, spender: SPENDER, amount: 1000n })
    expect(single.nonces).toEqual(['4'])
    expect(single.typedData.domain).toMatchObject({ name: 'Permit2', chainId: 1, verifyingContract: PERMIT2_ADDRESS })
    const signed = await signPermit(wallet, single)
    expect(verifyPermitSignature(single, signed.signature)).toBe(true)
    const iface2 = new Interface(['function permit(address owner, ((address token, uint160 amount, uint48 expiration, uint48 nonce) details, address spender, uint256 sigDeadline) permitSingle, bytes signature)'])
    const decoded = iface2.decodeFunctionData('permit', permit2Calldata(signed))
    expect(decoded[0]).toBe(OWNER)
    expect(decoded[1].details.amount).toBe(1000n)

    const batch = await buildPermit2Batch(p, { owner: OWNER, spender: SPENDER, items: [{ token: TOKEN, amount: 1n }, { token: DAI, amount: 2n }] })
    expect(verifyPermitSignature(batch, (await signPermit(wallet, batch)).signature)).toBe(true)
    await expect(buildPermit2Single(p, { token: TOKEN, owner: OWNER, spender: SPENDER, amount: MAX_UINT160 })).rejects.toThrow(/unlimited/)
    await expect(buildPermit2Single(p, { token: TOKEN, owner: OWNER, spender: SPENDER, amount: 0n })).rejects.toThrow(/blank/)
    // 摘要里是代币 A、typedData 里被换成代币 B：拒绝签名
    const swapped = { ...single, typedData: { ...single.typedData, message: { ...single.typedData.message, details: { ...single.typedData.message.details, token: SPENDER } } } }
    await expect(signPermit(wallet, swapped)).rejects.toThrow(/tokens are inconsistent/)
    await expect(buildPermit2Batch(p, { owner: OWNER, spender: SPENDER, items: [{ token: TOKEN, amount: 1n }, { token: TOKEN, amount: 1n }] })).rejects.toThrow(/duplicate/)
  })

  it('SignatureTransfer：随机 nonce、一次性；permitTransferFrom 的 calldata 不能超过签名的数量', async () => {
    const p = setup()
    const a = await buildPermit2Transfer(p, { token: TOKEN, owner: OWNER, spender: SPENDER, amount: 50n })
    const b = await buildPermit2Transfer(p, { token: TOKEN, owner: OWNER, spender: SPENDER, amount: 50n })
    expect(a.nonces[0]).not.toBe(b.nonces[0])
    const signed = await signPermit(wallet, a)
    expect(permitTransferFromCalldata(signed, SPENDER, 40n)).toMatch(/^0x/)
    expect(() => permitTransferFromCalldata(signed, SPENDER, 51n)).toThrow(/exceeds/)
    expect(() => permitCalldata(signed)).toThrow(/not a token permit/)
  })
})
