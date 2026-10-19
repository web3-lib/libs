/**
 * Cell / BOC、消息、钱包、签名：期望值由 @ton/core 0.63 / @ton/ton 16.3 / @ton/crypto 3.3 生成
 * （助记词是随机生成的测试用，没有资产）
 */
import { describe, expect, it } from 'vitest'

import { toRawAddress } from '../src/address.js'
import { Cell, beginCell, bytesToHex } from '../src/write/cell.js'
import { commentCell, externalMessageCell, jettonTransferBody, normalizedMessageHash, outMessageCell, stateInitCell, type OutMessage } from '../src/write/message.js'
import { mnemonicToSeed, resolveTonSigner } from '../src/write/signer.js'
import { defaultWalletId, signedBody, walletAddress, walletInit, type WalletVersion } from '../src/write/wallet.js'

const FX = {
  "words": "evolve country host minor acid immense spike dry west music arrow dwarf dismiss ladder suggest train define odor insect vibrant shrimp lift uncover glove",
  "publicKey": "3c0f84b31b3f82dddc28b9cb6e45b4a77e3b576b9e41a881b36c1967651fe464",
  "secretKey": "279450260e2d682e6c2d45787187e88eb4ca2cb5ed7e1a66f7b5f642497b52b53c0f84b31b3f82dddc28b9cb6e45b4a77e3b576b9e41a881b36c1967651fe464",
  "v4": "0:443f5973d04c89f3bbf333a815ec39131da26fea7c305b95df0ec6c497e10708",
  "v5": "0:6f7ca042ac14485464d036ad44aac5f751539784bc177322ea89e6eb113b2b35",
  "v5testnet": "0:7d36c54bdf9a5121c90d8c255531fee3504321041aec7b0e14c2ecdefa7a4763",
  "comment": "9938391e3f6ec7d2b709648f56735097b347669927aa316a72af5e276b0a7d4e",
  "jettonBody": "te6cckEBAgEAYgABqA+KfqUAAAAAAAAABzEtaHgAR/UvMjHj/OBbciAX8IfQ+OAr2ZpzSOQ9NtdYLheAmccACP6l5kY8f5wLbkQC/hD6HxwFezNOaRyHptrrBcLwEzjCAwEAEgAAAABoZWxsb+ZD6EU=",
  "b4": "te6cckECBQEAAScAAp5OirIpjEIcQjehW4ZBJioKBeG+/eL8CGisU8rLgrIi41K1eZLIY4+pt8v8rGVjhDNUghbFPf+6reFmpIIUZ7QAKamjF2tJ0gAAAAAFAAMDAQIAckIAEf1LzIx4/zgW3IgF/CH0PjgK9mac0jkPTbXWC4XgJnGcxLQAAAAAAAAAAAAAAAAAAAAAAABoaQFoYgBYidTKWoElCzjPtInJlHW6ysthxRL6yBRYo39m4bEO/yAX14QAAAAAAAAAAAAAAAAAAQMBqA+KfqUAAAAAAAAABzEtaHgAR/UvMjHj/OBbciAX8IfQ+OAr2ZpzSOQ9NtdYLheAmccACP6l5kY8f5wLbkQC/hD6HxwFezNOaRyHptrrBcLwEzjCAwQAEgAAAABoZWxsbyZ5+gA=",
  "b5": "te6cckECCAEAATwAAaFzaWduf///EWtJ0gAAAAAFl58MAqQ+I/y7HKm9ImJ/n5b8+PKJkC/kQaU1XpmlRxEHeNZ4fjlTTZ6cjXnsbqcAgj4IxCZFj7JeZ+I0VgdTAKABAgoOw8htAwIFAgoOw8htAwMEAAAAckIAEf1LzIx4/zgW3IgF/CH0PjgK9mac0jkPTbXWC4XgJnGcxLQAAAAAAAAAAAAAAAAAAAAAAABoaQFoYgBYidTKWoElCzjPtInJlHW6ysthxRL6yBRYo39m4bEO/yAX14QAAAAAAAAAAAAAAAAAAQYBqA+KfqUAAAAAAAAABzEtaHgAR/UvMjHj/OBbciAX8IfQ+OAr2ZpzSOQ9NtdYLheAmccACP6l5kY8f5wLbkQC/hD6HxwFezNOaRyHptrrBcLwEzjCAwcAEgAAAABoZWxsb0e0GSw=",
  "b5all": "te6cckEBBAEAkQABoXNpZ25///8Ra0nSAAAAAAC7HbQkQXmSfOn8Iv6guBQQyF5JaOPJwCZyh6jVxokoZcztO40wD6+Z0RtsjidmNEHppNKovafIjtW9xpszLf4CoAECCg7DyG2CAgMAAABgQgAR/UvMjHj/OBbciAX8IfQ+OAr2ZpzSOQ9NtdYLheAmcYAAAAAAAAAAAAAAAAAA2vxViQ==",
  "ext4": "te6cckECBQEAAUoAAuOIAIh+suegmRPnd+ZnUCvYciY7RN/U+GC3K74djYkvwg4QAnRVkUxiEOIRvQrcMgkxUFAvDffvF+BDRWKeVlwVkRcalavMlkMcfU2+X+VjKxwhmqQQtinv/dVvCzUkEKM9oAFNTRi7Wk6QAAAAACgAGBwBAgByQgAR/UvMjHj/OBbciAX8IfQ+OAr2ZpzSOQ9NtdYLheAmcZzEtAAAAAAAAAAAAAAAAAAAAAAAAGhpAWhiAFiJ1MpagSULOM+0icmUdbrKy2HFEvrIFFijf2bhsQ7/IBfXhAAAAAAAAAAAAAAAAAABAwGoD4p+pQAAAAAAAAAHMS1oeABH9S8yMeP84FtyIBfwh9D44CvZmnNI5D0211guF4CZxwAI/qXmRjx/nAtuRAL+EPofHAV7M05pHIem2usFwvATOMIDBAASAAAAAGhlbGxvaMcOKg==",
  "ext5init": "te6cckECGQEAA2IAA+eIAN75QIVYKJCoyaBtWolVi+6ipy8JeC7mRdUTzdYidlZqEY5tLO3P///iLWk6QAAAAAAXY7aEiC8yT50/hF/UFwKCGQvJLRx5OATOUPUauNElDLmdp3GmAfXzOiNtkcTsxog9NJpVF7T5Edq3uNNmZb/AVAEVFgEU/wD0pBP0vPLICwICASADDgIBSAQFAtzQINdJwSCRW49jINcLHyCCEGV4dG69IYIQc2ludL2wkl8D4IIQZXh0brqOtIAg1yEB0HTXIfpAMPpE+Cj6RDBYvZFb4O1E0IEBQdch9AWDB/QOb6ExkTDhgEDXIXB/2zzgMSDXSYECgLmRMOBw4hEQAgEgBg0CASAHCgIBbggJABmtznaiaEAg65Drhf/AABmvHfaiaEAQ65DrhY/AAgFICwwAF7Ml+1E0HHXIdcLH4AARsmL7UTQ1woAgABm+Xw9qJoQICg65D6AsAQLyDwEeINcLH4IQc2lnbrry4Ip/EAHmjvDtou37IYMI1yICgwjXIyCAINch0x/TH9Mf7UTQ0gDTHyDTH9P/1woACvkBQMz5EJoolF8K2zHh8sCH3wKzUAew8tCEUSW68uCFUDa68uCG+CO78tCIIpL4AN4BpH/IygDLHwHPFsntVCCS+A/ecNs82BED9u2i7fsC9AQhbpJsIY5MAiHXOTBwlCHHALOOLQHXKCB2HkNsINdJwAjy4JMg10rAAvLgkyDXHQbHEsIAUjCw8tCJ10zXOTABpOhsEoQHu/Lgk9dKwADy4JPtVeLSAAHAAJFb4OvXLAgUIJFwlgHXLAgcEuJSELHjDyDXShITFACWAfpAAfpE+Cj6RDBYuvLgke1E0IEBQdcY9AUEnX/IygBABIMH9FPy4IuOFAODB/Rb8uCMItcKACFuAbOw8tCQ4shQA88WEvQAye1UAHIw1ywIJI4tIfLgktIA7UTQ0gBRE7ry0I9UUDCRMZwBgQFA1yHXCgDy4I7iyMoAWM8Wye1Uk/LAjeIAEJNb2zHh10zQAFGAAAAAP///iJ4HwlmNn8Fu7hRc5bci2lO/Hau1zyDUQNm2DLOyj/IyIAIKDsPIbYIXGAAAAGBCABH9S8yMeP84FtyIBfwh9D44CvZmnNI5D0211guF4CZxgAAAAAAAAAAAAAAAAABHycCI",
  "ext4init": "te6cckECGgEABEwABOWIAIh+suegmRPnd+ZnUCvYciY7RN/U+GC3K74djYkvwg4QEYnRVkUxiEOIRvQrcMgkxUFAvDffvF+BDRWKeVlwVkRcalavMlkMcfU2+X+VjKxwhmqQQtinv/dVvCzUkEKM9oAFNTRi7Wk6QAAAAACgAGBwARUWFwEU/wD0pBP0vPLICwICASADEAIBSAQHAubQAdDTAyFxsJJfBOAi10nBIJJfBOAC0x8hghBwbHVnvSKCEGRzdHK9sJJfBeAD+kAwIPpEAcjKB8v/ydDtRNCBAUDXIfQEMFyBAQj0Cm+hMbOSXwfgBdM/yCWCEHBsdWe6kjgw4w0DghBkc3RyupJfBuMNBQYAeAH6APQEMPgnbyIwUAqhIb7y4FCCEHBsdWeDHrFwgBhQBMsFJs8WWPoCGfQAy2kXyx9SYMs/IMmAQPsABgCKUASBAQj0WTDtRNCBAUDXIMgBzxb0AMntVAFysI4jghBkc3Rygx6xcIAYUAXLBVADzxYj+gITy2rLH8s/yYBA+wCSXwPiAgEgCA8CASAJDgIBWAoLAD2ynftRNCBAUDXIfQEMALIygfL/8nQAYEBCPQKb6ExgAgEgDA0AGa3OdqJoQCBrkOuF/8AAGa8d9qJoQBBrkOuFj8AAEbjJftRNDXCx+ABZvSQrb2omhAgKBrkPoCGEcNQICEekk30pkQzmkD6f+YN4EoAbeBAUiYcVnzGEBPjygwjXGCDTH9Mf0x8C+CO78mTtRNDTH9Mf0//0BNFRQ7ryoVFRuvKiBfkBVBBk+RDyo/gAJKTIyx9SQMsfUjDL/1IQ9ADJ7VT4DwHTByHAAJ9sUZMg10qW0wfUAvsA6DDgIcAB4wAhwALjAAHAA5Ew4w0DpMjLHxLLH8v/ERITFABu0gf6ANTUIvkABcjKBxXL/8nQd3SAGMjLBcsCIs8WUAX6AhTLaxLMzMlz+wDIQBSBAQj0UfKnAgBwgQEI1xj6ANM/yFQgR4EBCPRR8qeCEG5vdGVwdIAYyMsFywJQBs8WUAT6AhTLahLLH8s/yXP7AAIAbIEBCNcY+gDTPzBSJIEBCPRZ8qeCEGRzdHJwdIAYyMsFywJQBc8WUAP6AhPLassfEss/yXP7AAAK9ADJ7VQAUQAAAAApqaMXPA+Esxs/gt3cKLnLbkW0p347V2ueQaiBs2wZZ2Uf5GRAAHJCABH9S8yMeP84FtyIBfwh9D44CvZmnNI5D0211guF4CZxnMS0AAAAAAAAAAAAAAAAAAAAAAAAaGkBaGIAWInUylqBJQs4z7SJyZR1usrLYcUS+sgUWKN/ZuGxDv8gF9eEAAAAAAAAAAAAAAAAAAEYAagPin6lAAAAAAAAAAcxLWh4AEf1LzIx4/zgW3IgF/CH0PjgK9mac0jkPTbXWC4XgJnHAAj+peZGPH+cC25EAv4Q+h8cBXszTmkch6ba6wXC8BM4wgMZABIAAAAAaGVsbG9526k6"
} as const

