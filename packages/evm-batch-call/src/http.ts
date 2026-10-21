/** HTTP 请求（代币列表、价格服务）：超时、状态码检查 */

const REQUEST_TIMEOUT = 20_000

export class HttpStatusError extends Error {
  constructor(
    readonly status: number,
    target: string,
  ) {
    super(`HTTP ${status} from ${target}`)
    this.name = 'HttpStatusError'
  }
}

/**
 * @param secret 请求里带的 Key：出错时错误信息只写域名，不写完整地址，避免 Key 出现在日志里
 */
export function fetchJson<T>(fetchFn: typeof fetch, url: string, init?: RequestInit, secret?: string): Promise<T> {
  return fetchFn(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT) }).then(async (res) => {
    if (!res.ok) {
      throw new HttpStatusError(res.status, secret ? safeHost(url) : url)
    }
    return (await res.json()) as T
  })
}

function safeHost(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return 'request'
  }
}

