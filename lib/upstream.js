// LiteLLM 网关地址派生、预算窗口解析与合并。
//
// 本文件**逐字搬自** TokenWorks 发行版里的 @ustc/tokenworks-usage/lib/upstream.js
// （D:\Programs\TokenWorks\resources\product\d\node_modules\@ustc\tokenworks-usage\lib\upstream.js）。
// 都是纯函数、零依赖，所以整份原样保留：上游字段口径一变，通常只需要动这里。
// 有意**未做**本地化改写，改动请优先回上游修，再同步过来。

/** 宿主与 wire schema 共用的预算窗口数上限。 */
export const MAX_WINDOWS = 64

/**
 * 由网关地址派生管理端点的站点地址：去尾斜杠、剥离末尾的 /v1。
 * `https://api.llm.ustc.edu.cn/v1` → `https://api.llm.ustc.edu.cn`
 */
export function siteURLFrom(baseURL) {
  let url
  try {
    url = new URL(String(baseURL).trim())
  } catch {
    return undefined
  }
  let path = url.pathname.replace(/\/+$/, '')
  if (path === '/v1') path = ''
  else if (path.endsWith('/v1')) path = path.slice(0, -'/v1'.length)
  return `${url.origin}${path}`
}

// ── 限额 ──────────────────────────────────────────────────────────────

const UNKNOWN_LIMIT = Object.freeze({ known: false, unlimited: false, value: null })
const UNLIMITED_LIMIT = Object.freeze({ known: false, unlimited: true, value: null })

/** 解析一个上游限额字段：显式 null = 无限；缺失 / 0 / 负数 / 小数 = 未知。 */
export function parseLimit(raw) {
  if (raw === null) return UNLIMITED_LIMIT
  const value = asNumber(raw)
  if (value === null || !Number.isInteger(value) || value <= 0) return UNKNOWN_LIMIT
  return { known: true, unlimited: false, value }
}

// ── 预算窗口 ──────────────────────────────────────────────────────────

function asRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : undefined
}

/**
 * 读一个数值字段。上游（LiteLLM/Python）有把 Decimal 序列化成字符串的变体
 * （"26.1"），所以纯数字字符串按数字读。
 */
function asNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (trimmed === '') return null
  const parsed = Number(trimmed)
  return Number.isFinite(parsed) ? parsed : null
}

function asString(value) {
  return typeof value === 'string' && value !== '' ? value : null
}

/** 带时区的 ISO 时间，含纳秒和时区偏移写法。 */
const ZONED_ISO = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/i

function epochToISO(value) {
  // 口径：大于 1e12 当毫秒，否则当秒
  const ms = value > 1e12 ? value : value * 1000
  const date = new Date(ms)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

/**
 * 读一个时间字段并归一成 ISO。上游可能给 RFC3339（含纳秒、带偏移）或
 * epoch 秒/毫秒（数字或数字字符串）；时区字段保证各客户端解释为同一时刻。
 */
export function asTimestamp(raw) {
  if (typeof raw === 'number') return Number.isFinite(raw) && raw > 0 ? epochToISO(raw) : null
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (trimmed === '') return null
  if (ZONED_ISO.test(trimmed)) {
    const date = new Date(trimmed)
    return Number.isNaN(date.getTime()) ? null : date.toISOString()
  }
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    const value = Number(trimmed)
    if (Number.isFinite(value) && value > 0) return epochToISO(value)
  }
  return null
}

function windowOf(duration, limit, spend, resetAt, scope) {
  if (duration === null) return undefined
  const value = asNumber(limit)
  if (value === null || value <= 0) return undefined
  return {
    duration,
    limit: value,
    windowSpend: spend,
    usedKnown: spend !== null,
    // 负余额保留超支金额，供界面显示「超出」。
    remaining: spend === null ? null : value - spend,
    usedPercent: spend === null ? null : (spend / value) * 100,
    resetAt: asTimestamp(resetAt),
    scope,
  }
}

/**
 * 读某一档的窗口内用量。上游正常给 `{"current_spend": 2.01}`，
 * 也见过直接给数值/数字字符串的变体。
 * 缺失时返回 null，界面显示限额和重置时间。
 */
function windowSpendOf(usageByDuration, duration) {
  if (usageByDuration === undefined) return null
  const node = asRecord(usageByDuration[duration])
  if (node !== undefined && 'current_spend' in node) return asNumber(node.current_spend)
  return asNumber(usageByDuration[duration])
}

