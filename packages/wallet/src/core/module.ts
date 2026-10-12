/**
 * 从按需加载的 SDK 模块里取导出：先找命名导出，再找 default 上的（CommonJS 互操作时导出都在 default 上），
 * allowDefault 时最后用 default 本身（如 @tonconnect/sdk 的 default 就是 TonConnect 类）
 */
export function exportOf<T>(mod: unknown, name: string, allowDefault = false): T | undefined {
  // 应用直接返回了类本身（如 load: async () => (await import('@tonconnect/sdk')).default）
  if (allowDefault && typeof mod === 'function') return mod as T
  const ns = (mod ?? {}) as Record<string, unknown>
  const fallback = ns.default as Record<string, unknown> | undefined
  const found = ns[name] ?? (fallback && typeof fallback === 'object' ? fallback[name] : undefined) ?? (allowDefault ? fallback : undefined)
  return (found ?? undefined) as T | undefined
}
