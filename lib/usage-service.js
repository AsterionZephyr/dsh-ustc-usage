// 宿主查询学校网关的 /key/info、/user/info，解析预算窗口，带缓存与失败退避。
//
// 与上游（@ustc/tokenworks-usage/lib/usage-service.js）的**唯一区别**是凭据来源：
// 上游从 TokenWorks 私有的 tokenworksBootstrap 服务拿网关地址和 Key；
// 官方桌面版没有这个服务，所以这里换成插件自己的 Config
//   { baseUrl, apiKey | apiKeyEnv }
// （apiKeyEnv 从 DSH 凭据库 C:\Users\<you>\.dsh\.credentials.yaml 的 refs
//   段落里读，通常直接写 USTC_API_KEY —— 那就是 profile patch 里 llm-pi-ai
//   providers.ustc.apiKeyEnv 用的同一个名字）。
// 其余探测、缓存、singleflight、错误文案逻辑逐字照搬。

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { assembleUsage, parseKeyInfo, parseUserInfo, siteURLFrom } from './upstream.js'

/** 凭据库位置：DSH 把凭据 refs 存在这里（配置里 apiKeyEnv 指向的名字就是它的键）。 */
const CREDENTIALS_FILE = join(homedir(), '.dsh', '.credentials.yaml')
/**
 * 读凭据库 refs 段落里某个键的值。
 *
 * 只做**行读取**，不引 yaml 依赖：文件形状固定、且只是"取一个字符串"。
 * refs 段由扁平的 `  KEY: value` 行组成，读到下一个非缩进行即结束。
 */