/**
 * 解析 GET {site}/key/info 的响应。
 * 形状无法识别时抛错。
 */
export function parseKeyInfo(payload) {
  const root = asRecord(payload)
  if (root === undefined) throw new Error('key/info: 响应不是 JSON 对象')
  // 兼容 info 节点缺失时字段在顶层的写法
  const info = asRecord(root.info) ?? root
  const spend = asNumber(info.spend)
  if (!('budget_limits' in info) && !('max_budget' in info) && spend === null) {
    throw new Error('key/info: 无法识别的响应形状')
  }

  const windows = []
  // 主窗口：顶层 max_budget + budget_duration，用量与 spend 同口径
  const mainWindow = windowOf(asString(info.budget_duration), info.max_budget, spend, info.budget_reset_at, 'key')
  if (mainWindow !== undefined) windows.push(mainWindow)

  // 各档用量来自 budget_limits_usage[duration]。
  const usageByDuration = asRecord(info.budget_limits_usage)
  const limitsList = Array.isArray(info.budget_limits) ? info.budget_limits : []
  for (const entry of limitsList) {
    const record = asRecord(entry)
    if (record === undefined) continue
    const duration = asString(record.budget_duration)
    if (duration === null) continue
    const windowSpend = windowSpendOf(usageByDuration, duration)
    const window = windowOf(duration, record.max_budget, windowSpend, record.reset_at, 'key')
    if (window !== undefined) windows.push(window)
  }

  return {
    alias: asString(info.key_alias),
    blocked: info.blocked !== null && info.blocked !== undefined && info.blocked !== false,
    windows,
    limits: {
      rpm: parseLimit(info.rpm_limit),
      parallel: parseLimit(info.max_parallel_requests),
      tpm: parseLimit(info.tpm_limit),
    },
  }
}

/**
 * 解析 GET {site}/user/info 的响应，取出用户级预算窗口。
 * 没有用户级窗口时返回空数组。
 */
export function parseUserInfo(payload) {
  const root = asRecord(payload)
  if (root === undefined) return []
  const info = asRecord(root.user_info) ?? root
  const window = windowOf(asString(info.budget_duration), info.max_budget, asNumber(info.spend), info.budget_reset_at, 'user')
  return window === undefined ? [] : [window]
}

// ── 合并 ──────────────────────────────────────────────────────────────

/** 上限一致判据：学校配置的额度是整齐数字，半分钱容差足够覆盖序列化差异。 */
const LIMIT_EPSILON = 0.005

/** duration 归一键：'24h' 与 '1d' 是同一档的两种写法；认不出来按原写法。 */
export function durationKey(duration) {
  const ms = durationMs(duration)
  return ms === null ? String(duration) : `ms:${ms}`
}

function maxKnownSpend(a, b) {
  if (a === null) return b
  if (b === null) return a
  return Math.max(a, b)
}

/** 同档且上限、重置时间相容时合并，取较小可用余额；单 Key 政策下用账户数据补缺。 */
export function mergeWindows(keyWindows, userWindows) {
  const warnings = []
  const windows = []
  for (const incoming of [...keyWindows, ...userWindows]) {
    const dkey = durationKey(incoming.duration)
    const index = windows.findIndex(window => durationKey(window.duration) === dkey
      && Math.abs(window.limit - incoming.limit) <= LIMIT_EPSILON
      && (window.resetAt === null || incoming.resetAt === null || window.resetAt === incoming.resetAt))
    if (index === -1) {
      const other = windows.find(window => window.scope !== incoming.scope && durationKey(window.duration) === dkey)
      if (other !== undefined) {
        const reason = Math.abs(other.limit - incoming.limit) > LIMIT_EPSILON
          ? `Key 上限 ${other.limit} 与账户上限 ${incoming.limit} 不一致`
          : 'Key 与账户重置时间不一致'
        warnings.push(`${incoming.duration} 档 ${reason}，已分列显示`)
      }
      windows.push(incoming)
      continue
    }
    const previous = windows[index]
    const spend = maxKnownSpend(previous.windowSpend, incoming.windowSpend)
    const limit = Math.min(previous.limit, incoming.limit)
    windows[index] = {
      ...previous,
      limit,
      windowSpend: spend,
      usedKnown: spend !== null,
      remaining: spend === null ? null : limit - spend,
      usedPercent: spend === null ? null : (spend / limit) * 100,
      resetAt: previous.resetAt ?? incoming.resetAt,
    }
  }
  windows.sort((a, b) => a.limit - b.limit)
  return { windows, warnings }
}

