# dsh-ustc-usage — 剩余用量（USTC 学校网关）

在 **DSH 官方桌面版**里显示中国科大（USTC）大模型网关的滚动额度余额。
数据来自网关的 LiteLLM 兼容接口 `GET {site}/key/info` 与 `GET {site}/user/info`。

它只挂载在**一个**位置：**账户弹窗内部**（左下角账号 → 弹层），位于「设置」等菜单项**之上**。

> 历史：早期同时注册了 `settings.section`（设置页里的一个区块），后来按用户要求移除了，
> 现在整条链路只走账户弹窗。

## 安装

```bash
git clone https://github.com/AsterionZephyr/dsh-ustc-usage.git
```

然后把插件接进 DSH 的 profile（见下文「接入 profile 的四步」），重启 DSH 即可。
不需要构建：`lib/client.js` 已经是浏览器可直接加载的 CJS + `__ModuleLoader__` 包装，
`lib/index.js` 是宿主面 ESM。

## 它长什么样

点左下角账号弹出的菜单里，最上方多出一块：

```
剩余用量                        3h ¥27.23   刷新
  3h   ████████████████░░░░░░░   ¥27.23 / ¥30.00   1h35m后重置
  12h  ███████████████████░░░░   ¥58.92 / ¥70.00   4h35m后重置
  24h  █████████████░░░░░░░░░░   ¥34.26 / ¥100.00  4h35m后重置
  限额 RPM 20 · 并发 20 · TPM ∞
  Key SA2503*********4579
  更新于 19:24
────────────────────────────────
  设置
  意见反馈
  退出登录
```

- 进度条长度 = **剩余占比**，颜色随用量升高转黄（≥75%）、转红（≥90%）
- Key 只显示前 6 位 + 末 4 位，界面上永远不出现明文
- 数据 30 秒刷新一次；关掉菜单不占资源（宿主侧 30s 缓存）

## 原理

```
浏览器 (client.js)                 DSH 宿主 (index.js)            USTC 网关
   |                                  |                            |
   | GET /api/dsh-ustc-usage/snapshot |                            |
   |--------------------------------->|                            |
   |                                  | GET {site}/key/info        |
   |                                  |--------------------------->|
   |                                  | GET {site}/user/info       |
   |                                  |--------------------------->|
   | { ok, value: { windows, limits }}|                            |
   |<---------------------------------|                            |
```

- 宿主路由**只允许 loopback** 访问（并校验 `sec-fetch-site` 与 Origin），非本机请求一律 403
- Key 不出宿主进程：浏览器只拿到解析后的窗口与限额，永远拿不到凭据
- 取数层 30s 缓存 + 5s 失败退避 + 15s 超时，网关抖动不会把界面打崩
## 配置

网关地址与 Key **不写在本插件里**，放在 profile 层，升级插件不会覆盖：

```yaml
# ~/.dsh/profiles/desktop/cordis.patch.yml
- id: ustc-usage
  name: dsh-ustc-usage
  config:
    baseUrl: https://api.llm.ustc.edu.cn/
    apiKey: ""
    apiKeyEnv: USTC_API_KEY
```

Key 解析顺序：`config.apiKey` 非空则用它，否则用宿主 `readCredentialRef(config.apiKeyEnv)`
从 `~/.dsh/.credentials.yaml` 取。

## 接入 profile 的四步（缺一插件不加载）

1. `~/.dsh/profiles/desktop/package.json` 的 `dependencies`：
   `"dsh-ustc-usage": "link:<你克隆到的路径>/dsh-ustc-usage"`
2. 同文件 `dsh.profile.bundles` 数组里加入 `"dsh-ustc-usage"`
3. 同文件所在的 `node_modules` 下建 junction 指向本目录
4. `cordis.patch.yml` 加上述配置段

---

# ⚠️ 踩过的坑（改这个插件前必读）

## 1. 客户端 bundle 里的 React 与宿主的不是同一份副本 —— 不能用 Hook

`settings.launcher` 路径里的组件**调用任何 React Hook 都会抛 React error #321（Invalid hook call）**，
且该异常被 `SlotErrorBoundary` **静默吞掉**（只渲染成 `div[data-slot-error]`），
表现为「组件体跑了、effect 从不执行、DOM 毫无动静、界面无任何报错」——极难定位。

