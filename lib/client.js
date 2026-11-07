window.__ModuleLoader__.load({
  id: "dsh-ustc-usage",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    // 唯一的依赖：宿主提供的 React。其余全是原生 DOM + fetch，所以没有构建步骤。
    let react = require("react");
    const React = react && react.createElement ? react : react && react.default ? react.default : react;

    // 官方 AccountMenu 不吃 children，所以我们的那一行要自己挂进它的菜单 portal：
    // 需要一个独立的 React 根。react-dom/client 拿不到就退回 createRoot 缺失模式，
    // 此时菜单里不会有我们那一行，但插件其余部分照常工作。
    let createRoot = null;
    try {
      const client = require("react-dom/client");
      createRoot = client && (client.createRoot || (client.default && client.default.createRoot));
    } catch {
      createRoot = null;
    }

    function apply(ctx) {
      // 账户菜单轮询间隔（毫秒）。声明放在最前：AccountLauncherWithUsageImpl 在渲染
      // 期间就会调用 observeLauncherRender()，此刻若常量仍处于 TDZ 会抛 ReferenceError。
      const MENU_POLL_MS = 400;


      if (!ctx || !ctx.slots) return;

      let remote = null;
      try {
        remote = ctx.remote && ctx.remote.ustcUsage ? ctx.remote.ustcUsage : null;
      } catch {
        remote = null;
      }

      const uiZh = () =>
        String(
          (typeof document !== "undefined" && document.documentElement.lang) ||
            (typeof navigator !== "undefined" && navigator.language) ||
            "zh",
        )
          .toLowerCase()
          .startsWith("zh");

      const TEXT = {
        zh: {
          title: "剩余用量",
          loading: "正在获取…",
          failed: "获取失败",
          connected: "已连接",
          blocked: "Key 已停用",
          noWindows: "平台没有返回预算窗口",
          unavailable: "暂时无法连接学校服务",
          notConfigured: "未配置网关地址与 Key",
          notConfiguredHint: "在 profile 的补丁层里给 ustc-usage 填 baseUrl 与 apiKey（或 apiKeyEnv）。",
          limit: "上限",
          resetSoon: "即将重置",
          reset: "重置时间",
          resetIn: "{time}后重置",
          spent: "超出",
          limits: "限额",
          rpm: "RPM",
          parallel: "并发",
          tpm: "TPM",
          unprovided: "未提供",
          unprovidedHint: "平台未提供这档的已用金额",
          fetchedAt: "更新于",
          neverFetched: "尚无数据",
          binding: "剩余金额最少的档位",
          keyScope: "Key",
          accountScope: "账户",
          deadTitle: "重置前最多可用 {reachable}{by}；其余 {unreachable} 重置时作废",
          deadBy: "（受 {duration} 档限制）",
          refresh: "刷新",
        },
        en: {
          title: "Remaining quota",
          loading: "Loading…",
          failed: "Failed",
          connected: "Connected",
          blocked: "Key disabled",
          noWindows: "The platform returned no budget windows",
          unavailable: "Campus service is unavailable",
          notConfigured: "Gateway URL and key are not configured",
          notConfiguredHint: "Set baseUrl and apiKey (or apiKeyEnv) for ustc-usage in the profile patch layer.",
          limit: "limit",
          resetSoon: "resetting soon",
          reset: "Resets at",
          resetIn: "resets in {time}",
          spent: "Over",
          limits: "Limits",
          rpm: "RPM",
          parallel: "parallel",
          tpm: "TPM",
          unprovided: "not provided",
          unprovidedHint: "The platform did not report in-window spend for this tier",
          fetchedAt: "Updated",
          neverFetched: "No data yet",
          binding: "Tier with the least remaining quota",
          keyScope: "key",
          accountScope: "account",
          deadTitle: "Up to {reachable} usable before reset{by}; the other {unreachable} expires at reset",
          deadBy: " (capped by the {duration} tier)",
          refresh: "Refresh",
        },
      };
      const text = () => TEXT[uiZh() ? "zh" : "en"];

      function fill(template, values) {
        return template.replace(/\{(\w+)\}/g, (match, key) => (key in values ? values[key] : match));
      }

      function formatReset(iso) {
        if (iso === null || iso === undefined) return null;
        const at = new Date(iso).getTime();
        if (!Number.isFinite(at)) return null;
        const ms = at - Date.now();
        if (ms <= 0) return text().resetSoon;
        const minutes = Math.floor(ms / 60000);
        if (minutes < 60) return minutes + "m";
        const hours = Math.floor(minutes / 60);
        if (hours < 48) {
          const rest = minutes % 60;
          return rest > 0 ? hours + "h" + rest + "m" : hours + "h";
        }
        return Math.floor(hours / 24) + "d";
      }


      function formatAmount(value) {
        return "\u00a5" + Number(value).toFixed(2);
      }

      function remainingText(remaining, limit) {
        const prefix = remaining < 0 ? text().spent + " " : "";
        return prefix + formatAmount(Math.abs(remaining)) + " / " + formatAmount(limit);
      }

      function limitText(limit) {
        if (limit && limit.unlimited === true) return "\u221e";
        if (limit && limit.known === true && typeof limit.value === "number") return String(limit.value);
        return "\u2014";
      }

      function formatFetchedAt(iso) {
        if (iso === null || iso === undefined) return null;
        const date = new Date(iso);
        if (Number.isNaN(date.getTime())) return null;
        const pad = (value) => String(value).padStart(2, "0");
        return pad(date.getHours()) + ":" + pad(date.getMinutes());
      }

      function usageColor(percent) {
        if (percent >= 90) return "var(--dsw-alias-state-error-primary, #d9534f)";
        if (percent >= 75) return "var(--dsw-alias-state-warning-primary, #d98a00)";
        return "var(--dsw-alias-brand-primary, #4d6bfe)";
      }

      const DURATION_UNITS = {
        s: 1000,
        m: 60000,
        h: 3600000,
        d: 86400000,
        w: 604800000,
        mo: 2592000000,
        y: 31536000000,
      };

      function durationMs(duration) {
        const match = /^(\d+(?:\.\d+)?)\s*(mo|[smhdwy])$/.exec(String(duration).trim().toLowerCase());
        if (match === null) return null;
        const value = Number(match[1]);
        if (!Number.isFinite(value) || value <= 0) return null;
        const ms = value * DURATION_UNITS[match[2]];
        return Number.isFinite(ms) ? ms : null;
      }

      function durationKey(duration) {
        const ms = durationMs(duration);
        return ms === null ? String(duration) : "ms:" + ms;
      }

      function resetTimeMs(item) {
        if (item.resetAt === null || item.resetAt === undefined) return null;
        const ms = new Date(item.resetAt).getTime();
        return Number.isFinite(ms) ? ms : null;
      }

      function availableWithin(item, untilReset, now) {
        const base = Math.max(0, item.remaining === null ? item.limit : item.remaining);
        const reset = resetTimeMs(item);
        if (reset === null) return null;
        const own = reset - now;
        if (own >= untilReset) return base;
        if (own <= 0) return null;
        const period = durationMs(item.duration);
        if (period === null) return null;
        return base + Math.ceil((untilReset - own) / period) * item.limit;
      }

      function windowReach(target, windows, now) {
        if (!target.usedKnown || target.remaining === null) return null;
        const targetReset = resetTimeMs(target);
        if (targetReset === null) return null;
        const untilReset = targetReset - now;
        if (target.remaining <= 0 || untilReset <= 0) {
          return { reachable: target.remaining, unreachable: 0, limitedBy: null };
        }
        let reachable = target.remaining;
        let limitedBy = null;
        for (const other of windows) {
          const available = availableWithin(other, untilReset, now);
          if (available === null || available >= reachable) continue;
          reachable = Math.max(0, available);
          limitedBy = other;
        }
        return { reachable, unreachable: target.remaining - reachable, limitedBy };
      }

      function bindingWindow(windows) {
        let binding = null;
        for (const item of windows) {
          if (!item.usedKnown || item.remaining === null) continue;
          if (binding === null || item.remaining < binding.remaining) binding = item;
        }
        return binding;
      }

      const DEAD_COLOR = "var(--dsw-alias-state-error-primary, #d9534f)";
      const DEAD_STRIPES = "repeating-linear-gradient(45deg, " + DEAD_COLOR + " 0 2px, transparent 2px 4px)";
      const DEAD_MIN_AMOUNT = 0.01;

      function deadReach(item, windows, now) {
        const reach = item.usedKnown === true ? windowReach(item, windows, now) : null;
        return reach !== null && reach.unreachable >= DEAD_MIN_AMOUNT ? reach : null;
      }



      function summaryText(view) {
        if (!view) return text().loading;
        if (view.configured === false) return text().notConfigured;
        const windows = Array.isArray(view.windows) ? view.windows : [];
        if (view.state === "error" && windows.length === 0) return text().failed;
        if (view.blocked === true) return text().blocked;
        if (windows.length === 0) return view.state === "ok" ? text().connected : text().loading;
        const binding = bindingWindow(windows) || windows[0];
        if (binding.usedKnown !== true || typeof binding.remaining !== "number") {
          return binding.duration + " " + text().limit + " " + formatAmount(binding.limit);
        }
        const prefix = binding.remaining < 0 ? text().spent + " " : "";
        return binding.duration + " " + prefix + formatAmount(Math.abs(binding.remaining));
      }

      const HTTP_SNAPSHOT = "/api/dsh-ustc-usage/snapshot";

      function unwrap(result) {
        if (result && result.ok === true) return result.value;
        const detail = result && result.error ? result.error : null;
        const message = detail && typeof detail.message === "string" ? detail.message : null;
        throw new Error(message === null ? text().unavailable : message);
      }

      async function fetchView(language) {
        if (remote && typeof remote.snapshot === "function") {
          try {
            return unwrap(await remote.snapshot(JSON.stringify({ language })));
          } catch (error) {
            if (typeof console !== "undefined" && console.debug) {
              console.debug("dsh-ustc-usage: remote snapshot failed, falling back to HTTP", error);
            }
          }
        }
        const response = await fetch(HTTP_SNAPSHOT, {
          method: "GET",
          headers: { accept: "application/json" },
          cache: "no-store",
        });
        if (!response.ok) throw new Error("HTTP " + response.status);
        // 宿主路由与 Typert remote 一样用 { ok, value } 信封——两条路都必须走 unwrap，
        // 否则组件拿到的是信封本身（没有 .windows），界面会一直显示「没有返回预算窗口」。
        return unwrap(await response.json());
      }

      // 官方若缺席或尚未注册，返回 null，让位给官方那份（槽的 fallback/官方条目）。
      // 菜单行样式。全部用 var(--dsw-alias-*) 并带默认值，宿主换主题/换版本都能降级。
      const CSS = [
        ".dshuu-labelBinding{color:var(--dsw-alias-brand-primary, #4d6bfe);font-weight:600}",
        ".dshuu-barLeft{display:block;flex:none;height:100%}",
        ".dshuu-amount{color:var(--dsw-alias-label-secondary, #6b6b6b);font-variant-numeric:tabular-nums;white-space:nowrap;flex:none}",
        ".dshuu-reset{color:var(--dsw-alias-label-tertiary, #8a8a8a);white-space:nowrap;flex:none;font-variant-numeric:tabular-nums}",
        ".dshuu-menuRow{border-top:1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.22));margin-top:6px;padding:10px 10px 8px;display:flex;flex-direction:column;gap:7px;cursor:default;font-size:13px;line-height:18px}",
        ".dshuu-menuRowHead{display:flex;align-items:center;gap:8px;font-size:14px;line-height:20px;color:var(--dsw-alias-label-primary, inherit)}",
        ".dshuu-menuRowTitle{font-weight:600;white-space:nowrap}",
        ".dshuu-menuRowSummary{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-tertiary, #8a8a8a);font-variant-numeric:tabular-nums}",
        ".dshuu-menuRowRefresh{border:0;background:transparent;color:var(--dsw-alias-brand-primary, #4d6bfe);font:inherit;font-size:12px;cursor:pointer;padding:0 2px}",
        ".dshuu-menuRowRefresh:disabled{opacity:.5;cursor:default}",
        ".dshuu-menuWin{display:flex;flex-direction:column;gap:2px}",
        ".dshuu-menuWinBar{display:flex;align-items:center;gap:8px}",
        ".dshuu-menuWinLabel{min-width:26px;flex:none;font-size:13px;line-height:18px;color:var(--dsw-alias-label-secondary, #6b6b6b)}",
        ".dshuu-menuWinMeta{display:flex;align-items:baseline;gap:8px;padding-left:34px;font-size:12px;line-height:17px}",
        ".dshuu-menuWinMeta .dshuu-amount{flex:none}",
        ".dshuu-menuWinMeta .dshuu-reset{margin-left:auto}",
        ".dshuu-menuBar{display:flex;flex:1;min-width:0;height:7px;border-radius:4px;background:var(--dsw-alias-fill-l2, rgba(127,127,127,.22));overflow:hidden}",
        ".dshuu-menuHost{display:block}",
        ".dshuu-limits,.dshuu-alias,.dshuu-fetched{color:var(--dsw-alias-label-tertiary, #8a8a8a);font-size:11px;line-height:15px;white-space:nowrap}",
        ".dshuu-alias{font-variant-numeric:tabular-nums}",
        ".dshuu-menuHint{color:var(--dsw-alias-label-tertiary, #8a8a8a);font-size:11px;line-height:15px}",
        ".dshuu-menuRow .dshuu-notice,.dshuu-menuRow .dshuu-muted{font-size:11px;line-height:15px}",
      ].join("");
      const CSS_TAG_ID = "dsh-ustc-usage/menu.css";
      if (typeof document !== "undefined" && document.querySelector('style[data-plugin-css="' + CSS_TAG_ID + '"]') === null) {
        const styleTag = document.createElement("style");
        styleTag.dataset.plugin = "dsh-ustc-usage";
        styleTag.dataset.pluginCss = CSS_TAG_ID;
        styleTag.textContent = CSS;
        document.head.appendChild(styleTag);
      }
      // 包装官方账户菜单：不给 settings.launcher 找一个"自己的替代品"，
      // 而是原样渲染官方组件本身，再用**纯 DOM** 在它弹出的菜单里插一行。
      //
      // ⚠️ 为什么不用 React 也不用自己的 createRoot：
      //   本插件的客户端 bundle 拿到的 React 与宿主渲染树用的 React 是**两份独立副本**
      //   （都是 18.3.1，但 dispatcher 不共享）。因此在本模块里调用任何 Hook 都会抛
      //   "Minified React error #321 Invalid hook call"，再被 SlotErrorBoundary 静默吞掉——
      //   表现为「组件跑了、effect 从不执行、DOM 毫无动静」。同理，createRoot 起第二个根
      //   也会落到那份没有 dispatcher 的副本上。故这一行**完全用原生 DOM 实现**。
      //
      // 定位方式：官方 Menu 用 portal:true，菜单落在 document.body 下，
      // 结构是 div[role="menu"] > div[role="presentation"]（菜单 viewport），
      // 菜单项是其中的 button[role="menuitem"]。把我们的行插在第一个菜单项之前，
      // 于是它显示在「设置」上方。
      function AccountLauncherWithUsage(props) {
        const h = React.createElement;
        let official = null;
        try {
          const entries = ctx.slots.entries("settings.launcher") || [];
          official = entries.find((entry) => ((entry.options && entry.options.priority) ?? 0) === 0) || null;
        } catch {
          official = null;
        }
        if (official === null || typeof official.component !== "function") return null;

        observeLauncherRender();

        let face = {};
        try {
          const injected = official.inject;
          if (injected === undefined) face = {};
          else if (typeof injected === "function") face = injected() ?? {};
          else face = injected;
        } catch {
          face = {};
        }

        const props2 = {};
        for (const key of Object.keys(face)) props2[key] = face[key];
        for (const key of Object.keys(props || {})) props2[key] = props[key];

        return h(official.component, props2);
      }

      // ── 菜单里那一行的「无 React」实现 ───────────────────────────────
      const MENU_HOST_ATTR = "data-dsh-ustc-usage";

      // ⚠️ 这些状态**必须挂在 window 上**，不能用模块级 let：
      //   dsh-client-hmr 热替换模块时不会卸载旧实例，旧实例的 interval 仍在跑。
      //   若守卫是模块级变量，每个版本各持一份且都是 true，结果是**每个版本都留一个
      //   500ms interval**，全都往同一个 portal 菜单里写行 —— 界面表现为两种样式来回闪。
      //   挂到 window 后所有版本共享同一个守卫：后加载的版本直接复用，不再叠加循环。
      const SHARED_KEY = "__dshUstcUsageMenu";
      function sharedState() {
        try {
          if (window[SHARED_KEY] === undefined || window[SHARED_KEY] === null) {
            window[SHARED_KEY] = { started: false, state: { kind: "idle", view: null, error: null }, busy: false, lastFetchAt: 0, tick: 0, observer: null };
          }
          return window[SHARED_KEY];
        } catch {
          return null;
        }
      }

      function observeLauncherRender() {
        const shared = sharedState();
        // 旧版本留下的 interval：能停就停掉（同一个 tick 函数只留最新的那份）。
        try {
          if (shared !== null && typeof shared.timer === "number" && typeof window.clearInterval === "function") {
            if (shared.owner !== tickOwnerId) {
              window.clearInterval(shared.timer);
              shared.timer = undefined;
              shared.started = false;
            }
          }
        } catch {
          /* ignore */
        }
        if (shared !== null) {
          if (shared.started) return;
          shared.started = true;
          shared.owner = tickOwnerId;
        }
        try {
          // 纯轮询：MENU_POLL_MS 决定「点开账户 → 行出现」的最坏延迟。
          const timer = window.setInterval(tickGuarded, MENU_POLL_MS);
          if (shared !== null) shared.timer = timer;
          tickGuarded();
        } catch {
          if (shared !== null) shared.started = false;
        }
      }

      // ⚠️ 这里曾两次导致**整页卡死**（用户被迫重启 DSH），教训必须留住：
      //   曾用 MutationObserver 监听 document.body 来「零延迟」发现账户菜单弹出。
      //   但 menuTick 自己会写 DOM（setAttribute("data-tick") / textContent），
      //   于是 observer 被自己的写入再次触发 → 再 tick → 无限微任务链，
      //   浏览器**永远轮不到绘制**，主线程饿死，表现为「点账户后整个页面无响应」。
      //   `selfWriting` 闸门**挡不住**：MutationObserver 的回调是在微任务里派发的，
      //   那时同步写入早已结束、selfWriting 已复位为 false，闸门是开的。
      //
      // 结论：**不要监听自己会写的子树**。改为纯轮询 —— 轮询不会自我触发，
      // 结构上不可能形成反馈环。代价是「点开账户 → 看到用量」最多晚一个间隔。

      // 轮询里的每一次 tick 都单独 try/catch：本插件的任何异常都不许影响宿主。
      function tickGuarded() {
        if (!isOwner()) return;
        try {
          menuTick();
        } catch {
          /* 绝不因为本插件的异常影响宿主 */
        }
      }

      // 让当前属主把 DOM 里残留的旧行重画一遍（旧实例会被 isOwner() 挡掉）。
      function adoptLiveRow() {
        if (!isOwner()) return;
        tickGuarded();
      }

      // 本次模块实例的身份：用来判断 window 上的守卫是不是「自己」的。
      const tickOwnerId = (function () {
        try {
          return SHARED_KEY + ":" + Math.random().toString(36).slice(2);
        } catch {
          return SHARED_KEY;
        }
      })();
      // 记录本实例创建的 interval，便于被后续版本清理。
      function rememberTimer(timer) {
        const shared = sharedState();
        if (shared !== null) {
          shared.timer = timer;
          shared.owner = tickOwnerId;
        }
      }

      function getMenuState() {
        const shared = sharedState();
        return shared === null ? { kind: "idle", view: null, error: null } : shared.state;
      }
      function setMenuState(next) {
        const shared = sharedState();
        if (shared !== null) shared.state = next;
      }
      function getLastStrayScanAt() {
        const shared = sharedState();
        return shared === null ? 0 : (shared.lastStrayScanAt || 0);
      }
      function setLastStrayScanAt(value) {
        const shared = sharedState();
        if (shared !== null) shared.lastStrayScanAt = value;
      }
      function getFetchBusy() {
        const shared = sharedState();
        return shared === null ? false : shared.busy;
      }
      function setFetchBusy(v) {
        const shared = sharedState();
        if (shared !== null) shared.busy = v;
      }
      function getLastFetchAt() {
        const shared = sharedState();
        return shared === null ? 0 : shared.lastFetchAt;
      }
      function setLastFetchAt(v) {
        const shared = sharedState();
        if (shared !== null) shared.lastFetchAt = v;
      }

      // 判断一个 div[role="menu"] 是不是**账户弹窗**（而不是语言下拉、模型选择等
      // 任何别的官方 Menu）。官方所有 Menu 都用同一套原语渲染，DOM 结构同构：
      //   div[role="menu"] > div[role="presentation"].viewport > div.itemWrap > button[role="menuitem"]
      // 所以「有 menuitem」这一条完全不具区分度 —— 之前正是因此把用量行塞进了语言下拉。
      //
      // 账户菜单独有的特征（逐字来自 .verify/asar/dsh-client-ui-settings-account.js）：
      //   · items 固定为 settings / contact / signout|signin 四项以内的这个集合；
      //   · 其中「设置」项带 shortcut（Ctrl+,）→ DOM 里该按钮有 aria-keyshortcuts；
      //   · 每项都带 icon → DOM 里每条 itemWrap 内都有 span.itemIcon（语言下拉是纯文本，没有）；
      //   · className 传的是 AccountMenu 的 hash 类（ET65mq_anchor，跨版本会变，只当加分项）。
      // 判据采用「有图标 + 有快捷键」，两者都是语言下拉不具备的。
      // ⚠️ 这里必须**严格**：官方所有下拉都走同一套 Menu 原语，DOM 完全同构。
      //   曾经只用「菜单项带图标」判别，结果右上角会话头部的「…」菜单
      //   （下载 Session 日志 / 反馈，两项都带图标）被误判成账户菜单，
      //   用量行就长到了那个菜单里（用户 m02054）。
      //
      // 账户菜单有一个**唯一且稳定**的指纹：官方给「设置」项绑了 Ctrl+, 快捷键，
      // 于是那一项带 `aria-keyshortcuts`。其它任何菜单都没有这个属性。
      // 因此把它从「加分项」提升为**必要条件**。
      // ⚠️ 判定必须靠锚点关系，不能靠菜单内容（图标数量 / 快捷键）。
      //    踩坑史（三次误报，每次都是「行长进了别的菜单」）：
      //      · 只判 div[role=menu] 且含 menuitem  → 语言下拉中招（m01708）
      //      · 加「至少一项带图标」               → 右上角「…」头部菜单中招（m02054）
      //      · 加「必须有一项带快捷键」           → 会话上下文菜单中招（m02092，
      //        它的「重命名/分叉会话/归档会话」都带 Ctrl+Alt+G / Ctrl+Alt+F / Ctrl+Shift+A）
      //    根因：**所有官方菜单都共用同一套 Menu 原语**，DOM 必然同构，
      //    任何从菜单内部找特征的判据都会不断撞车。唯一稳定的区分是
      //    「这一个菜单是不是那个账户按钮弹出来的」。
      //
      // 关键机制（读 .verify/asar/dsh-client-ui-primitives.js 得到）：
      //    MenuSurface 自带 role="menu"，并把 anchor 的 key 写进 CSS 变量：
      //    style.setProperty("--dsh-menu-anchor", "--dsh-menu-" + id.replaceAll(":", ""))
      //    而 Menu 返回的根 span 上写着同一套 key（--dsh-menu-anchor / --dsh-menu-<id>）。
      //    于是「菜单 surface ↔ 触发它的那个根节点」可以按变量名精确配对。
      // ⚠️ 变量名里**不带 -css-var**（写成 --anchor-css-var 会永远匹配不上而静默失效）。
      // ⚠️ 三代失败判据，全部记在这里，别再往回退：
      //   · 只判 div[role=menu] 且含 menuitem → 语言下拉中招（m01708）
      //   · 加「至少一项带图标」             → 右上角「…」头部菜单中招（m02054）
      //   · 加「必须有一项带快捷键」         → 会话上下文菜单中招（m02092）
      //   加「锚点 CSS 变量配对」           → **本版实证仍然中招**（m02127）：
      //     MenuSurface 只在 surface 与 backing 两个 div 上写 --dsh-menu-anchor，
      //     而 Menu 的根 <span> 根本没有 style（primitives.js 4265-4273 行），
      //     所以不存在「携带同一 key 的另一个根节点」，配对恒为 false，
      //     于是每次都落到形状兜底 —— 形状兜底才是 bug 的真身。
      //
      // 根因：**所有官方菜单共用同一套 Menu 原语**，DOM 必然同构；
      // 任何「从菜单内部找特征」的判据都会不断撞车。
      //
      // 正确做法：**不从外部识别账户菜单，而是从内部给它盖章。**
      //   官方 AccountMenu 是**本插件渲染的**（AccountLauncherWithUsage 返回
      //   h(official.component, props2)），它渲染出的是
      //     jsxs("div", { ref: anchor, className: ...root, children: [ ...,
      //       jsx(Menu, { className: ...anchor, anchor: <button aria-haspopup="menu">, ... }) ] })
      //   Menu 把 className 放在**包裹 span** 上，且该 span 里就有那个 trigger 按钮。
      //   于是：本插件在自己的渲染子树里找那个 trigger，记下它的 DOM 节点；
      //   再看某个 portal 菜单的 surface 是否由同一个 Menu 实例弹出 ——
      //   通过「打开该菜单时 trigger 的 aria-expanded 变 true」+ 唯一性来认定。
      //
      // 更强的确定性来自**标记**：本插件渲染的子树里只有一个 aria-haspopup=menu 的
      // 按钮，且它一定属于账户菜单。把它记进 SHARED，菜单判定只认它弹出的 surface。

      // 在「本插件的渲染子树」里找账户 trigger。
      //   官方 AccountMenu 的根 div class 带 AccountMenu 模块的 root 名（哈希会变），
      //   所以不认类名，认**结构**：aria-haspopup="menu" 且其内（或自身）带 avatar。
      //   实测账户 trigger 一定含 avatar（登录后）或 IconEllipsis（未登录）。
      function findAccountTrigger() {
        let list = null;
        try {
          list = document.querySelectorAll('[aria-haspopup="menu"]');
        } catch {
          return null;
        }
        if (list === null) return null;
        let found = null;
        for (const node of list) {
          try {
            // 账户 trigger：带 aria-label="menu"（官方 AccountMenu 写死）或内含 avatar/label。
            const label = node.getAttribute("aria-label") || "";
            const hasAvatar = node.querySelector('[class*="avatar"], [class*="Avatar"]') !== null;
            const hasRootCls = /AccountMenu/.test(typeof node.className === "string" ? node.className : "");
            const parentCls = node.parentNode !== null && typeof node.parentNode.className === "string" ? node.parentNode.className : "";
            if (hasRootCls || hasAvatar || /AccountMenu|_anchor/.test(parentCls)) {
              if (found !== null) return null; // 多个候选 → 不敢认，宁可漏判
              found = node;
            }
          } catch {
            /* ignore */
          }
        }
        return found;
      }

      // 这个 viewport 是不是**那个账户 trigger** 弹出的菜单？
      //   唯一可用的 DOM 级线索：菜单打开时，trigger 的 aria-expanded="true"，
      //   且页面上同一时刻通常只有一个 aria-expanded="true" 的 haspopup 按钮。
      //   为了不误判，额外要求：该 viewport 的项集合里**没有** danger/禁用项，
      //   且项数在 2..6。任何一条不满足就返回 false（宁可漏判）。
      function isAccountMenuViewport(viewport) {
        try {
          if (viewport === null || viewport === undefined) return false;
          const trigger = findAccountTrigger();
          if (trigger === null) return false;
          if (trigger.getAttribute("aria-expanded") !== "true") return false;
          return hasAccountMenuShape(viewport);
        } catch {
          return false;
        }
      }

      // 该节点（或其后代，深度 <= 3）里是否有禁用/危险项：命中即判「不是账户菜单」。
      function submenuHasRiskyMarker(node, depth) {
        if (node === null || node === undefined || depth > 3) return false;
        try {
          const cls = typeof node.className === "string" ? node.className : "";
          if (/danger/i.test(cls)) return true;
          const kids = node.children;
          if (kids === null || kids === undefined) return false;
          for (const kid of kids) {
            if (submenuHasRiskyMarker(kid, depth + 1)) return true;
          }
          return false;
        } catch {
          return false;
        }
      }

      // 通用形状判据：条件全满足才认，宁可漏判也不误判。
      //   · 项数 2..6
      //   · 没有任何**禁用**项（会话菜单在单会话时「置顶/重命名/归档」被禁用）
      //   · 没有任何 danger 项（「归档会话」是 danger）
      //   · 存在 icon 项（语言下拉是纯文本，会被排除）
      function hasAccountMenuShape(viewport) {
        let buttons = null;
        try {
          buttons = viewport.querySelectorAll('button[role="menuitem"]');
        } catch {
          return false;
        }
        if (buttons === null || buttons.length < 2 || buttons.length > 6) return false;
        let icons = 0;
        for (const button of buttons) {
          try {
            if (button.disabled === true) return false;
            const wrap = button.parentNode !== null ? button.parentNode : button;
            if (submenuHasRiskyMarker(wrap, 0)) return false;
            if (wrap.querySelector('[class*="itemIcon"]') !== null) icons += 1;
          } catch {
            /* ignore */
          }
        }
        return icons > 0;
      }
      function findMenuViewport() {
        let menus = null;
        try {
          menus = document.querySelectorAll('div[role="menu"]');
        } catch {
          return null;
        }

        for (const menu of menus) {
          let viewport = null;
          try {
            viewport = menu.querySelector(':scope > div[role="presentation"]');
          } catch {
            viewport = null;
          }
          if (viewport === null) continue;
          let hasItem = null;
          try {
            hasItem = viewport.querySelector('button[role="menuitem"]');
          } catch {
            hasItem = null;
          }
          if (hasItem === null) continue;
          // ① 最强的正信号：surface 上带了 AccountMenu 的 anchor 类（跨版本哈希会变，
          //    所以只作加分；命中即认为是账户菜单，即使图标/快捷键判据一时不满足）。
          let isAccount = false;
          try {
            let node = viewport;
            while (node !== null && node !== document.body) {
              const cls = typeof node.className === "string" ? node.className : "";
              if (/AccountMenu|_anchor\b/.test(cls)) {
                isAccount = true;
                break;
              }
              node = node.parentNode;
            }
          } catch {
            isAccount = false;
          }
          if (isAccount) return viewport;
          // ② 结构判据（图标 + 快捷键）。
          if (isAccountMenuViewport(viewport)) return viewport;

        }
        // 一个都没识别出来时**返回 null**，绝不退化为「任意菜单」——
        // 宁可这一行的位置暂时不显示，也不能污染语言下拉等其它菜单（用户 m01708）。

        return null;
      }

      // 清掉所有「不在账户菜单里」的残留行。旧版本 bundle 曾把行写进任意菜单
      // （语言下拉等），那些节点还挂在 document.body 下的 portal 里，必须主动回收。
      function removeStrayRows() {
        try {
          removeStrayRowsBody();
        } catch {
          /* ignore */
        }
      }

      function removeStrayRowsBody() {
        let hosts = null;
        try {
          hosts = document.querySelectorAll("[" + MENU_HOST_ATTR + "]");
        } catch {
          return;
        }
        if (hosts === null) return;
        for (const host of hosts) {
          try {
            // 找到它所属的菜单 viewport；若该 viewport 不是账户菜单，就移除这一行。
            let node = host.parentNode;
            let viewport = null;
            while (node !== null && node !== document.body) {
              const role = typeof node.getAttribute === "function" ? node.getAttribute("role") : null;
              if (role === "presentation") {
                viewport = node;
                break;
              }
              node = node.parentNode;
            }
            if (viewport === null || !isAccountMenuViewport(viewport)) {
              if (host.parentNode !== null) host.parentNode.removeChild(host);
            }
          } catch {
            /* ignore */
          }
        }
      }

      // ⚠️ 只有 window 上登记的"当前属主"实例才允许写菜单。
      //    HMR 换模块不会卸载旧实例，旧实例的 interval 会一直跑并继续写同一份 DOM；
      //    它们无法被外部 clearInterval（timer id 只留在上一个模块作用域里），
      //    所以唯一的办法是让它们每次 tick 主动让位。
      function isOwner() {
        const shared = sharedState();
        return shared === null || shared.owner === tickOwnerId;
      }

      function menuTick() {
        if (!isOwner()) return;
        try {
          const viewport = findMenuViewport();
          if (viewport === null) {
            // 账户菜单没开（或当前打开的是别的菜单）时，顺手清掉我们残留在别处的那一行
            // ——旧版本 bundle 可能已经把行写进了语言下拉之类的菜单里。
            //
            // ⚠️ 这条路径每 400ms 轮询都走一次，而 removeStrayRows() 是全文查询。
            //    所以：① 只有在「页面上真的存在某个菜单」时才扫；② 再按 500ms 节流。
            //    两者都不满足时直接返回，保证空转成本接近 0。
            const now = Date.now();
            const last = getLastStrayScanAt();
            if (now - last > 500) {
              setLastStrayScanAt(now);
              let anyMenu = false;
              try {
                anyMenu = document.querySelector('div[role="menu"]') !== null;
              } catch {
                anyMenu = false;
              }
              if (anyMenu) removeStrayRows();
            }
            setMenuState({ kind: "idle", view: getMenuState().view, error: getMenuState().error });
            return;
          }
          const row = ensureMenuRow(viewport);
          if (row === null) return;
          const first = viewport.querySelector('button[role="menuitem"]');
          if (first !== null) {
            const parent = first.parentNode !== null ? first.parentNode : viewport;
            if (row.parentNode !== parent || row.nextSibling !== first) {
              parent.insertBefore(row, first);
            }
          }
          // 每轮 tick 都按当前**已缓存**数据重画一次：把内容硬钉在最新一份快照上，
          // 这样即便官方的中间态 DOM 短暂参与了绘制，也不会被看到。
          paintMenuRow(row);
          refreshMenuRow(row);
        } catch {
          /* 菜单结构异常时什么都不做，绝不影响官方菜单 */
        }
      }

      function ensureMenuRow(viewport) {
        let row = null;
        try {
          row = viewport.querySelector("[" + MENU_HOST_ATTR + "]");
        } catch {
          row = null;
        }
        if (row !== null) {
          // 只认我们自己插的那一行（属性 + 类名），避免误接管官方的节点。
          const owned = row.getAttribute(MENU_HOST_ATTR) === "menu-row";
          if (owned) return row;
        }
        try {
          row = document.createElement("div");
          row.className = "dshuu-menuHost dshuu-menuRow";
          row.setAttribute(MENU_HOST_ATTR, "menu-row");
          row.setAttribute("data-tick", "0");
          const first = viewport.querySelector('button[role="menuitem"]');
          // ⚠️ 菜单项并不一定是 viewport 的直接子节点：官方 Menu 把 items 放进 viewport 内的
          // 一个分组 <div>（实测 first.parentNode 是 DIV、viewport.childNodes=3）。必须相对菜单项
          // 自己的父节点插入，否则 insertBefore 抛 "The node before which the new node is to be
          // inserted is not a child of this node"，而我们为不干扰官方菜单会静默吞掉该异常。
          const parent = first !== null && first.parentNode !== null ? first.parentNode : viewport;
          try {
            if (first !== null) parent.insertBefore(row, first);
            else parent.appendChild(row);
          } catch {
          // 官方菜单结构变化时忽略，绝不打断宿主渲染。
          }
          // 官方菜单开合/重渲染会把 viewport 整个换掉，我们那一行随之被丢弃。
          // 新节点必须**立刻**按缓存数据画一次，不能等到下一次 tick —— 否则会闪一帧骨架。
          try {
            paintMenuRow(row);
          } catch {
            /* ignore */
          }
          return row;
        } catch {
          return null;
        }
      }

      // 每次 tick 只按需取数：30s 新鲜期内不重复请求。
      function refreshMenuRow(row) {
        if (!isOwner()) return;
        const now = Date.now();
        if (!getFetchBusy() && now - getLastFetchAt() > 30000) {
          setFetchBusy(true);
          setLastFetchAt(now);
          fetchView(document.documentElement.lang || "zh-CN")
            .then((view) => { setMenuState({ kind: "ok", view, error: null }); })
            .catch((error) => { setMenuState({ kind: "error", view: getMenuState().view, error }); })
            .finally(() => { setFetchBusy(false); paintMenuRow(row); });
        }
        paintMenuRow(row);
      }

      function paintMenuRow(row) {
        if (!isOwner()) return;
        // ⚠️ 写入窗口：本函数会 setAttribute / 重写 textContent，属于 DOM 变更，
        //    必须让 observer 的通知在这期间作废；否则异步回调（fetch 的 .finally）
        //    写一次 → observer 触发 → menuTick → 再写 → …… 又把主线程饿死。
        try {
          // ⚠️ 这个 row 可能是**已经被官方重渲染丢弃**的旧节点（异步 fetch 的 finally 尤其容易
          // 拿到旧节点）。旧节点上的写入不会显示，于是下一轮 tick 又新建一个只画了骨架的节点
          // —— 表现出来就是"骨架/数据两种样子来回闪"。这里先把它重定向到当前 DOM 里的行。
          try {
            if (row === null || row.isConnected === false) {
              const vp = findMenuViewport();
              const live = vp === null ? null : vp.querySelector("[" + MENU_HOST_ATTR + "]");
              if (live !== null && live !== undefined) row = live;
            }
          } catch {
            /* ignore */
          }
          const t = text();
          const tick = Number(row.getAttribute("data-tick") || 0) + 1;
          row.setAttribute("data-tick", String(tick));
          if (getMenuState().view === null) {
            // 只在**真的还没数据**时才显示"正在获取…"。
            // menuRowState 是模块级单例，新节点首帧通常已有缓存 view —— 那时绝不能再画骨架，
            // 否则每次菜单重开都会闪一下骨架，看起来就是"两种样子来回切换"。
            const label = getMenuState().kind === "error" && getMenuState().error ? String(getMenuState().error.message || getMenuState().error) : t.loading;
            renderMenuRowSkeleton(row, t.title, label, t.refresh);
            return;
          }
          renderMenuRowData(row, getMenuState().view);
        } catch {
          /* 渲染失败保持官方菜单可用 */
        }
      }

      function menuEl(tag, className, content) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (content !== undefined && content !== null) node.textContent = String(content);
        return node;
      }

      // 脱敏：绝不在界面上明文展示 key。
      //   例："sk-abcdefghijklmnopqrstuvwx" -> "sk-abc******************uvwx"
      //   太短的串整体打码，避免「尾 4 位」反而暴露大部分内容。
      function maskKey(value) {
        if (typeof value !== "string") return null;
        const s = value.trim();
        if (s === "") return null;
        const head = 6;
        const tail = 4;
        if (s.length <= head + tail) return "*".repeat(Math.max(4, s.length));
        return s.slice(0, head) + "*".repeat(s.length - head - tail) + s.slice(s.length - tail);
      }

      function renderMenuRowSkeleton(row, title, label, refreshLabel) {
        row.textContent = "";
        const head = menuEl("div", "dshuu-menuRowHead");
        head.appendChild(menuEl("div", "dshuu-menuRowTitle", title));
        head.appendChild(menuEl("button", "dshuu-menuRowRefresh", refreshLabel));
        row.appendChild(head);
        if (label === null) return;
        row.appendChild(menuEl("div", "dshuu-muted", label));
      }

      function renderMenuRowData(row, view) {
        const t = text();
        const windows = Array.isArray(view.windows) ? view.windows.slice(0, 3) : [];
        row.textContent = "";

        const head = menuEl("div", "dshuu-menuRowHead");
        head.appendChild(menuEl("div", "dshuu-menuRowTitle", t.title));
        if (view.state === "ok" && windows.length > 0) {
          head.appendChild(menuEl("div", "dshuu-menuRowSummary", summaryText(view)));
        }
        head.appendChild(menuEl("button", "dshuu-menuRowRefresh", t.refresh));
        row.appendChild(head);

        if (view.state !== "ok") {
          const label = view.error ? String(view.error.message || view.error) : t.unavailable;
          row.appendChild(menuEl("div", "dshuu-muted", label));
          return;
        }
        if (windows.length === 0) {
          row.appendChild(menuEl("div", "dshuu-muted", t.noWindows));
          return;
        }

        const binding = bindingWindow(windows);
        const now = Date.now();
        for (const item of windows) {
          const isBinding = binding !== null && binding.scope === item.scope && binding.duration === item.duration;

          // 每个档位占**两行**：
          //   第一行  档位标签 + 进度条          —— 把整行的宽度都留给进度条，一眼看得出剩多少
          //   第二行  累计 / 总额度 + 重置时间   —— 数字与倒计时缩进对齐到进度条起点下方
          const win = menuEl("div", "dshuu-menuWin");

          const barRow = menuEl("div", "dshuu-menuWinBar");
          barRow.appendChild(
            menuEl("div", "dshuu-menuWinLabel" + (isBinding ? " dshuu-labelBinding" : ""), String(item.duration || "—")),
          );

          const used = item.usedKnown === true;
          const percent = used ? Math.max(0, Math.min(100, item.usedPercent === null ? 0 : item.usedPercent)) : 0;
          const remaining = used && typeof item.remaining === "number" ? item.remaining : null;

          // 进度条：宽度代表**剩余**比例，颜色随已用比例从品牌色渐变到告警/错误色。
          const bar = menuEl("div", "dshuu-menuBar");
          const barLeft = menuEl("div", "dshuu-barLeft");
          barLeft.style.width = (100 - percent).toFixed(2) + "%";
          barLeft.style.background = usageColor(percent);
          if (typeof item.resetAt === "string") {
            const dead = deadReach(item, windows, now);
            if (dead > 0) barLeft.style.backgroundImage = DEAD_STRIPES;
          }
          bar.appendChild(barLeft);
          barRow.appendChild(bar);
          win.appendChild(barRow);

          const metaRow = menuEl("div", "dshuu-menuWinMeta");
          // 第二行报**剩余 / 总额度**，与进度条「宽度 = 剩余占比」保持同一含义；
          // 报「已用」会与表头摘要（剩余）以及进度条方向互相打架。
          const amountText = remaining === null ? t.unprovided : remainingText(remaining, item.limit);
          metaRow.appendChild(menuEl("div", "dshuu-amount", amountText));
          if (typeof item.resetAt === "string") {
            metaRow.appendChild(menuEl("div", "dshuu-reset", fill(t.resetIn, { time: formatReset(item.resetAt) })));
          }
          win.appendChild(metaRow);

          row.appendChild(win);
        }

        const limits = view.limits && typeof view.limits === "object" ? view.limits : {};
        row.appendChild(menuEl("div", "dshuu-limits", t.limits + " " + t.rpm + " " + limitText(limits.rpm) + " \u00b7 " + t.parallel + " " + limitText(limits.parallel) + " \u00b7 " + t.tpm + " " + limitText(limits.tpm)));
        // ⚠️ 不要在界面上明文展示 key：脱敏后再显示（保留前 6 位 + 尾 4 位）。
        const aliasText = maskKey(view.alias);
        if (aliasText !== null) row.appendChild(menuEl("div", "dshuu-alias", t.keyScope + " " + aliasText));
        const fetched = formatFetchedAt(view.fetchedAt);
        row.appendChild(menuEl("div", "dshuu-fetched", fetched === null ? t.neverFetched : t.fetchedAt + " " + fetched));
      }

      // 点「刷新」时立刻重取。用事件委托，避免为菜单项重建监听。
      try {
        document.addEventListener("click", (event) => {
          try {
            const el = event.target;
            if (el === null || typeof el.closest !== "function") return;
            const button = el.closest("." + "dshuu-menuRowRefresh");
            if (button === null) return;
            const row = button.closest("[" + MENU_HOST_ATTR + "]");
            if (row === null) return;
            event.preventDefault();
            event.stopPropagation();
            setLastFetchAt(0);
            setFetchBusy(true);
            setMenuState({ kind: "loading", view: null, error: null });
            paintMenuRow(row);
            fetchView(document.documentElement.lang || "zh-CN")
              .then((view) => { setMenuState({ kind: "ok", view, error: null }); })
              .catch((error) => { setMenuState({ kind: "error", view: null, error }); })
              .finally(() => { setFetchBusy(false); setLastFetchAt(Date.now()); paintMenuRow(row); });
          } catch {
            /* ignore */
          }
        }, true);
      } catch {        /* ignore */
      }

      // 启动账户菜单轮询（纯轮询，见上方注释：绝不监听自己会写的子树）。
      observeLauncherRender();
      adoptLiveRow();

      // ⚠️ priority 必须**小于**官方的 0：single 槽按 priority 升序排，
      // 渲染时取 entriesOfSlot(key)[0]（最小者胜出，即 "lowest renders"）。
      // 用正数（如 1）会被官方的 0 压住，本组件根本不会被渲染。
      ctx.slots.inject("settings.launcher", () =>
        ctx.slots.register({ name: "settings.launcher", priority: -1 }, AccountLauncherWithUsage),
      );
    }

    const inject = ["slots"];

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
