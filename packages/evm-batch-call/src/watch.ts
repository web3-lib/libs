import type { BalanceToken, RawTokenBalance, TokenBalance } from './erc20.js'
import type { Provider } from './provider.js'
import { resolve, type GetBalancesOptions } from './shortcuts.js'

type AnyBalance = TokenBalance | RawTokenBalance

export interface WatchBalancesOptions<B extends AnyBalance = TokenBalance> extends Omit<GetBalancesOptions, 'signal' | 'minBlock' | 'blockTag'> {
  /** 轮询间隔（毫秒），默认 15000；多处订阅同一份数据时取最小的间隔 */
  interval?: number
  /** 第一次拿到结果、以及之后余额变化时调用；previous 是上一次通知的结果（第一次为 null） */
  onChange: (balances: B[], previous: B[] | null) => void
  /** 某次查询失败时调用（轮询继续） */
  onError?: (err: unknown) => void
}

interface Subscriber {
  tokens: readonly BalanceToken[]
  interval: number
  onChange: (balances: AnyBalance[], previous: AnyBalance[] | null) => void
  onError?: (err: unknown) => void
  last: AnyBalance[] | null
  signature: string | null
}

interface Watch {
  subscribers: Set<Subscriber>
  timer: ReturnType<typeof setTimeout> | null
  running: boolean
  /** 最近一次的结果（按规范化的代币 key），新订阅者可以立即拿到 */
  latest: Map<string, AnyBalance> | null
}

// 按 Provider 实例分组（快捷函数对相同节点参数复用同一个实例），组内按 “钱包 + 代币集合 + 选项” 共用一份轮询
const watches = new WeakMap<Provider, Map<string, Watch>>()

/** 调用订阅者的回调：出错不影响其他订阅者和轮询 */
function safely(fn: () => void): void {
  try {
    fn()
  } catch {
    // 订阅者自己的错误（如渲染出错）不归轮询处理
  }
}

/** 0x 地址不区分大小写，统一小写；Tron 的 T 开头地址区分大小写，原样保留 */
const normalize = (address: string) => (/^0x/i.test(address) ? address.toLowerCase() : address)

const tokenKey = (token: BalanceToken) => (typeof token === 'string' ? normalize(token) : `${normalize(token.address)}:${token.decimals ?? ''}`)

/**
 * 轮询余额，多处订阅同一个钱包的同一组代币时合并成一份轮询（代币顺序无关），只在余额变化时通知。返回取消订阅的函数；
 * 最后一个订阅者取消后停止轮询。节点参数与 getBalances 相同（相同参数复用同一个 Provider，才能共用轮询）。
 *
 * ```ts
 * const stop = watchBalances(user, [NATIVE_TOKEN, USDT], { chainId: 56, interval: 10_000, onChange: (list) => render(list) })
 * ```
 */
export function watchBalances(owner: string, tokens: readonly BalanceToken[], options: WatchBalancesOptions<RawTokenBalance> & { decimals: false }): () => void
export function watchBalances(owner: string, tokens: readonly BalanceToken[], options: WatchBalancesOptions): () => void
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- 实现签名需兼容两种 onChange 参数类型
export function watchBalances(owner: string, tokens: readonly BalanceToken[], options: WatchBalancesOptions<any>): () => void {
  const { interval = 15_000, onChange, onError, ...rest } = options
  const { provider, overrides, own } = resolve(rest, ['symbol', 'decimals', 'withBlock'])
  const balancesOptions = { ...overrides, ...own }
  const unique = [...new Map(tokens.map((token) => [tokenKey(token), token])).entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  const key = JSON.stringify([normalize(owner), unique.map(([k]) => k), balancesOptions])

  let group = watches.get(provider)
  if (!group) {
    group = new Map()
    watches.set(provider, group)
  }
  let watch = group.get(key)
  const isNew = !watch
  if (!watch) {
    watch = { subscribers: new Set(), timer: null, running: false, latest: null }
    group.set(key, watch)
  }
  const subscriber: Subscriber = { tokens, interval, onChange: onChange as Subscriber['onChange'], onError, last: null, signature: null }
  watch.subscribers.add(subscriber)

  const current = watch
  const groupRef = group
  const notify = (sub: Subscriber) => {
    if (!current.latest) {
      return
    }
    const list = sub.tokens.map((token) => {
      const item = current.latest?.get(tokenKey(token)) as AnyBalance
      return { ...item, token: typeof token === 'string' ? token : token.address }
    })
    const signature = JSON.stringify(list.map((b) => [b.balance, b.success]))
    if (signature === sub.signature) {
      return
    }
    const previous = sub.last
    sub.last = list
    sub.signature = signature
    safely(() => sub.onChange(list, previous))
  }
  const schedule = () => {
    if (!current.subscribers.size) {
      return
    }
    const wait = Math.min(...[...current.subscribers].map((sub) => sub.interval))
    current.timer = setTimeout(poll, wait)
  }
  const poll = async () => {
    current.timer = null
    if (current.running || !current.subscribers.size) {
      return
    }
    current.running = true
    try {
      const list = (await provider.balances(owner, unique.map(([, token]) => token), balancesOptions)) as AnyBalance[]
      current.latest = new Map(unique.map(([k], i) => [k, list[i] as AnyBalance]))
      current.subscribers.forEach(notify)
    } catch (err) {
      current.subscribers.forEach((sub) => safely(() => sub.onError?.(err)))
    } finally {
      current.running = false
      schedule()
    }
  }

  if (isNew) {
    void poll()
  } else {
    // 已有轮询：有结果就立即给新订阅者；新订阅者的间隔更短时重新计时
    queueMicrotask(() => current.subscribers.has(subscriber) && notify(subscriber))
    if (current.timer && interval < Math.min(...[...current.subscribers].filter((s) => s !== subscriber).map((s) => s.interval))) {
      clearTimeout(current.timer)
      schedule()
    }
  }

  return () => {
    current.subscribers.delete(subscriber)
    if (!current.subscribers.size) {
      if (current.timer) {
        clearTimeout(current.timer)
        current.timer = null
      }
      if (groupRef.get(key) === current) {
        groupRef.delete(key)
      }
    }
  }
}