实测探针输出：

```
REACTOBJ hooks=function ver=18.3.1 internals=[__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED]
WRAPPER useEff THREW Minified React error #321
```

React 对象完整（版本相同、含 internals 键），但 **dispatcher 不共享**。

**结论：`AccountLauncherWithUsage` 必须是无 Hook 的纯函数组件，注入行必须用原生 DOM 手搓。**
（`settings.section` 里的 `UsageSection` 用 Hook 是**正常**的，不受此限。）

## 2. 官方 `AccountMenu` 不吃 `children`

官方账户菜单的 props 是写死的解构列表，`function AccountMenu({ subscribeSessionExpired, ..., t })`，
**没有 `children`**；其内部 `Menu` 调用也没传 `children`/footer。
把我们的行当 children 传进去会被**静默丢弃**。
→ 只能在菜单 DOM 出来后，往 `document.body` 下的
`div[role="menu"] > div[role="presentation"]` 里**手动插入 DOM 节点**。

## 3. 菜单项不是 viewport 的直接子节点（本次最后一处 BUG）

```
ensureMenuRow ENTER vp=DIV.viewport_4ub78_19
ensure PRE first=BUTTON childN=3 firstParent=DIV
ensure THREW Failed to execute 'insertBefore' on 'Node': The node before which the new node is to be inserted is not a child of this node.
```

`viewport.childNodes.length === 3` 但 `first.parentNode` 是另一个 `DIV`——
官方把 items 放进 viewport 内的**分组 div**。

<div style="color:red">**必须相对菜单项自己的父节点插入，不能相对 viewport**：</div>

```js
const first = viewport.querySelector('button[role="menuitem"]');
const parent = first !== null && first.parentNode !== null ? first.parentNode : viewport;
parent.insertBefore(row, first);
```

且**行存在性检查也必须用后代选择器** `viewport.querySelector("[data-dsh-ustc-usage]")`，
不能用 `:scope > [data-dsh-ustc-usage]`（行在嵌套分组里）。

因为整个 `menuTick` 包了 `catch {}` 以免影响官方菜单，这个异常最初**完全静默**。

## 4. 抢 single 槽要用「比官方更小」的 priority

`settings.launcher` 是 `single` 槽，`entriesOfSlot(key)[0]` 取**按 priority 升序排好的第一条**
（即 "lowest renders"）。官方注册时**没传 priority（=0）**，
所以本插件注册必须用 `priority: -1`。用正数会被官方的 0 压住，组件根本不渲染。

## 5. 删组件时要连带检查 `const CSS = [...]` 与注入器

用「从 `function windowRow(` 到 `function AccountLauncherWithUsage(`」这种大跨度切片删掉
`UsageSection` 时，会把夹在中间的 **`const CSS = [...]` 字面量与它的 `<style>` 注入器一起删掉**。
表现极具迷惑性：行还在、数据还对，但**完全没有样式**（浏览器默认字号），看起来像「字号被调乱了」。
删组件后务必确认 `src.includes('const CSS = [')` 仍为 true。

## 6. 替换代码时别把模块尾部删掉

用 `src.slice(src.indexOf('function X('))` 取「从该函数到文件末尾」再整段替换，
会顺手删掉后面的 `ctx.slots.inject(...)` 注册和模块尾
`exports.apply = apply; exports.inject = inject; return module.exports;`。
**定位语法错误用 `new vm.Script(src, { filename: 'client.js' })`** ——
`new Function(src)` 只报 `Unexpected token ')'` 不给行号，`vm.Script` 直接给行列。

## 7. 调试探针要画到页面上的 fixed banner 并**累积历史**

改 `document.title` 会被外壳覆盖；banner 若每次覆盖内容，
就只能看到最后一个写入者，看不到 `>> IMPL` / `ensure PRE` 这类一次性事件。
做法：`window.__dshuuLog` 数组保留最后 ~14 行，每 tick 重画全部。

## 8. 客户端 bundle 无需重启 DSH

