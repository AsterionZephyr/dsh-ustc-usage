/**
 * dsh-ustc-usage —— 在 DSH 官方桌面版里显示中国科大学校网关的剩余用量。
 *
 * ## 这个插件解决什么
 *
 * TokenWorks（词元工坊，基于 DSH 改造的科大发行版）的账户弹窗里有一项「剩余用量」：
 * 3h/12h/24h 三档滚动额度的已用金额、进度条和重置倒计时，外加 RPM/并发/TPM 限额。
 * 数据来自学校网关（https://api.llm.ustc.edu.cn）的 LiteLLM 兼容接口
 * GET /key/info 与 GET /user/info。
 *
 * 官方桌面版没有 TokenWorks 那套私有的 tokenworksBootstrap 服务（也没有能插进
 * 账户弹窗的扩展点 —— 官方 AccountMenu 的菜单项是写死的字面量），所以：
 *
 *   - 凭据改由本插件自己的 Config 提供（baseUrl 加 apiKey / apiKeyEnv），
 *     不依赖 USTC OIDC 登录；
 *   - 界面落在「设置 → 剩余用量」这个 settings.section 里，而不是账户弹窗。
 *
 * ## 数据出口
 *
 * 官方 profile 的 node_modules 里没有 @deepseek-ai/dsh-typert-protocol
 * （@deepseek-ai 下只有 cosmokit 与 schemastery），所以宿主面不能用 Typert remote。
 * 这里改用官方 webServer 的 HTTP 路由，与正在运行的 dsh-free-search 同一条路：
 *
 *     GET /api/dsh-ustc-usage/snapshot   ->  { ok: true, value: <snapshot> }
 *
 * 客户端 lib/client.js 就按这个地址取数。
 *
 * ## 配置（写在 profile 的 patch 层）
 *
 *   - id: ustc-usage
 *     config:
 *       baseUrl: "https://api.llm.ustc.edu.cn/"
 *       apiKeyEnv: "USTC_API_KEY"   # 复用 DSH 凭据库里的同名字段
 *       # apiKey: "sk-..."          # 或直接写死
 *
 * 什么都没配时插件照常加载、界面显示「未配置」——绝不拖垮 DSH 启动。
 *
 * @module dsh-ustc-usage
 */

import z from '@deepseek-ai/schemastery'
import { createUsageService } from './usage-service.js'

export const name = 'ustc-usage'

// 只按需接入 webServer：写进 inject 会让插件在 webServer 缺席时整个不激活。
export const inject = []

export const Config = z.object({
  baseUrl: z.string().default('https://api.llm.ustc.edu.cn/'),
  apiKey: z.string().default(''),
  apiKeyEnv: z.string().default('USTC_API_KEY'),
})

const ROUTE_PREFIX = '/api/dsh-ustc-usage'

function isLoopbackRequest(request) {
  const address = request.socket && request.socket.remoteAddress
  if (address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1') return false
  const host = request.headers.host
  if (typeof host !== 'string') return false
  let hostUrl
  try {
    hostUrl = new URL('http://' + host)
  } catch {
    return false
  }
  if (hostUrl.hostname !== '127.0.0.1' && hostUrl.hostname !== 'localhost' && hostUrl.hostname !== '[::1]') return false
  if (request.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = request.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

function writeJson(res, status, body) {
  let payload
  try {
    payload = JSON.stringify(body)
  } catch {
    payload = JSON.stringify({ ok: false, error: { message: 'snapshot is not serializable' } })
    status = 500
  }
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
  })
  res.end(payload)
}

// 把 service.snapshot 的返回值包进 { ok, value }，与 Typert 的信封保持一致。
async function handleSnapshot(service, req, res) {
  if (!isLoopbackRequest(req)) {
    writeJson(res, 403, { ok: false, error: { message: 'loopback requests only' } })
    return
  }
  if (req.method !== 'GET') {
    writeJson(res, 405, { ok: false, error: { message: 'method not allowed: ' + (req.method || '') } })
    return
  }
  try {
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    const language = url.searchParams.get('language')
    const value = await service.snapshot(language === null ? undefined : { language })
    writeJson(res, 200, { ok: true, value })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    writeJson(res, 200, { ok: false, error: { message } })
  }
}

export function apply(ctx, config) {
  const service = createUsageService({
    getCredential: () => config || {},
    log: ctx.logger,
  })

  // 配置热更新（patchReload: live）时清掉缓存，下一次查询用新地址与新 Key。
  ctx.effect(() => ctx.on('internal/config-updated', () => service.invalidate()), 'ustc-usage: config changes')

  ctx.inject(['webServer'], (sctx) => {
    sctx.effect(() => {
      const dispose = sctx.webServer.register({
        kind: 'exact',
        path: ROUTE_PREFIX + '/snapshot',
        handler: (req, res) => handleSnapshot(service, req, res),
      })
      return () => {
        if (typeof dispose === 'function') dispose()
      }
    }, 'ustc-usage: snapshot route')
  })
}

export default apply