const A = 'UQAj-peZGPH-cC25EAv4Q-h8cBXszTmkch6ba6wXC8BM40qt'
const J = 'EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs'
const T = 1800000000
const hex = (h: string) => Uint8Array.from(h.match(/../g) as string[], (x) => parseInt(x, 16))

const jettonBody = () =>
  jettonTransferBody({ queryId: 7n, amount: 1234567n, destination: A, responseDestination: A, forwardTonAmount: 1n, forwardPayload: commentCell('hello') })
const messages = (): OutMessage[] => [
  { to: A, value: 10_000_000n, bounce: false, body: commentCell('hi') },
  { to: J, value: 50_000_000n, bounce: true, body: jettonBody() },
]

async function signer() {
  const s = await resolveTonSigner(FX.words)
  if (s.kind !== 'key') throw new Error('expected a key signer')
  return s
}

describe('Cell / BOC', () => {
  it('BOC 往返：哈希不变，重新序列化逐字节相同', () => {
    for (const boc of [FX.b4, FX.b5, FX.ext5init, FX.ext4init, FX.jettonBody]) {
      const cell = Cell.fromBase64(boc)
      expect(cell.toBase64()).toBe(boc)
      expect(Cell.fromBoc(cell.toBoc()).equals(cell)).toBe(true)
    }
  })

  it('非整字节的位数、负数、Coins', () => {
    const c = beginCell().storeUint(5, 3).storeInt(-1, 8).storeCoins(0).storeCoins(1_000_000_000n).storeBit(1).endCell()
    const s = Cell.fromBoc(c.toBoc()).beginParse()
    expect([s.loadUint(3), s.loadInt(8), s.loadCoins(), s.loadCoins(), s.loadBit()]).toEqual([5n, -1n, 0n, 1_000_000_000n, true])
    expect(s.remainingBits).toBe(0)
    expect(() => beginCell().storeUint(256, 8)).toThrow(RangeError)
    expect(() => beginCell().storeInt(128, 8)).toThrow(RangeError)
  })

  it('坏的 BOC 报错', () => {
    const bytes = Cell.fromBase64(FX.b4).toBoc()
    bytes[bytes.length - 1] = (bytes[bytes.length - 1] as number) ^ 1
    expect(() => Cell.fromBoc(bytes)).toThrow(/CRC32C/)
    expect(() => Cell.fromBoc(new Uint8Array([1, 2, 3, 4, 5]))).toThrow()
  })
})

