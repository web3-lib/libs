/**
 * 最小的二维码生成器（字节模式、纠错等级 M、版本 1–40），用来显示 WalletConnect / TON Connect 的连接链接。
 * 算法参照 Nayuki 的 QR Code generator（MIT）。
 */

// 纠错等级 M：每块的纠错码字数、块数（下标为版本号）
const ECC_PER_BLOCK = [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28]
const NUM_BLOCKS = [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49]
/** 格式信息里纠错等级 M 的编码 */
const ECL_BITS = 0

const at = (array: readonly number[], index: number) => array[index] as number

function rawDataModules(version: number): number {
  let result = (16 * version + 128) * version + 64
  if (version >= 2) {
    const numAlign = Math.floor(version / 7) + 2
    result -= (25 * numAlign - 10) * numAlign - 55
    if (version >= 7) result -= 36
  }
  return result
}

const dataCodewords = (version: number) => Math.floor(rawDataModules(version) / 8) - at(ECC_PER_BLOCK, version) * at(NUM_BLOCKS, version)

// ---- Reed-Solomon（GF(2^8)，本原多项式 0x11D） ----

function gfMultiply(x: number, y: number): number {
  let z = 0
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d)
    z ^= ((y >>> i) & 1) * x
  }
  return z
}

function rsDivisor(degree: number): number[] {
  const result: number[] = new Array(degree - 1).fill(0)
  result.push(1)
  let root = 1
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < result.length; j++) {
      result[j] = gfMultiply(at(result, j), root)
      if (j + 1 < result.length) result[j] = at(result, j) ^ at(result, j + 1)
    }
    root = gfMultiply(root, 0x02)
  }
  return result
}

function rsRemainder(data: readonly number[], divisor: readonly number[]): number[] {
  const result: number[] = divisor.map(() => 0)
  for (const b of data) {
    const factor = b ^ (result.shift() as number)
    result.push(0)
    divisor.forEach((coef, i) => (result[i] = at(result, i) ^ gfMultiply(coef, factor)))
  }
  return result
}

/** 生成二维码：返回 size × size 的矩阵（true 为深色），不含四周的空白 */
export function qrMatrix(text: string): boolean[][] {
  const bytes = new TextEncoder().encode(text)

  // 选最小的版本
  let version = 1
  for (; ; version++) {
    if (version > 40) throw new RangeError('Text too long for a QR code')
    const countBits = version < 10 ? 8 : 16
    if (4 + countBits + bytes.length * 8 <= dataCodewords(version) * 8) break
  }
  const size = version * 4 + 17

  // ---- 数据码字：模式（0100 字节）+ 长度 + 数据 + 结束符 + 填充 ----
  const bits: number[] = []
  const append = (value: number, length: number) => {
    for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1)
  }
  append(0b0100, 4)
  append(bytes.length, version < 10 ? 8 : 16)
  bytes.forEach((b) => append(b, 8))
  const capacity = dataCodewords(version) * 8
  append(0, Math.min(4, capacity - bits.length))
  append(0, (8 - (bits.length % 8)) % 8)
  for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) append(pad, 8)
  const data: number[] = []
  for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((acc, bit) => (acc << 1) | bit, 0))

  // ---- 分块、加纠错码、交织 ----
  const numBlocks = at(NUM_BLOCKS, version)
  const blockEccLen = at(ECC_PER_BLOCK, version)
  const rawCodewords = Math.floor(rawDataModules(version) / 8)
  const numShortBlocks = numBlocks - (rawCodewords % numBlocks)
  const shortBlockLen = Math.floor(rawCodewords / numBlocks)
  const divisor = rsDivisor(blockEccLen)
  const blocks: number[][] = []
  for (let i = 0, k = 0; i < numBlocks; i++) {
    const block = data.slice(k, k + shortBlockLen - blockEccLen + (i < numShortBlocks ? 0 : 1))
    k += block.length
    const ecc = rsRemainder(block, divisor)
    if (i < numShortBlocks) block.push(0)
    blocks.push(block.concat(ecc))
  }
  const codewords: number[] = []
  for (let i = 0; i < (blocks[0] as number[]).length; i++) {
    blocks.forEach((block, j) => {
      if (i !== shortBlockLen - blockEccLen || j >= numShortBlocks) codewords.push(at(block, i))
    })
  }

  // ---- 画功能图形 ----
  const modules: boolean[][] = Array.from({ length: size }, () => new Array<boolean>(size).fill(false))
  const isFunction: boolean[][] = Array.from({ length: size }, () => new Array<boolean>(size).fill(false))
  const set = (x: number, y: number, dark: boolean) => {
    ;(modules[y] as boolean[])[x] = dark
    ;(isFunction[y] as boolean[])[x] = true
  }
  for (let i = 0; i < size; i++) {
    set(6, i, i % 2 === 0)
    set(i, 6, i % 2 === 0)
  }
  for (const [cx, cy] of [
    [3, 3],
    [size - 4, 3],
    [3, size - 4],
  ] as const) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const dist = Math.max(Math.abs(dx), Math.abs(dy))
        const x = cx + dx
        const y = cy + dy
        if (x >= 0 && x < size && y >= 0 && y < size) set(x, y, dist !== 2 && dist !== 4)
      }
    }
  }
  const align: number[] = []
  if (version > 1) {
    const numAlign = Math.floor(version / 7) + 2
    const step = Math.floor((version * 8 + numAlign * 3 + 5) / (numAlign * 4 - 4)) * 2
    align.push(6)
    for (let pos = size - 7; align.length < numAlign; pos -= step) align.splice(1, 0, pos)
  }
  const last = align.length - 1
  align.forEach((x, i) =>
    align.forEach((y, j) => {
      if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(x + dx, y + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1)
    }),
  )
  const drawFormat = (mask: number) => {
    const value = (ECL_BITS << 3) | mask
    let rem = value
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537)
    const format = ((value << 10) | rem) ^ 0x5412
    const bit = (i: number) => ((format >>> i) & 1) !== 0
    for (let i = 0; i <= 5; i++) set(8, i, bit(i))
    set(8, 7, bit(6))
    set(8, 8, bit(7))
    set(7, 8, bit(8))
    for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i))
    for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i))
    for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i))
    set(8, size - 8, true)
  }
  drawFormat(0)
  if (version >= 7) {
    let rem = version
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25)
    const info = (version << 12) | rem
    for (let i = 0; i < 18; i++) {
      const dark = ((info >>> i) & 1) !== 0
      const a = size - 11 + (i % 3)
      const b = Math.floor(i / 3)
      set(a, b, dark)
      set(b, a, dark)
    }
  }

  // ---- 放数据（之字形） ----
  let index = 0
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j
        const upward = ((right + 1) & 2) === 0
        const y = upward ? size - 1 - vert : vert
        if (!(isFunction[y] as boolean[])[x] && index < codewords.length * 8) {
          ;(modules[y] as boolean[])[x] = ((at(codewords, index >>> 3) >>> (7 - (index & 7))) & 1) !== 0
          index++
        }
      }
    }
  }

  // ---- 选掩码（罚分最低的） ----
  const applyMask = (mask: number) => {
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        let invert: boolean
        switch (mask) {
          case 0: invert = (x + y) % 2 === 0; break
          case 1: invert = y % 2 === 0; break
          case 2: invert = x % 3 === 0; break
          case 3: invert = (x + y) % 3 === 0; break
          case 4: invert = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break
          case 5: invert = ((x * y) % 2) + ((x * y) % 3) === 0; break
          case 6: invert = (((x * y) % 2) + ((x * y) % 3)) % 2 === 0; break
          default: invert = (((x + y) % 2) + ((x * y) % 3)) % 2 === 0
        }
        const row = modules[y] as boolean[]
        if (!(isFunction[y] as boolean[])[x] && invert) row[x] = !row[x]
      }
    }
  }
  let best = 0
  let bestScore = Infinity
  for (let mask = 0; mask < 8; mask++) {
    applyMask(mask)
    drawFormat(mask)
    const score = penalty(modules)
    if (score < bestScore) {
      best = mask
      bestScore = score
    }
    applyMask(mask) // 再异或一次即还原
  }
  applyMask(best)
  drawFormat(best)
  return modules
}