/** 约束档：剩余最少的已知窗口。任一档触顶即不可用，由它决定。 */
export function bindingWindow(windows) {
  let binding = null
  for (const window of windows) {
    if (!window.usedKnown || window.remaining === null) continue
    if (binding === null || window.remaining < (binding.remaining ?? 0)) binding = window
  }
  return binding
}

// ── 重置前的可达用量 ──────────────────────────────────────────────────

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS

/** 上游时长写法（LiteLLM 的 budget_duration）到毫秒。 */
const DURATION_UNITS = {
  s: 1_000,
  m: MINUTE_MS,
  h: HOUR_MS,
  d: DAY_MS,
  w: 7 * DAY_MS,
  mo: 30 * DAY_MS,
  y: 365 * DAY_MS,
}

/** '30m' / '3h' / '1d' / '1mo' → 毫秒；无法识别时返回 null。 */
export function durationMs(duration) {
  const match = /^(\d+(?:\.\d+)?)\s*(mo|[smhdwy])$/.exec(String(duration).trim().toLowerCase())
  if (match === null) return null
  const value = Number(match[1])
  if (!Number.isFinite(value) || value <= 0) return null
  const ms = value * DURATION_UNITS[match[2]]
  return Number.isFinite(ms) ? ms : null
}

function resetTimeMs(window) {
  if (window.resetAt === null) return null
  const ms = new Date(window.resetAt).getTime()
  return Number.isFinite(ms) ? ms : null
}

/**
 * 某一档重置前可用额度的上界，返回 { reachable, unreachable, limitedBy }。
 *
 * 各档扣的是同一份消费，所以窗口 i 重置前能花掉的总量 X 对每一档 j 都受限：
 * X ≤ j 眼下剩余 + j 这段时间里还会重置的次数 × j 的上限（重置即回满）。各档
 * 取最小值作为上界，差额是至少会作废的额度。缺少有效重置信息的档位跳过。
 */
export function windowReach(target, windows, now = Date.now()) {
  if (!target.usedKnown || target.remaining === null) return null
  const targetReset = resetTimeMs(target)
  if (targetReset === null) return null
  const untilReset = targetReset - now
  // 超支或重置时间已过时，作废金额为零。
  if (target.remaining <= 0 || untilReset <= 0) {
    return { reachable: target.remaining, unreachable: 0, limitedBy: null }
  }
  let reachable = target.remaining
  let limitedBy = null
  for (const other of windows) {
    const available = availableWithin(other, untilReset, now)
    if (available === null || available >= reachable) continue
    reachable = Math.max(0, available)
    limitedBy = other
  }
  return { reachable, unreachable: target.remaining - reachable, limitedBy }
}

/**
 * 某一档在接下来 untilReset 毫秒里可动用的额度：眼下剩余 + 期间重置回满的次数 × 上限。
 * 剩余未知时按上限估算。
 */
function availableWithin(window, untilReset, now) {
  const base = Math.max(0, window.remaining ?? window.limit)
  const reset = resetTimeMs(window)
  if (reset === null) return null
  const own = reset - now
  // 这段时间里不重置：能动的就是眼下这些
  if (own >= untilReset) return base
  // 重置时间已过，等待下一次查询更新。
  if (own <= 0) return null
  const period = durationMs(window.duration)
  if (period === null) return null
  // ceil 在周期整倍数时排除截止点的那次重置，计数区间为 [now, 目标重置时刻)。
  return base + Math.ceil((untilReset - own) / period) * window.limit
}

/** 组装探测结果，warnings 供宿主记录口径差异。 */
export function assembleUsage(keyInfo, userWindows) {
  const { windows: merged, warnings } = mergeWindows(keyInfo.windows, userWindows)
  const windows = merged.slice(0, MAX_WINDOWS)
  // 截断时保留当前约束档，摘要仍反映最小剩余额度。
  const binding = bindingWindow(merged)
  if (binding !== null && !windows.includes(binding)) {
    windows[MAX_WINDOWS - 1] = binding
    windows.sort((a, b) => a.limit - b.limit)
  }
  return {
    windows,
    limits: keyInfo.limits,
    alias: keyInfo.alias,
    blocked: keyInfo.blocked,
    warnings,
  }
}