describe('消息', () => {
  it('文本备注（超过一个 Cell 时接在引用里）', () => {
    expect(bytesToHex(commentCell('x'.repeat(300) + 'é').hash())).toBe(FX.comment)
  })

  it('带 StateInit 的内部消息（部署合约）：StateInit 内联 / 放进引用的规则', () => {
    const FX2 = {"code": "te6cckEBAgEACgABCN6tvu8BAAIBay1Ydg==", "data": "te6cckEBAQEACgAAEAAAAAAAAAAqkC/G9A==", "small": "te6cckEBBAEAVAACd2IAEf1LzIx4/zgW3IgF/CH0PjgK9mac0jkPTbXWC4XgJnGIKAAAAAAAAAAAAAAAAAIwAAAAAZGVwbG95gEDAQjerb7vAgACAQAQAAAAAAAAACqle4KI", "bigBody": "te6cckEBAwEAbQACyAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAgAAAAGglem36w==", "big": "te6cckEBBwEAuAADY0IAEf1LzIx4/zgW3IgF/CH0PjgK9mac0jkPTbXWC4XgJnGIKAAAAAAAAAAAAAAAAAI2AQMEAQjerb7vAgACAQAQAAAAAAAAACoCyAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEFBgAAAAGgJVkjWA=="}
    const init = { code: Cell.fromBase64(FX2.code), data: Cell.fromBase64(FX2.data) }
    expect(outMessageCell({ to: A, value: 5n, bounce: true, init, body: commentCell('deploy') }).toBase64()).toBe(FX2.small)
    expect(outMessageCell({ to: A, value: 5n, bounce: false, init, body: Cell.fromBase64(FX2.bigBody) }).toBase64()).toBe(FX2.big)
    // 编码好的 StateInit Cell 原样使用
    expect(outMessageCell({ to: A, value: 5n, bounce: true, init: stateInitCell(init), body: commentCell('deploy') }).toBase64()).toBe(FX2.small)
  })

  it('Jetton 转账（TEP-74），forward_payload 放在引用里', () => {
    expect(jettonBody().toBase64()).toBe(FX.jettonBody)
  })
})

