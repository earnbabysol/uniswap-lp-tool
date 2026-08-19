export const FLOW_DEFAULT_MIN_USD = 30
export const FLOW_DEFAULT_MIN_APR = 300

/**
 * GitHub Actions 的 schedule 可能延迟。共享快照过期时允许浏览器补一次，
 * 但不要每 3 分钟反复重扫四条链。
 */
export const FLOW_LIVE_REFRESH_COOLDOWN_MS = 15 * 60_000

/** 浏览器实时补刷的硬上限；基础列表会在这个上限之前分批展示。 */
export const FLOW_LIVE_REQUEST_TIMEOUT_MS = 60_000

export function shouldThrottleAutomaticLiveRefresh(
  lastCompletedAt: number | null,
  now = Date.now(),
  cooldownMs = FLOW_LIVE_REFRESH_COOLDOWN_MS,
): boolean {
  if (lastCompletedAt == null || !Number.isFinite(lastCompletedAt)) return false
  if (!Number.isFinite(now) || !(cooldownMs > 0)) return false
  const age = now - lastCompletedAt
  return age >= 0 && age < cooldownMs
}