export function readCredentialRef(name) {
  if (typeof name !== 'string' || name.trim() === '') return null
  let text
  try {
    text = readFileSync(CREDENTIALS_FILE, 'utf8')
  } catch {
    return null
  }
  const lines = text.split(/\r?\n/)
  let inRefs = false
  for (const line of lines) {
    if (/^refs:\s*$/.test(line)) {
      inRefs = true
      continue
    }
    if (!inRefs) continue
    if (line.trim() === '') continue
    // 顶层新段落（无缩进）结束 refs
    if (!/^\s/.test(line)) break
    const match = /^\s+([^:\s]+):\s*(.*)$/.exec(line)
    if (match === null) continue
    if (match[1] !== name.trim()) continue
    const value = match[2].trim().replace(/^["']|["']$/g, '')
    return value === '' ? null : value
  }
  return null
}

/** 成功结果的缓存时间。 */
const FRESH_MS = 30_000
/** 失败后的重试间隔。 */
const FAIL_BACKOFF_MS = 5_000
const REQUEST_TIMEOUT_MS = 15_000
const MAX_BODY_CHARS = 256 * 1024

const UNKNOWN_LIMITS = Object.freeze({
  rpm: { known: false, unlimited: false, value: null },
  parallel: { known: false, unlimited: false, value: null },
  tpm: { known: false, unlimited: false, value: null },
})

/** 将请求错误转换为界面语言。 */
function describeError(error, language) {
  const en = language === 'en'
  if (!(error instanceof Error)) return en ? 'Could not retrieve quota. Please try again.' : '暂时无法获取用量，请稍后重试'
  if (error.name === 'TimeoutError' || error.name === 'AbortError') {
    return en ? `The platform did not respond within ${REQUEST_TIMEOUT_MS / 1000} seconds` : `平台 ${REQUEST_TIMEOUT_MS / 1000} 秒内没有响应`
  }
  const status = /^HTTP (\d+)$/.exec(error.message)?.[1]
  if (status !== undefined) {
    if (status === '401' || status === '403') return en ? `The platform rejected this key (HTTP ${status}). Please sign in again.` : `平台拒绝了这个 Key（HTTP ${status}），请重新登录`
    if (status === '429') return en ? 'The platform is rate limiting requests. Please try again later (HTTP 429).' : '平台在限流，稍后再试（HTTP 429）'
    return en ? `The platform returned HTTP ${status}` : `平台返回 HTTP ${status}`
  }
  if (error.message === 'fetch failed') {
    return en ? 'Could not connect to the platform' : '无法连接平台'
  }
  if (error.message === '响应超过大小上限') return en ? 'The response exceeded the size limit' : error.message
  if (error.message === '平台返回的不是 JSON（可能被网关拦截）') return en ? 'The platform returned an invalid JSON response' : '平台返回的不是 JSON'
  if (error.message.startsWith('key/info:')) return en ? 'Could not read quota from the platform response' : '无法读取平台返回的用量数据'
  return en ? 'Could not retrieve quota. Please try again.' : '暂时无法获取用量，请稍后重试'
}

function requestLanguage(request) {
  try {
    return JSON.parse(request)?.language === 'en' ? 'en' : 'zh'
  } catch {
    return 'zh'
  }
}

const sameCredential = (a, b) => a?.site === b?.site && a?.key === b?.key

/**
 * @param {{ getCredential: () => any, log?: { warn?: (message: string) => void }, fetchImpl?: typeof fetch }} deps
 *   getCredential 返回当前的 { baseUrl, apiKey | apiKeyEnv }；每次查询都会重新读，
 *   以便配置热更新后立刻生效（patchReload: live 下改 profile 即生效）。
 */
export function createUsageService({ getCredential, log = {}, fetchImpl }) {
  const doFetch = fetchImpl ?? ((...args) => globalThis.fetch(...args))
  let cache = null // { probedAt, usage }
  let failure = null // { failedAt, error }
  let identity = null // { site, key }
  let generation = 0
  let inflight = null // { site, key, promise }
  let lastWarnings = ''

  const invalidate = () => {
    cache = null
    failure = null
    inflight = null
    generation += 1
  }

  /**
   * 配置就绪后返回站点与 Key。
   *
   * 凭据来源按 apiKey → apiKeyEnv → 网关同名环境变量的顺序取：
   * 这样 profile 里既可以直接写 key，也可以只写 `apiKeyEnv: USTC_API_KEY`
   * 而由 DSH 凭据库/进程环境提供实际值。
   */
  function credential() {
    const config = getCredential()
    if (config === null || config === undefined) return null
    const site = siteURLFrom(config.baseUrl)
    if (site === undefined) return null
    let value = typeof config.apiKey === 'string' ? config.apiKey.trim() : ''
    if (value === '') {
      const name = typeof config.apiKeyEnv === 'string' ? config.apiKeyEnv.trim() : ''
      if (name !== '') {
        const fromStore = readCredentialRef(name)
        if (fromStore !== null) value = fromStore.trim()
        else {
          const fromEnv = typeof process.env[name] === 'string' ? process.env[name].trim() : ''
          if (fromEnv !== '') value = fromEnv
        }
      }
    }
    return value === '' ? null : { site, key: value }
  }

  async function fetchJSON(url, key) {
    const response = await doFetch(url, {
      method: 'GET',
      // 认证方式与 bootstrap 下发的模型配置一致。
      headers: { accept: 'application/json', authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      cache: 'no-store',
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const text = await response.text()
    if (text.length > MAX_BODY_CHARS) throw new Error('响应超过大小上限')
    try {
      return JSON.parse(text)
    } catch {
      throw new Error('平台返回的不是 JSON（可能被网关拦截）')
    }
  }

  async function probe(credential_) {
    const [keyPayload, userPayload] = await Promise.all([
      fetchJSON(`${credential_.site}/key/info`, credential_.key),
      fetchJSON(`${credential_.site}/user/info`, credential_.key).catch(() => undefined),
    ])
    const keyInfo = parseKeyInfo(keyPayload)
    const userWindows = userPayload === undefined ? [] : parseUserInfo(userPayload)
    return assembleUsage(keyInfo, userWindows)
  }

  /** 合并同一站点、Key 与配置代次的并发请求。 */
  function probeOnce(credential_) {
    const current = inflight
    if (current !== null && current.site === credential_.site && current.key === credential_.key) return current.promise
    const promise = probe(credential_).finally(() => {
      if (inflight?.promise === promise) inflight = null
    })
    inflight = { site: credential_.site, key: credential_.key, promise }
    return promise
  }

  function reportWarnings(usage) {
    const joined = (usage.warnings ?? []).join('\n')
    if (joined === lastWarnings) return
    lastWarnings = joined
    if (joined !== '') log.warn?.(`ustc-usage: 上游用量口径异常：\n${joined}`)
  }

  function reportFailure(error, key) {
    const cause = error?.cause
    const detail = [
      error instanceof Error ? error.stack ?? error.message : String(error),
      cause?.code,
      cause instanceof Error ? cause.stack ?? cause.message : null,
    ].filter(Boolean).join('\n')
    log.warn?.(`ustc-usage: 用量查询失败：\n${detail.replaceAll(key, '[redacted]')}`)
  }

  function emptySnapshot(ready) {
    return {
      ready,
      state: 'idle',
      error: null,
      fetchedAt: null,
      alias: null,
      blocked: false,
      windows: [],
      limits: UNKNOWN_LIMITS,
    }
  }

  function errorSnapshot(message) {
    return { ...emptySnapshot(true), state: 'error', error: message }
  }

  function viewOf(usage, error) {
    return {
      ready: true,
      state: error !== null ? 'error' : 'ok',
      error,
      fetchedAt: new Date(cache?.probedAt ?? Date.now()).toISOString(),
      alias: usage.alias,
      blocked: usage.blocked,
      windows: usage.windows,
      limits: usage.limits,
    }
  }

  async function snapshotOnce(request, retried) {
    const language = requestLanguage(request)
    const current = credential()
    if (!sameCredential(current, identity)) {
      invalidate()
      identity = current
    }
    if (current === null) return emptySnapshot(false)

    const now = Date.now()
    const fresh = cache !== null && now - cache.probedAt < FRESH_MS
    const backingOff = failure !== null && now - failure.failedAt < FAIL_BACKOFF_MS
    if (backingOff || (fresh && failure === null)) {
      const message = failure === null ? null : describeError(failure.error, language)
      if (cache !== null) return viewOf(cache.usage, message)
      return errorSnapshot(message)
    }

    const startedGeneration = generation
    let outcome
    try {
      outcome = { ok: true, usage: await probeOnce(current) }
    } catch (error) {
      outcome = { ok: false, error }
    }
    // 成功与失败都须属于当前登录配置，才可写入缓存。
    const after = credential()
    if (after === null) {
      invalidate()
      identity = null
      return emptySnapshot(false)
    }
    if (generation !== startedGeneration || !sameCredential(after, current)) {
      if (retried) return errorSnapshot(language === 'en' ? 'Sign-in configuration changed. Please try again.' : '登录配置刚刚更新，请重试')
      return snapshotOnce(request, true)
    }
    if (!outcome.ok) {
      const message = describeError(outcome.error, language)
      if (failure?.error !== outcome.error) reportFailure(outcome.error, current.key)
      failure = { failedAt: Date.now(), error: outcome.error }
      if (cache !== null) return viewOf(cache.usage, message)
      return errorSnapshot(message)
    }
    cache = { probedAt: Date.now(), usage: outcome.usage }
    failure = null
    reportWarnings(outcome.usage)
    return viewOf(outcome.usage, null)
  }

  return {
    /** 当前网关用量快照；ready 表示登录配置是否就绪。 */
    snapshot: request => snapshotOnce(request, false),
    /** bootstrap 配置变化时清除缓存和在途请求引用。 */
    invalidate,
  }
}