describe('钱包', () => {
  it('助记词 → 密钥、v4r2 / v5r1 地址（主网 / 测试网）', async () => {
    expect(bytesToHex(await mnemonicToSeed(FX.words))).toBe(FX.secretKey.slice(0, 64))
    const s = await signer()
    expect(bytesToHex(s.publicKey)).toBe(FX.publicKey)
    expect(toRawAddress(walletAddress('v4r2', s.publicKey, defaultWalletId('v4r2', 'mainnet')))).toBe(FX.v4)
    expect(toRawAddress(walletAddress('v5r1', s.publicKey, defaultWalletId('v5r1', 'mainnet')))).toBe(FX.v5)
    expect(toRawAddress(walletAddress('v5r1', s.publicKey, defaultWalletId('v5r1', 'testnet')))).toBe(FX.v5testnet)
  })

  it('同一个密钥的各种写法', async () => {
    for (const input of [FX.secretKey, `0x${FX.secretKey.slice(0, 64)}`, hex(FX.secretKey), hex(FX.secretKey).slice(0, 32), FX.words.toUpperCase().replace(/ /g, '  ')]) {
      const s = await resolveTonSigner(input)
      expect(s.kind === 'key' && bytesToHex(s.publicKey)).toBe(FX.publicKey)
    }
  })

  it('无效的助记词 / 私钥报错', async () => {
    const words = FX.words.split(' ')
    await expect(resolveTonSigner([...words.slice(0, 23), words[0]].join(' '))).rejects.toThrow(/mnemonic/)
    await expect(resolveTonSigner(words.slice(0, 12).join(' '))).rejects.toThrow(/24 words/)
    const bad = hex(FX.secretKey)
    bad[63] = (bad[63] as number) ^ 1
    await expect(resolveTonSigner(bad)).rejects.toThrow(/does not match/)
    await expect(resolveTonSigner('abcd')).rejects.toThrow()
  })

  it.each<[WalletVersion, string, number]>([
    ['v4r2', FX.b4, 3],
    ['v5r1', FX.b5, 1],
  ])('%s 签名的转账（两条消息，Ed25519 签名确定）', async (version, expected, mode) => {
    const s = await signer()
    const body = await signedBody(version, { walletId: defaultWalletId(version, 'mainnet'), seqno: 5, validUntil: T, messages: messages().map((message) => ({ message, mode })) }, s.sign)
    expect(body.toBase64()).toBe(expected)
  })

  it('外部消息（带 / 不带 StateInit）和规范化哈希', async () => {
    const s = await signer()
    const id4 = defaultWalletId('v4r2', 'mainnet')
    const body4 = Cell.fromBase64(FX.b4)
    expect(externalMessageCell(FX.v4, body4).toBase64()).toBe(FX.ext4)
    expect(externalMessageCell(FX.v4, body4, walletInit('v4r2', s.publicKey, id4)).toBase64()).toBe(FX.ext4init)
    const id5 = defaultWalletId('v5r1', 'mainnet')
    const all = await signedBody('v5r1', { walletId: id5, seqno: 0, validUntil: T, messages: [{ message: { to: A, value: 0n, bounce: false }, mode: 128 }] }, s.sign)
    expect(all.toBase64()).toBe(FX.b5all)
    const ext = externalMessageCell(FX.v5, all, walletInit('v5r1', s.publicKey, id5))
    expect(ext.toBase64()).toBe(FX.ext5init)
    // 规范化哈希与 StateInit 无关
    expect(bytesToHex(normalizedMessageHash(ext))).toBe(bytesToHex(normalizedMessageHash(externalMessageCell(FX.v5, all))))
  })
})