`dsh-client-hmr` 每 500ms `statSync` 轮询 client bundle 的 `mtimeMs/ctimeMs/size`，
变化即 `ctx.clientModules.rebuilt(id)`。改完 `lib/client.js` **F5 即可**。

---

# 需要随 DSH 升级维护吗？

**需要，但不是每次升级都要改**——只有官方动到下列依赖点时才会失效。
本插件的宿主面（取数、路由、配置）几乎不受影响，脆弱点全部集中在
「往官方账户菜单的 DOM 里插一行」这段（`lib/client.js` 的菜单注入部分）。

| 依赖 | 脆弱度 | 失效表现 | 失效后怎么办 |
|---|---|---|---|
| 官方 `AccountMenu` 的**触发按钮判据**（`aria-haspopup="menu"` + `avatar`/`AccountMenu` 类 + `aria-expanded="true"`）| **高** | 那一行**不显示**（安全方向）| 按新的 trigger 特征改 `findAccountTrigger()` |
| 菜单 DOM 形状 `div[role="menu"] > div[role="presentation"]` 且含 `button[role="menuitem"]` | 中 | 同上，不显示 | 改 `findMenuViewport()` 的选择器 |
| 「菜单项带 `[class*="itemIcon"]`」这条形状判据 | 中 | 用错菜单的概率上升 | 改 `hasAccountMenuShape()` |
| `AccountMenu` 的 CSS 哈希前缀（如 `ET65mq_`）| **已规避** | —— | 代码里只当**加分项**用，前缀变了也不影响 |
| `settings.launcher` 槽名 + `priority: -1` | 低 | 整个组件不渲染 | 确认槽仍为 `single` 且官方仍用默认 priority 0 |
| 宿主路由 `GET /api/dsh-ustc-usage/snapshot` | 极低 | 取不到数（界面显示「获取失败」）| 基本不会坏，它是本插件自己注册的 |
| USTC 网关 `/key/info` + `/user/info` | 低 | 取不到数 | 网关是 LiteLLM 兼容接口，很少变 |
| profile 三处接线（`dependencies` / `bundles` / `cordis.patch.yml`）| 低 | 插件整个不加载 | 按上文「接入 profile 的三处」重做 |

## 设计上的两个安全网

1. **失败方向是安全的**：认不出来时 `findMenuViewport()` **返回 `null`**，那一行就是不显示，
   绝不会退化成「往任意菜单里塞」。所以官方改版最坏的结果是「功能没了」，不是「界面被污染」。
2. **本插件的异常不会影响宿主**：`menuTick()` 外层包了 `catch {}`，
   轮询也走 `tickGuarded()` 逐次 try/catch。

## 为什么这段技术债消不掉

官方账户弹窗**没有任何扩展点**：`AccountMenu` 的 props 是写死的解构列表、**不接受 `children`**，
其内部 `Menu` 调用也没传 `children`/`footer`；`settings.launcher` 是 `single` 槽，
`entriesOfSlot` 只取 priority 最小的一条 —— 而官方已经占了 priority 0，
所以本插件只能用 `priority: -1` **整个替换**成自己的包装组件，再去操作官方渲染出的 DOM。

> 如果官方哪天给账户菜单加了 footer 或插槽，这段注入代码可**整体删除**，
> 换成正当的 `ctx.slots.register` 即可。

---

# 目录

| 文件 | 作用 |
|---|---|
| `lib/index.js` | 宿主面：注册 `GET /api/dsh-ustc-usage/snapshot`（仅 loopback）|
| `lib/usage-service.js` | 取数：并行 `key/info` + `user/info`，30s 缓存、5s 失败退避、15s 超时 |
| `lib/upstream.js` | 纯函数：解析 LiteLLM 载荷、合并窗口、挑 binding window |
| `lib/client.js` | 客户端：账户弹窗 DOM 注入（已移除 `settings.section` 区块）|
| `cordis.patch.yml` | 本插件自带的 insert 层 |
| `.verify/` | 反编译出的官方包（asar 解包），仅作参考，可删 |

> 宿主面**不依赖** `@deepseek-ai/dsh-typert-protocol`——官方 desktop profile 的
> `node_modules/@deepseek-ai/` 下只有 `cosmokit` 与 `schemastery`，import 它会直接加载失败。
