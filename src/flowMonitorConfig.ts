export const FLOW_DEFAULT_MIN_USD = 30
export const FLOW_DEFAULT_MIN_APR = 300

/**
 * GitHub Actions 的 schedule 可能延迟。共享快照过期时允许浏览器补一次，
 * 但每轮只做缓存后的增量更新，不重复跑整套年化。
 */
export const FLOW_LIVE_REFRESH_COOLDOWN_MS = 5 * 60_000

/** 已有列表时只做增量刷新，超时更短；首次/手动完整刷新保留更宽裕上限。 */
export const FLOW_INCREMENTAL_REQUEST_TIMEOUT_MS = 40_000
export const FLOW_FULL_REQUEST_TIMEOUT_MS = 60_000

/** 新访客可先用稍旧快照秒开列表，再在后台补最近区块。 */
export const FLOW_SHARED_SEED_MAX_AGE_MS = 90 * 60_000

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