/** 罚分：连续同色、2×2 同色块、类似定位图形的序列、深浅比例 */
function penalty(modules: boolean[][]): number {
  const size = modules.length
  const get = (x: number, y: number) => (modules[y] as boolean[])[x] as boolean
  let result = 0

  const addHistory = (run: number, history: number[]) => {
    if (history[0] === 0) run += size // 左边的空白区算进第一段
    history.pop()
    history.unshift(run)
  }
  const countPatterns = (h: number[]) => {
    const n = at(h, 1)
    const core = n > 0 && h[2] === n && h[3] === n * 3 && h[4] === n && h[5] === n
    return (core && at(h, 0) >= n * 4 && at(h, 6) >= n ? 1 : 0) + (core && at(h, 6) >= n * 4 && at(h, 0) >= n ? 1 : 0)
  }
  const line = (read: (i: number) => boolean) => {
    let color = false
    let run = 0
    const history = [0, 0, 0, 0, 0, 0, 0]
    for (let i = 0; i < size; i++) {
      if (read(i) === color) {
        run++
        if (run === 5) result += 3
        else if (run > 5) result++
      } else {
        addHistory(run, history)
        if (!color) result += countPatterns(history) * 40
        color = read(i)
        run = 1
      }
    }
    if (color) {
      addHistory(run, history)
      run = 0
    }
    addHistory(run + size, history)
    result += countPatterns(history) * 40
  }
  for (let y = 0; y < size; y++) line((x) => get(x, y))
  for (let x = 0; x < size; x++) line((y) => get(x, y))

  let dark = 0
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (get(x, y)) dark++
      if (x < size - 1 && y < size - 1) {
        const c = get(x, y)
        if (c === get(x + 1, y) && c === get(x, y + 1) && c === get(x + 1, y + 1)) result += 3
      }
    }
  }
  const total = size * size
  result += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10
  return result
}

/** 生成二维码的 SVG（带 4 格空白边），颜色用 currentColor，跟随主题 */
export function qrSvg(text: string): string {
  const modules = qrMatrix(text)
  const size = modules.length + 8
  let path = ''
  modules.forEach((row, y) => row.forEach((dark, x) => dark && (path += `M${x + 4} ${y + 4}h1v1h-1z`)))
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges"><path fill="currentColor" d="${path}"/></svg>`
}
