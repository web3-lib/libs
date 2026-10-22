/**
 * 公共 bundler（Pimlico 免费公共端点）：只读调用，默认跳过：`LIVE=1 npx vitest run test/smart-account-live.test.ts`
 */
import { Wallet } from 'ethers'
import { describe, expect, it } from 'vitest'

import { Provider } from '../src/index.js'
import { BundlerClient, ENTRY_POINT_V07, encodeExecuteBatch, getSimpleAccount, type UserOperation } from '../src/subpaths/smart-account.js'

const live = process.env.LIVE ? describe : describe.skip

live('公共 bundler（Base，只读）', { timeout: 60_000 }, () => {
  const bundler = new BundlerClient('https://public.pimlico.io/v2/8453/rpc')

  it('eth_supportedEntryPoints / eth_chainId', async () => {
    expect((await bundler.supportedEntryPoints()).map((a) => a.toLowerCase())).toContain(ENTRY_POINT_V07.toLowerCase())
    expect(await bundler.chainId()).toBe(8453)
  })

  it('eth_estimateUserOperationGas：未部署的账户（没有余额时 bundler 报 AA21 是预期的，说明请求格式被接受）', async () => {
    const provider = new Provider(8453, 'https://base-rpc.publicnode.com')
    const owner = Wallet.createRandom().address
    const account = await getSimpleAccount(provider, owner)
    const op: UserOperation = {
      sender: account.address,
      nonce: 0n,
      factory: '0x91E60e0613810449d098b0b5Ec8b51A0FE8c8985',
      factoryData: '0x5fbfb9cf' + owner.slice(2).padStart(64, '0') + '0'.repeat(64),
      callData: encodeExecuteBatch('0.7', [{ to: Wallet.createRandom().address, value: 0n, data: '0x' }]),
      callGasLimit: 0n,
      verificationGasLimit: 0n,
      preVerificationGas: 0n,
      maxFeePerGas: 10n ** 7n,
      maxPriorityFeePerGas: 10n ** 6n,
      signature: '0x',
    }
    const result = await bundler.estimateUserOperationGas(op, ENTRY_POINT_V07).then(
      (r) => r,
      (e: Error) => e,
    )
    if (result instanceof Error) {
      expect(result.message).toMatch(/AA21|AA31|prefund|didn't pay/i) // 签名长度 / 格式被接受，只是账户没钱
    } else {
      expect(result.verificationGasLimit).toBeGreaterThan(0n)
    }
  })
})
