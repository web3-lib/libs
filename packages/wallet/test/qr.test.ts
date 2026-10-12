import jsQRModule from 'jsqr'
import { describe, expect, it } from 'vitest'

import { qrMatrix, qrSvg } from '../src/ui/qr.js'

// jsqr 是 CommonJS：默认导入在运行时就是解码函数
const jsQR = jsQRModule as unknown as (data: Uint8ClampedArray, width: number, height: number) => { data: string } | null

/** 把矩阵画成 RGBA 图片（每格 scale 像素、四周 4 格空白），用 jsQR 解码 */
function decode(modules: boolean[][], scale = 4): string | null {
  const size = (modules.length + 8) * scale
  const pixels = new Uint8ClampedArray(size * size * 4).fill(255)
  modules.forEach((row, y) =>
    row.forEach((dark, x) => {
      if (!dark) return
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const offset = (((y + 4) * scale + dy) * size + (x + 4) * scale + dx) * 4
          pixels[offset] = pixels[offset + 1] = pixels[offset + 2] = 0
        }
      }
    }),
  )
  return jsQR(pixels, size, size)?.data ?? null
}

const text = (length: number) => Array.from({ length }, (_, i) => 'abcdefghijklmnopqrstuvwxyz0123456789:/?=&-_.'[(i * 7) % 44]).join('')

describe('二维码', () => {
  it.each([1, 14, 15, 30, 60, 100, 154, 200, 250, 330, 400, 500, 650, 800, 1000, 1300, 1700, 2331])('长度 %i：jsQR 能解码回原文', (length) => {
    const input = text(length)
    const modules = qrMatrix(input)
    expect(decode(modules, length > 1000 ? 3 : 4)).toBe(input)
  })

  it('WalletConnect 的连接链接、中文（UTF-8）都能解码', () => {
    const uri = 'wc:7f6e504bfad60b485450578e05678ed3e8e8c4751d3c6160be17160d63ec90f9@2?relay-protocol=irn&symKey=587d5484ce2a2a6ee3ba1962fdd7e8588e06200c46823bd18fbd67def96ad303&expiryTimestamp=1730000000&methods=wc_sessionAuthenticate'
    expect(decode(qrMatrix(uri))).toBe(uri)
    expect(decode(qrMatrix('连接钱包 ✓'))).toBe('连接钱包 ✓')
  })

  it('版本按长度选最小的；太长时抛错', () => {
    expect(qrMatrix('a')).toHaveLength(21) // 版本 1
    expect(qrMatrix(text(14))).toHaveLength(21) // 版本 1（M）最多 14 字节
    expect(qrMatrix(text(15))).toHaveLength(25)
    expect(() => qrMatrix(text(2332))).toThrow(RangeError)
  })

  it('SVG：带空白边，颜色跟随 currentColor', () => {
    const svg = qrSvg('a')
    expect(svg).toContain('viewBox="0 0 29 29"')
    expect(svg).toContain('fill="currentColor"')
  })
})
