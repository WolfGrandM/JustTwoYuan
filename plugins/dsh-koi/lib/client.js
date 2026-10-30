/**
 * dsh-koi —— 客户端半边（市场版）：设置 → 彩票 section + 桌宠小组件（独立 React root）
 *
 * 结构（docs/16 §2.2.3/§2.2.7/§8.4）：
 *   · 桌宠：mountPet = ensureCss → require("react-dom") → createRoot(自建容器) → render
 *     （dsh-m mountPanel 实证模式复刻，D-003）；降级第一级：react-dom 不可用时容器静默移除，
 *     事件链路与面板渠道完全不受影响（MB-28/MC-16 ②）——通知不丢。
 *   · 配置面板六大区（渠道凭证/角色数量/预算权重/力度/详略/投注档位）+ 实时成本估算双显示（MB-22）；
 *   · 引导向导五步（渠道→档位→时间→诚实条款→数据就绪检查 /api/backbone，MC-03/MC-18）；
 *   · 事件列表 + 心跳红标（可见性兜底不依赖任何渠道）。
 * 市场版零 QQ 文案（BC-103）；React 渲染壳标注「未跑待主人上机」（MC-16 ③），
 * 逻辑面已由 lib/ui-logic.js 纯函数直测 + 本文件 factory(require) 微桩测试覆盖（MC-16 ①②）。
 */
window.__ModuleLoader__.load({
  id: "dsh-koi",
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const React = require("react");
    const { createElement: h, useCallback, useEffect, useRef, useState } = React;

    const API = "/dsh-koi/api";
    const CSS_TAG = "dsh-koi/section.css";
    const PET_CSS_TAG = "koi-pet-css";
    const PET_ROOT_ID = "koi-pet-root";
    const LAST_READ_KEY = "koi-pet-last-read";

    const CSS = [
      ".koi{max-width:760px;color:var(--dsw-alias-label-primary);display:flex;flex-direction:column;gap:6px}",
      ".koi-title{margin:0;font-size:16px;font-weight:500;line-height:24px}",
      ".koi-intro{color:var(--dsw-alias-label-tertiary);margin:0 0 4px;font-size:13px;line-height:20px}",
      ".koi-card{border:.5px solid var(--dsw-alias-border-l2);border-radius:10px;padding:12px 14px;margin-top:10px;display:flex;flex-direction:column;gap:8px}",
      ".koi-card-head{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap}",
      ".koi-name{font-size:13.5px;font-weight:600}",
      ".koi-phase{font-size:11.5px;line-height:16px;color:var(--dsw-alias-label-tertiary)}",
      ".koi-picks{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px;line-height:18px;white-space:pre-wrap}",
      ".koi-btn{background:var(--dsw-alias-brand-primary);color:#fff;border:none;border-radius:6px;font-size:12.5px;height:30px;padding:0 12px;cursor:pointer}",
      ".koi-btn:disabled{opacity:.5;cursor:default}",
      ".koi-btn2{background:transparent;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary)}",
      ".koi-out{white-space:pre-wrap;font-size:12.5px;line-height:19px;color:var(--dsw-alias-label-secondary);background:rgba(127,127,127,.08);border-radius:8px;padding:10px 12px;max-height:320px;overflow:auto}",
      ".koi-err{color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px;white-space:pre-line}",
      ".koi-badge{display:inline-block;font-size:11px;line-height:16px;padding:1px 7px;border-radius:999px;background:rgba(127,127,127,.14);color:var(--dsw-alias-label-secondary);margin-left:6px}",
      ".koi-red{display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-state-error-primary,#e54d42);margin-right:6px;vertical-align:middle}",
      ".koi-sec-title{font-size:12.5px;font-weight:600;margin:8px 0 2px}",
      ".koi-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:12.5px;line-height:20px}",
      ".koi-input{background:transparent;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;color:inherit;font-size:12.5px;height:28px;padding:0 8px}",
      ".koi-hint{color:var(--dsw-alias-label-tertiary);font-size:11.5px;line-height:17px}",
      ".koi-events{max-height:280px;overflow:auto;display:flex;flex-direction:column;gap:4px}",
      ".koi-evt{font-size:12px;line-height:18px;padding:6px 8px;border-radius:8px;background:rgba(127,127,127,.08)}",
      // 桌宠（前缀 koi-pet-；样式隔离 §2.2.3-2）
      ".koi-tabs{display:flex;gap:8px;margin:4px 0 12px;flex-wrap:wrap}",
      ".koi-donation{margin-top:14px;display:flex;flex-direction:column;gap:4px}",
      ".koi-don-line{font-size:11px;color:var(--dsw-alias-label-tertiary);cursor:pointer;user-select:none}",
      ".koi-don-line:hover{color:var(--dsw-alias-label-secondary)}",
      ".koi-don-link{font-size:12px;color:var(--dsw-alias-brand-primary,#4a9eff)}",
      ".koi-pet-container{position:fixed;z-index:2147483000;pointer-events:none}",
      ".koi-pet-container.br{right:16px;bottom:16px}",
      ".koi-pet-container.bl{left:16px;bottom:16px}",
      ".koi-pet-container.tr{right:16px;top:16px}",
      ".koi-pet-container.tl{left:16px;top:16px}",
      ".koi-pet-fish{pointer-events:auto;cursor:pointer;font-size:26px;line-height:1;filter:drop-shadow(0 2px 6px rgba(0,0,0,.25));user-select:none}",
      ".koi-pet-dot{position:absolute;top:-4px;right:-6px;min-width:16px;height:16px;border-radius:999px;background:var(--dsw-alias-state-error-primary,#e54d42);color:#fff;font-size:10px;line-height:16px;text-align:center;padding:0 4px}",
      ".koi-pet-list{pointer-events:auto;position:absolute;bottom:40px;right:0;width:300px;max-height:320px;overflow:auto;background:rgba(24,26,34,.97);color:#e8eaf0;border:1px solid rgba(255,255,255,.14);border-radius:10px;padding:8px;display:flex;flex-direction:column;gap:4px}",
      ".koi-pet-bubble{pointer-events:auto;position:absolute;bottom:40px;right:0;width:280px;background:rgba(24,26,34,.97);color:#e8eaf0;border:1px solid rgba(255,255,255,.14);border-radius:10px;padding:8px 10px;font-size:12px;line-height:18px;white-space:pre-wrap}",
      ".koi-pet-close{pointer-events:auto;position:absolute;top:-8px;left:-8px;width:18px;height:18px;border-radius:50%;border:none;background:rgba(255,255,255,.16);color:#e8eaf0;font-size:11px;line-height:18px;text-align:center;cursor:pointer}",
    ].join("");

    const PHASE_TEXT = {
      off: "今天不开",
      idle: "等待 17:30 出号",
      predicted: "号已出，通知中…",
      pushed: "已通知 ✓ 等开奖",
      settled: "已对账 ✓",
      failed: "今天出号失败",
      skipped: "今天没赶上",
    };
    const MODE_TEXT = { off: "已关（来一注仍可用）", manual: "手动（来一注）", auto: "自动（完整流水线）" };

    function useStyleOnce() {
      useEffect(() => {
        if (typeof document === "undefined") return;
        if (!document.getElementById(CSS_TAG)) {
          const el = document.createElement("style");
          el.id = CSS_TAG;
          el.textContent = CSS;
          document.head.appendChild(el);
        }
      }, []);
    }

    // ── 事件拉取（桌宠与事件列表共用；30s 轮询，窗口 200 条常量级）────────────────
    function useEvents() {
      const [events, setEvents] = useState([]);
      const [lastId, setLastId] = useState(null);
      useEffect(() => {
        let alive = true;
        const load = async () => {
          try {
            const r = await fetch(`${API}/events?limit=200`, { headers: { accept: "application/json" } });
            const j = await r.json().catch(() => ({}));
            if (alive && j.ok) { setEvents(j.events ?? []); if (j.lastId) setLastId(j.lastId); }
          } catch { /* 下一轮再试 */ }
        };
        load();
        const t = setInterval(load, 30_000);
        return () => { alive = false; clearInterval(t); };
      }, []);
      return { events, lastId };
    }

    const readLastRead = () => { try { const v = localStorage.getItem(LAST_READ_KEY); return v && v !== "null" ? v : null } catch { return null } }
    const writeLastRead = (id) => { try { if (id != null) localStorage.setItem(LAST_READ_KEY, id) } catch {} }

    // ── 桌宠组件（渲染壳：未跑待主人上机，MC-16 ③；逻辑面见 __uiLogic 与微桩测试）──
    function KoiPet({ onClosePet }) {
      const { events, lastId } = useEvents();
      const [open, setOpen] = useState(false);
      const [readId, setReadId] = useState(readLastRead());
      const [guideSeen, setGuideSeen] = useState(false);
      try { guideSeen = localStorage.getItem("koi-pet-guide") === "1" } catch {}
      const winUnread = exports.__uiLogic.winUnreadCount(events, readId);
      const winStart = (() => { if (!readId) return 0; const i = events.findIndex((e) => e?.id === readId); return i >= 0 ? i + 1 : 0; })();
      const lastWinUnread = events.slice(winStart).filter((e) => e?.won === true).pop() ?? null;
      const markRead = () => { const rid = lastId ?? (events.length ? events[events.length - 1].id : null); if (rid != null) { writeLastRead(rid); setReadId(rid) } };
      const corner = "br";
      return h("div", { className: `koi-pet-container ${corner}` },
        h("button", {
          className: "koi-pet-close",
          title: "关闭桌宠（可在 设置→彩票 重新开启；事件仍见面板与渠道）",
          onClick: () => { try { fetch(`${API}/config`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ patch: { "pet.enabled": false } }) }) } catch {}; onClosePet?.() },
        }, "×"),
        !guideSeen && events.length === 0 ? h("div", { className: "koi-pet-bubble" },
          "🐟 你好，我是锦鲤！点下面的鱼可以「现在来一注」（零配置，默认手动模式·不记账）。",
          h("div", { style: { textAlign: "right", marginTop: 4 } },
            h("button", { className: "koi-btn koi-btn2", style: { height: 22, fontSize: 11 }, onClick: () => { try { localStorage.setItem("koi-pet-guide", "1") } catch {}; setGuideSeen(true) } }, "知道了"))) : null,
        lastWinUnread && !open ? h("div", { className: "koi-pet-bubble" }, exports.__uiLogic.bubbleTitle(lastWinUnread), "\n", lastWinUnread.body?.slice(0, 160)) : null,
        open ? h("div", { className: "koi-pet-list" },
          (events.slice(-200).reverse()).map((e) => h("div", { className: "koi-evt", key: e.id }, `[${e.kind}] ${e.body?.split("\n")[0] ?? ""}`)),
          events.length ? h("button", { className: "koi-btn koi-btn2", style: { height: 24 }, onClick: markRead }, "全部标为已读") : null) : null,
        h("div", { className: "koi-pet-fish", onClick: () => { setOpen(!open); markRead() } },
          "🐟", winUnread > 0 ? h("span", { className: "koi-pet-dot" }, winUnread > 99 ? "99+" : winUnread) : null));
    }

    // ── 桌宠挂载（D-003：独立 root；降级第一级 MB-28）──────────────────────────
    let petRoot = null;
    let petContainer = null;
    function ensurePetCss() {
      if (typeof document === "undefined") return;
      if (!document.getElementById(PET_CSS_TAG)) {
        const el = document.createElement("style");
        el.id = PET_CSS_TAG;
        el.textContent = CSS;
        document.head.appendChild(el);
      }
    }
    function mountPet(requireFn, props) {
      try {
        ensurePetCss();                                   // ① ensureCss
        let ReactDOM = requireFn("react-dom");            // ② require react-dom（interop）
        if (ReactDOM && ReactDOM.default) ReactDOM = ReactDOM.default;
        if (!ReactDOM || typeof ReactDOM.createRoot !== "function") throw new Error("react-dom createRoot 不可用");
        petContainer = document.getElementById(PET_ROOT_ID);
        if (!petContainer) {
          petContainer = document.createElement("div");
          petContainer.id = PET_ROOT_ID;
          document.body.appendChild(petContainer);
        }
        petRoot = ReactDOM.createRoot(petContainer);      // ③ createRoot
        petRoot.render(h(KoiPet, props ?? {}));           // ④ render
        return { ok: true, degraded: false };
      } catch (e) {
        // 分级降级第一级（MB-28）：容器静默移除；panel 渠道与事件链路不受影响——通知不丢
        try { if (petContainer && petContainer.parentNode) petContainer.remove() } catch {}
        petRoot = null; petContainer = null;
        return { ok: false, degraded: true, error: String((e && e.message) || e) };
      }
    }
    function unmountPet() {
      try { if (petRoot) petRoot.unmount() } catch {}
      try { if (petContainer && petContainer.parentNode) petContainer.remove() } catch {}
      petRoot = null; petContainer = null;
    }

    // ── 向导（S-102 五步；第 5 步 = 近期窗口数据就绪检查，MC-03/MC-18）────────────
    function Wizard({ st, onDone, onClose }) {
      const [step, setStep] = useState(0);
      const [tier, setTier] = useState((st.tiers && st.tiers.p3 && st.tiers.p3.id) || "p3-x1");
      const [game, setGame] = useState("p3");
      const [time, setTime] = useState("17:30");
      const [checked, setChecked] = useState(false);
      const [dataState, setDataState] = useState(null);   // null | 'pulling' | 'ok' | 'fail'
      const [missing, setMissing] = useState(null);
      const STEPS = exports.__uiLogic.WIZARD_STEPS;
      const drawAt = (st.allGames ?? []).find((g) => g.key === game)?.drawAt ?? "21:25";
      const stepBad = {
        channels: !(st.channels ?? []).some((c) => c.enabled && c.status === "ok"),
        tier: false,
        time: !/^\d{2}:\d{2}$/.test(time) || time >= drawAt,
        honesty: !checked,
        data: dataState !== "ok",
      };
      const canAdvance = exports.__uiLogic.wizardCanAdvance(step, stepBad);
      const finish = async () => {
        const r = await fetch(`${API}/mode`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ game, mode: "auto", tier, predictAt: time, gates: { honestyAck: true } }) });
        const j = await r.json().catch(() => ({}));
        if (j.ok) { onDone(); onClose(); } else setMissing(j.missing ?? (j.errors ?? [j.error ?? "开启失败"]));
      };
      return h("div", { className: "koi-card" },
        h("div", { className: "koi-card-head" },
          h("span", { className: "koi-name" }, `自动模式向导（${step + 1}/${STEPS.length} · ${STEPS[step].title}）`),
          h("button", { className: "koi-btn koi-btn2", onClick: onClose }, "取消")),
        h("div", { className: "koi-hint" }, STEPS[step].desc),
        step === 0 ? h("div", { className: "koi-row" },
          (st.channels ?? []).map((c) => h("span", { key: c.type, className: "koi-badge" }, `${c.type}：${c.status}${c.error ? `（${c.error}）` : ""}`)),
          !(st.channels ?? []).some((c) => c.enabled && c.status === "ok") ? h("span", { className: "koi-err" }, "至少启用一个可用渠道（桌宠面板渠道即算）") : null) : null,
        step === 1 ? h("div", { className: "koi-row" },
          h("select", { className: "koi-input", value: game, onChange: (e) => { setGame(e.target.value); setTier((st.tierTable?.[e.target.value] ?? [])[0]?.id ?? tier) } },
            (st.allGames ?? []).map((g) => h("option", { key: g.key, value: g.key }, g.name))),
          h("select", { className: "koi-input", value: tier, onChange: (e) => setTier(e.target.value) },
            (st.tierTable?.[game] ?? []).map((t) => h("option", { key: t.id, value: t.id }, `${t.label}（${t.bets} 注 / ${t.cost} 元）`))),
          h("span", { className: "koi-hint" }, "换档下期生效，账本按当期实际结构记")) : null,
        step === 2 ? h("div", { className: "koi-row" },
          h("input", { className: "koi-input", value: time, onChange: (e) => setTime(e.target.value), placeholder: "HH:MM" }),
          h("span", { className: "koi-hint" }, `必须早于开奖时刻 ${drawAt}`)) : null,
        step === 3 ? h("div", { className: "koi-row" },
          h("label", null,
            h("input", { type: "checkbox", checked, onChange: (e) => setChecked(e.target.checked) }),
            " 我已理解：开奖是独立随机事件，任何选号方法都不改变中奖概率；"),
          h("div", { className: "koi-hint" },
            "自动模式要求开奖时段本应用处于运行状态（关机/睡眠会错过；补跑窗口至 19:50 兜底一部分）。想要全天候可自建服务器部署。")) : null,
        step === 4 ? h("div", { className: "koi-row" },
          h("button", {
            className: "koi-btn", disabled: dataState === "pulling",
            onClick: async () => {
              setDataState("pulling");
              try {
                const r = await fetch(`${API}/backbone`, { method: "POST" });
                const j = await r.json().catch(() => ({}));
                setDataState(j.ok ? "ok" : "fail");
              } catch { setDataState("fail"); }
            },
          }, dataState === "pulling" ? "拉取中…" : "拉取近期开奖"),
          h("span", { className: dataState === "ok" ? "koi-hint" : "koi-err" },
            dataState === "ok" ? "数据就绪 ✓（秒—分钟级；全量历史回拉见下方「数据」区）" : dataState === "fail" ? "拉取失败，可重试" : "先拉取再完成")) : null,
        missing ? h("div", { className: "koi-err" }, (missing ?? []).map((m) => m.label ? `${m.label}：${m.hint}` : String(m)).join("\n")) : null,
        h("div", { className: "koi-row" },
          step > 0 ? h("button", { className: "koi-btn koi-btn2", onClick: () => setStep(step - 1) }, "上一步") : null,
          step < STEPS.length - 1
            ? h("button", { className: "koi-btn", disabled: !canAdvance, onClick: () => setStep(step + 1) }, "下一步")
            : h("button", { className: "koi-btn", disabled: !exports.__uiLogic.wizardComplete(stepBad), onClick: finish }, "完成并开启自动")));
    }

    // ── 第二波三新区（docs/19 §8；渲染壳标注「未跑待主人上机」——逻辑面/文案常量已直测）──
    function LearningArea() {
      const [data, setData] = useState(null);
      const [msg, setMsg] = useState("");
      const [file, setFile] = useState(null);
      const load = useCallback(async () => {
        try {
          const r = await fetch(`${API}/ingest`, { headers: { accept: "application/json" } });
          const j = await r.json().catch(() => ({}));
          if (j.ok) setData(j);
        } catch { /* 下一轮再试 */ }
      }, []);
      useEffect(() => { load(); const t = setInterval(load, 15_000); return () => clearInterval(t); }, [load]);
      const ui = exports.__uiLogic;
      const cap = data?.usage?.cap ?? null;
      const est = file ? ui.uploadEstimate(file.size, cap) : null;
      const doUpload = async () => {
        if (!file) return;
        setMsg("上传中…");
        try {
          const r = await fetch(`${API}/ingest?name=${encodeURIComponent(file.name)}`, {
            method: "POST", headers: { "content-type": "application/octet-stream", accept: "application/json" }, body: file,
          });
          const j = await r.json().catch(() => ({}));
          if (j.ok) { setMsg(`已上传（估算 ≈ ${j.estimateTokens} tokens，${est?.basis ?? "估算口径：字节/12"}）：任务处理进度见下`); setFile(null); load(); }
          else setMsg(ui.rejectedNote(j.error));
        } catch (e) { setMsg(String(e.message ?? e)); }
      };
      return h("div", null,
        h("div", { className: "koi-sec-title" }, "📚 学习（上传技巧 → 清洗拆卡 → 严格回测）"),
        h("div", { className: "koi-hint" }, ui.LEARNING_COPY),
        h("div", { className: "koi-row" },
          h("input", { type: "file", accept: ".txt,.md", onChange: (e) => setFile(e.target.files?.[0] ?? null) }),
          h("button", { className: "koi-btn", disabled: !file, onClick: doUpload }, "上传"),
          file ? h("span", { className: "koi-hint" },
            `${ui.formatBytes(file.size)} · 估算 ≈ ${est.tokens} tokens${est.pct != null ? ` · 占周预算 ${est.pct}%` : ""}（${est.basis}）`) : null),
        h("div", { className: "koi-hint" }, ui.UPLOAD_HINT),
        msg ? h("div", { className: "koi-hint" }, msg) : null,
        (data?.jobs ?? []).length ? h("div", null,
          h("div", { className: "koi-sec-title" }, `学习任务（最近 ${Math.min(data.jobs.length, 10)} 条）`),
          data.jobs.slice(0, 10).map((j) => h("div", { className: "koi-row", key: j.id },
            h("span", { className: "koi-badge" }, ui.jobBadgeText(j)),
            `${j.name} · ${ui.formatBytes(j.size)}`,
            j.error ? h("span", { className: "koi-err" }, j.status === "pending-llm" ? ui.PENDING_LLM_NOTE : ui.rejectedNote(j.error)) : null,
            (j.cards ?? []).map((c, i) => h("div", { className: "koi-hint", key: i },
              `· ${c.verdict.startsWith("rule-dup") ? ui.ruleDupHint(c.ruleDupName ?? "既有卡片") : `${c.verdict} · ${c.name}`}`))))) : null,
        (data?.cards ?? []).length ? h("div", null,
          h("div", { className: "koi-sec-title" }, `卡片库（${data.cards.length} 张）`),
          data.cards.map((c) => h("div", { className: "koi-row", key: c.id },
            h("span", { className: "koi-badge" }, `${(c.games ?? []).join("/")}/${c.trustLevel}/${c.status}`),
            c.name,
            c.backtest ? h("span", { className: "koi-badge" }, `${ui.verdictTextOf(c.backtest.verdict)} · ${(c.backtest.hitRate * 100).toFixed(1)}%/${c.backtest.rounds}轮`) : null,
            c.factorizeError ? h("span", { className: "koi-err" }, `无法因子化：${c.factorizeError}`) : null))) : null);
    }

    function DataArea({ st }) {
      const [bf, setBf] = useState(null);
      const [msg, setMsg] = useState("");
      const load = useCallback(async () => {
        try {
          const r = await fetch(`${API}/backbone`, { headers: { accept: "application/json" } });
          const j = await r.json().catch(() => ({}));
          if (j.ok) setBf(j.backfill);
        } catch { /* 下一轮再试 */ }
      }, []);
      useEffect(() => { load(); const t = setInterval(load, 15_000); return () => clearInterval(t); }, [load]);
      const ui = exports.__uiLogic;
      const startFull = async (game) => {
        if (typeof window !== "undefined" && !window.confirm(ui.FULLBACKFILL_CONFIRM)) return;   // 确认框（§2.5 定稿）
        setMsg("已请求全量回拉…");
        try {
          const r = await fetch(`${API}/backbone/full`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ game, confirm: true }) });
          const j = await r.json().catch(() => ({}));
          setMsg(j.ok ? "已开始（进度见下；可随时停止，断点保留）" : `未开始：${j.error}`);
          load();
        } catch (e) { setMsg(String(e.message ?? e)); }
      };
      const stopFull = async () => {
        try {
          const r = await fetch(`${API}/backbone/stop`, { method: "POST" });
          const j = await r.json().catch(() => ({}));
          setMsg(j.note ?? "已请求停止");
        } catch (e) { setMsg(String(e.message ?? e)); }
      };
      const running = (bf?.running ?? []).length > 0;
      return h("div", null,
        h("div", { className: "koi-sec-title" }, "🗄 数据（本地开奖库 · 全量回拉底座）"),
        (st.allGames ?? []).map((g) => {
          const b = st.backbone?.[g.key] ?? {};
          const pg = bf?.perGame?.[g.key];
          return h("div", { className: "koi-row", key: g.key },
            `${g.name}：${b.count ?? 0} 期在库 · 最新 ${b.latestIssue ?? "无"} @ ${b.latestDate ?? "-"}${b.fresh ? "" : "（陈旧）"}`,
            pg?.progress ? h("span", { className: "koi-badge" }, ui.backfillProgressText(pg.progress?.note, b.count)) : null,
            pg?.status ? h("span", { className: "koi-hint" }, `回拉：${pg.status}${pg.lastErr ? ` · ✗ ${pg.lastErr}` : ""}${pg.rejectedTotal ? ` · 拒用 ${pg.rejectedTotal}` : ""}`) : null,
            running ? h("button", { className: "koi-btn koi-btn2", onClick: stopFull }, "停止回拉") : h("button", { className: "koi-btn koi-btn2", onClick: () => startFull(g.key) }, "全量回拉历史"),
            pg?.audit?.continuity?.gaps?.length ? h("span", { className: "koi-err" }, `⚠ ${pg.audit.continuity.gaps.length} 处断档（可能为源端历史缺失）`) : null);
        }),
        h("div", { className: "koi-hint" }, ui.SPORTTERY_DEEP_NOTE),
        msg ? h("div", { className: "koi-hint" }, msg) : null);
    }

    function FactorArea() {
      const [v, setV] = useState(null);
      const load = useCallback(async () => {
        try {
          const r = await fetch(`${API}/backtest`, { headers: { accept: "application/json" } });
          const j = await r.json().catch(() => ({}));
          if (j.ok) setV(j);
        } catch { /* 下一轮再试 */ }
      }, []);
      useEffect(() => { load(); }, [load]);
      const ui = exports.__uiLogic;
      const rows = [];
      for (const [g, list] of Object.entries(v?.verdicts ?? {})) for (const x of list) rows.push({ g, ...x });
      return h("div", null,
        h("div", { className: "koi-sec-title" }, "🔬 因子结论（内置六件 + 卡片因子；样本内回测）"),
        rows.length ? h("div", { className: "koi-events" }, rows.map((x, i) => h("div", { className: "koi-evt", key: i },
          `[${x.kind === "builtin" ? "内置" : "卡片"}·${x.g}] ${x.name}：${(x.hitRate * 100).toFixed(1)}% vs 基线 ${(x.baselineRate * 100).toFixed(1)}% · ${x.rounds} 轮 · p=${Number(x.pValue).toExponential(1)} → ${ui.verdictTextOf(x.verdict)}`)))
          : h("div", { className: "koi-hint" }, "（还没有回测结论——先全量回拉历史（上方「数据」区），再学习上传或等宿主空闲期自动跑；CLI：koi.mjs backtest run）"),
        h("div", { className: "koi-hint" }, ui.VERDICT_CALIBER),
        h("div", { className: "koi-hint" }, "回测结论仅供你参考，不改变任何自动行为（不改档位、不进出号提示词）。"));
    }

    // ── 配置面板六大区（§2.2.7）────────────────────────────────────────────────
    function ConfigPanel({ st, reload }) {
      const [cfg, setCfg] = useState(null);
      const [saveMsg, setSaveMsg] = useState("");
      const [testMsg, setTestMsg] = useState("");
      const load = useCallback(async () => {
        try {
          const r = await fetch(`${API}/config`, { headers: { accept: "application/json" } });
          const j = await r.json().catch(() => ({}));
          if (j.ok) setCfg(j.config);
        } catch {}
      }, []);
      useEffect(() => { load() }, [load]);
      if (!cfg) return h("div", { className: "koi-hint" }, "配置读取中…");
      const est = st.costEstimate;
      const patch = async (p) => {
        setSaveMsg("保存中…");
        try {
          const r = await fetch(`${API}/config`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ patch: p }) });
          const j = await r.json().catch(() => ({}));
          setSaveMsg(j.ok ? "已保存（下一轮 tick 生效，约 30 秒）" : `保存被拒：${(j.errors ?? []).join("；")}`);
          if (j.ok) { load(); reload(); }
        } catch (e) { setSaveMsg(String(e.message ?? e)); }
      };
      const switchMode = async (game, mode) => {
        setSaveMsg("切换模式中…");
        try {
          const r = await fetch(`${API}/mode`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ game, mode }) });
          const j = await r.json().catch(() => ({}));
          if (j.ok) { setSaveMsg("模式已切换（下一轮 tick 生效，约 30 秒）"); load(); reload(); }
          else { setSaveMsg(`切换被拒：${(j.errors ?? [j.error ?? "未知原因"]).join("；")}`); load(); }
        } catch (e) { setSaveMsg(String(e.message ?? e)); }
      };
      const testPush = async () => {
        setTestMsg("发送中…");
        try {
          const r = await fetch(`${API}/test-push`, { method: "POST", headers: { accept: "application/json" } });
          const j = await r.json().catch(() => ({}));
          setTestMsg(j.detail ?? (j.ok ? "已发出 ✓" : "失败"));
        } catch (e) { setTestMsg(String(e.message ?? e)); }
      };
      const vc = exports.__uiLogic.verbosityChoice(cfg.verbosity);
      const gameOf = (k) => (st.allGames ?? []).find((g) => g.key === k) ?? {};
      return h("div", null,
        // ① 渠道凭证
        h("div", { className: "koi-sec-title" }, "① 渠道凭证"),
        h("div", { className: "koi-row" },
          (st.channels ?? []).map((c, i) => h("span", { key: c.type + i, className: "koi-badge" },
            `${c.type} · ${c.enabled ? "启用" : "停用"} · ${c.status}`,
            c.error ? `（${c.error}）` : "")),
          h("button", { className: "koi-btn koi-btn2", onClick: testPush, disabled: testMsg === "发送中…" }, testMsg === "发送中…" ? "发送中…" : "测试通知"),
          h("button", { className: "koi-btn koi-btn2", onClick: async () => {
            const r = await fetch(`${API}/channels/test`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ index: 0 }) });
            const j = await r.json().catch(() => ({}));
            setSaveMsg(`渠道配置测试：${j.ok ? "✓ " + (j.detail ?? "") : "✗ " + (j.detail ?? j.error ?? "")}`);
          } }, "测试渠道配置"),
          h("span", { className: "koi-hint" }, "凭证存本地 koi/channels/<type>.config.json（不进主配置；回显一律掩码）"),
          testMsg ? h("div", { className: "koi-hint" }, testMsg) : null),
        h("div", { className: "koi-row" },
          h("label", null,
            h("input", { type: "checkbox", checked: cfg.pet?.enabled !== false, onChange: (e) => {
              const on = e.target.checked;
              patch({ "pet.enabled": on });
              try { on ? exports.__petControl?.enable?.() : exports.__petControl?.disable?.() } catch {}
            } }),
            " 桌宠（harness 右下角通知小鱼）"),
          h("span", { className: "koi-hint" }, "关闭后事件仍见面板与渠道；重新勾选即恢复")),
        // ② 角色数量（FZ-7 围栏：数量可配、提示词只读）
        h("div", { className: "koi-sec-title" }, "② 角色数量"),
        h("div", { className: "koi-row" },
          "策略师：",
          h("select", { className: "koi-input", value: cfg.roles?.strategists ?? 1, onChange: (e) => patch({ "roles.strategists": Number(e.target.value) }) },
            [1, 2, 3, 4].map((n) => h("option", { key: n, value: n }, `${n} 位`))),
          h("span", { className: "koi-hint" }, "数据官/质询者/主持人固定 1；任务提示词编辑随 M3 编排器开放（围栏外不可及）")),
        // ③ 预算权重
        h("div", { className: "koi-sec-title" }, "③ 预算权重"),
        h("div", { className: "koi-row" },
          "周预算（tokens/周）：",
          h("input", { className: "koi-input", style: { width: 120 }, type: "number", defaultValue: cfg.budget?.weeklyCap, onBlur: (e) => { const v = Number(e.target.value); if (v > 0 && v !== cfg.budget?.weeklyCap) patch({ "budget.weeklyCap": v }) } }),
          h("span", { className: "koi-hint" }, `预警 ${Math.round((cfg.budget?.warn1 ?? 0.7) * 100)}%/${Math.round((cfg.budget?.warn2 ?? 0.9) * 100)}%，触顶降档链兜底`)),
        // ④ 力度（杠杆状态如实显示）
        h("div", { className: "koi-sec-title" }, "④ 力度"),
        h("div", { className: "koi-row" },
          h("select", { className: "koi-input", value: cfg.effort?.tier ?? "follow-host", onChange: (e) => patch({ "effort.tier": e.target.value }) },
            ["follow-host", "economy", "standard", "turbo"].map((t) => h("option", { key: t, value: t }, t))),
          h("span", { className: "koi-hint" }, st.effort?.leverActive ? "力度影响分析质量与 token 成本，不影响中奖概率" : "当前形态力度不生效（如实显示）")),
        // ⑤ 详略（全局单档）
        h("div", { className: "koi-sec-title" }, "⑤ 详略（全局单档）"),
        h("div", { className: "koi-row" },
          h("button", { className: "koi-btn koi-btn2", onClick: () => patch({ verbosity: vc.next }) }, `切换到「${vc.value === cfg.verbosity ? vc.label : (vc.value === "chatty" ? "叨逼叨" : "简洁")}」`),
          h("span", { className: "koi-hint" }, `当前：${cfg.verbosity === "concise" ? "简洁（号码+合规字段）" : "叨逼叨（+≤100字摘要）"}；合规字段两档恒在`)),
        // ⑥ 投注档位 + 模式开关（主人 2026-10-25 拍板：自动模式必须提供可关闭的选项）
        h("div", { className: "koi-sec-title" }, "⑥ 投注档位与模式"),
        ...((st.allGames ?? [])).map((g) => h("div", { className: "koi-row", key: g.key },
          `${g.name}：`,
          h("select", { className: "koi-input", value: st.tiers?.[g.key]?.id ?? "", onChange: (e) => patch({ [`modes.${g.key}.tier`]: e.target.value }) },
            (st.tierTable?.[g.key] ?? []).map((t) => h("option", { key: t.id, value: t.id }, `${t.label}（${t.bets} 注 / ${t.cost} 元）`))),
          h("select", { className: "koi-input", value: st.modes?.[g.key]?.mode ?? "manual", onChange: (e) => switchMode(g.key, e.target.value) },
            (st.modes?.[g.key]?.mode === "auto" ? ["auto", "manual", "off"] : ["manual", "off"]).map((m) => h("option", { key: m, value: m }, MODE_TEXT[m] ?? m))),
          h("span", { className: "koi-hint" }, st.modes?.[g.key]?.mode === "auto" ? "自动运行中；切到手动/关闭即停未来的出号与推送，已出的号今晚仍会完成对账（账本诚实优先于模式门）" : "换档下期生效；开启自动请用彩种卡片上的向导（四项门控）"))),
        // 实时成本估算（双显示，MB-22）
        h("div", { className: "koi-sec-title" }, "成本估算（随任一区改动即时重算）"),
        est ? h("div", { className: "koi-row", style: { flexDirection: "column", alignItems: "stretch" } },
          h("div", { className: "koi-hint" }, `本周估算：出号 ${est.weekly.predict} + 建议 ${est.weekly.advisory} = ${est.weekly.total} tokens（${est.basis}）`),
          h("div", { className: "koi-hint" }, `当前形态实际：${est.currentForm.weeklyTotal}/周（不随阵容变化）`),
          h("div", { className: "koi-hint" }, `M3 满配投影：${est.m3Projection.weeklyPredict}/周 ×${est.m3Projection.factor}（随阵容/权重变化，随 M3 编排器生效）`),
          h("div", { className: "koi-hint" }, `周预算占比：${(est.weekly.ratio * 100).toFixed(1)}%`)) : null,
        saveMsg ? h("div", { className: "koi-hint" }, saveMsg) : null);
    }

    function KoiSection() {
      useStyleOnce();
      const [st, setSt] = useState(null);
      const [err, setErr] = useState("");
      const [qp, setQp] = useState({});
      const [busy, setBusy] = useState("");
      const [showWizard, setShowWizard] = useState(false);
      const [tab, setTab] = useState("overview");
      const [donOpen, setDonOpen] = useState(false);
      const [readId, setReadId] = useState(readLastRead());
      const pollRef = useRef(null);
      const { events, lastId } = useEvents();
      const markRead = () => { const rid = lastId ?? (events.length ? events[events.length - 1].id : null); if (rid != null) { writeLastRead(rid); setReadId(rid) } };
      const winUnread = exports.__uiLogic.winUnreadCount(events, readId);

      const load = useCallback(async () => {
        try {
          const r = await fetch(`${API}/status`, { headers: { accept: "application/json" } });
          const j = await r.json().catch(() => ({}));
          if (!r.ok || j.ok === false) throw new Error(j.error || `HTTP ${r.status}`);
          setSt(j); setErr("");
        } catch (e) { setErr(String(e.message ?? e)); }
      }, []);

      useEffect(() => { load(); const t = setInterval(load, 30_000); return () => clearInterval(t); }, [load]);
      useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current); }, []);

      const startQuick = async (game) => {
        setBusy(game); setQp((s) => ({ ...s, [game]: { status: "running", message: null, error: null } }));
        try {
          const r = await fetch(`${API}/quickpick`, {
            method: "POST", headers: { "content-type": "application/json", accept: "application/json" },
            body: JSON.stringify({ game }),
          });
          const j = await r.json().catch(() => ({}));
          if (!r.ok || !j.ok) throw new Error(j.error || `HTTP ${r.status}`);
          if (pollRef.current) clearInterval(pollRef.current);
          pollRef.current = setInterval(async () => {
            try {
              const pr = await fetch(`${API}/quickpick?id=${encodeURIComponent(j.id)}`);
              const pj = await pr.json().catch(() => ({}));
              const job = pj.job;
              if (!job) return;
              setQp((s) => ({ ...s, [game]: { status: job.status, message: job.message, picksLine: job.picksLine, error: job.error } }));
              if (job.status !== "running") { clearInterval(pollRef.current); pollRef.current = null; setBusy(""); load(); }
            } catch { /* 下一轮再试 */ }
          }, 4_000);
        } catch (e) {
          setQp((s) => ({ ...s, [game]: { status: "error", message: null, error: String(e.message ?? e) } }));
          setBusy("");
        }
      };

      if (!st) {
        return h("div", { className: "koi" },
          h("h3", { className: "koi-title" }, "彩票 · 锦鲤"),
          err ? h("div", { className: "koi-err" }, err) : h("div", { className: "koi-intro" }, "读取中…"));
      }

      const metaOf = (k) => (st.allGames ?? []).find((x) => x.key === k) ?? {};
      const gameKeys = (st.allGames ?? []).map((x) => x.key);
      const red = st.events?.heartbeatRed === true;

      return h("div", { className: "koi" },
        h("h3", { className: "koi-title" }, "彩票 · 锦鲤",
          red ? h("span", { className: "koi-badge", title: "心跳红标：今日应有通知在全部启用渠道均无送达记录；渠道恢复后自动补发并清除" }, h("span", { className: "koi-red" }), "心跳告警") : null),
        h("div", { className: "koi-tabs" },
          h("button", { className: tab === "overview" ? "koi-btn" : "koi-btn2", onClick: () => setTab("overview") }, "概览"),
          h("button", { className: tab === "events" ? "koi-btn" : "koi-btn2", onClick: () => { setTab("events"); markRead(); } }, winUnread > 0 ? `事件（未读 ${winUnread}）` : "事件"),
          h("button", { className: tab === "settings" ? "koi-btn" : "koi-btn2", onClick: () => setTab("settings") }, "学习与设置")),
        tab === "overview" ? h("div", null,
          h("p", { className: "koi-intro" },
            `今天是 ${st.today}，开奖彩种：${(st.calendar ?? []).map((k) => metaOf(k).name || k).join("、") || "无"}。`,
            `通知渠道：${(st.channels ?? []).map((c) => c.type).join("、") || "无渠道"}。`,
            st.scheduler?.ok ? null : h("span", { className: "koi-err" }, " · 调度器未启动 ✗")),
          h("p", { className: "koi-intro" },
            "模拟账本：", st.ledgerText ?? "（空）",
            h("span", { className: "koi-badge" }, "口径：若每期正式预测都买")),
          showWizard ? h(Wizard, { st, onDone: load, onClose: () => setShowWizard(false) }) : null,
          gameKeys.map((k) => {
            const g = st.games?.[k] ?? {};
            const meta = metaOf(k);
            const q = qp[k] ?? {};
            const phaseText = PHASE_TEXT[g.phase] ?? g.phase;
            const modeText = MODE_TEXT[g.mode ?? "manual"];
            return h("div", { className: "koi-card", key: k },
              h("div", { className: "koi-card-head" },
                h("span", { className: "koi-name" }, `${meta.emoji ?? ""} ${meta.name ?? k}`,
                  h("span", { className: "koi-badge" }, g.spec ?? ""),
                  h("span", { className: "koi-badge" }, modeText)),
                h("span", { className: "koi-phase" }, phaseText + (g.pushErr ? ` · 通知见事件页：${g.pushErr}` : "") + (g.lastError ? ` · ${g.lastError}` : ""))),
              g.picksLine ? h("div", { className: "koi-picks" }, `${g.issue ? `第 ${g.issue} 期 · ` : ""}${g.picksLine}${g.via === "fallback" ? "（兜底号）" : ""}`) : null,
              h("div", { style: { display: "flex", gap: "8px", flexWrap: "wrap" } },
                h("button", { className: "koi-btn", onClick: () => startQuick(k), disabled: !!busy },
                  busy === k || q.status === "running" ? "她正在研究…（1–4 分钟）" : "现在来一注"),
                g.mode === "auto" ? null : h("button", { className: "koi-btn koi-btn2", onClick: () => setShowWizard(true), disabled: !!busy }, "开启自动模式（向导）")),
              q.error ? h("div", { className: "koi-err" }, q.error) : null,
              q.message ? h("div", { className: "koi-out" }, q.message) : null);
          }),
          err ? h("div", { className: "koi-err" }, err) : null,
          st.donation?.enabled !== false ? (() => {
            const don = st.donation ?? {};
            return h("div", { className: "koi-donation" },
              h("span", { className: "koi-don-line", title: "完全自愿 · 与功能无关 · 不发推送", onClick: () => setDonOpen(!donOpen) }, don.text ?? "🐟 请作者喝杯水"),
              donOpen ? h("div", { className: "koi-don-body" },
                don.image ? h("img", { src: don.image, alt: "donation", style: { maxWidth: 220, borderRadius: 8 } }) : null,
                don.link ? h("a", { href: don.link, target: "_blank", rel: "noreferrer", className: "koi-don-link" }, "爱发电 · 支持作者") : null,
                !don.image && !don.link ? h("span", { className: "koi-hint" }, "（收款方式待作者配置：koi.config.json 的 donation.image / donation.link）") : null) : null);
          })() : null) : null,
        tab === "events" ? h("div", null,
          h("div", { className: "koi-card" },
            h("div", { className: "koi-sec-title" }, `事件（最近 ${events.length} 条；失败原因/队列/心跳兜底全在此）`),
            h("div", { className: "koi-events" },
              events.slice(-50).reverse().map((e) => h("div", { className: "koi-evt", key: e.id },
                `[${e.kind}${e.status !== "sent" ? `·${e.status}` : ""}] ${e.body?.split("\n")[0] ?? ""}`))),
            events.length ? h("button", { className: "koi-btn koi-btn2", onClick: markRead }, "全部标为已读") : null,
            red ? h("div", { className: "koi-err" }, "心跳红标：今日应有通知在全部启用渠道均无送达记录——渠道恢复后自动补发并清除。") : null)) : null,
        tab === "settings" ? h("div", null,
          h("div", { className: "koi-card" }, h(DataArea, { st })),
          h("div", { className: "koi-card" }, h(LearningArea)),
          h("div", { className: "koi-card" }, h(FactorArea)),
          h("div", { className: "koi-card" }, h(ConfigPanel, { st, reload: load })),
          h("p", { className: "koi-intro" },
            "配置三入口等价：本面板 / 配置文件（路径见上） / CLI（koi.mjs config|mode|channels）；改完下一轮 tick 生效。",
            h("br"),
            "开奖是独立随机事件 —— 她研究得再认真也不改变概率，这条账本的价值在于诚实。")) : null);
    }

    // ── ui-logic 内联副本（MD-21；T-12 起由 tools/gen-ui-logic.mjs 机械生成，勿手改）──────────
    // >>> BEGIN GENERATED: lib/ui-logic.js（node tools/gen-ui-logic.mjs 生成，勿手改）
    exports.__uiLogic = (() => {
      // ── 向导门控状态机（S-102/S-116 五步：渠道→档位→时间→诚实条款→数据就绪）──────────
      const WIZARD_STEPS = [
        { key: 'channels', title: '通知渠道', desc: '至少启用一个可用渠道（桌宠面板渠道即算）' },
        { key: 'tier', title: '投注档位', desc: '在档位表里选一档（显示注数/价格）' },
        { key: 'time', title: '出号时间', desc: '默认 17:30，必须早于该彩种开奖时刻' },
        { key: 'honesty', title: '诚实条款', desc: '开奖是独立随机事件，本内容不改变中奖概率' },
        { key: 'data', title: '数据就绪', desc: '拉取近期开奖入库（秒—分钟级）；全量历史回拉见下方「数据」区' },
      ]

      /** 单步可否前进；stepBad = { channels, tier, time, honesty, data } 布尔集 */
      function wizardCanAdvance(stepIndex, stepBad = {}) {
        const step = WIZARD_STEPS[stepIndex]
        if (!step) return false
        return stepBad[step.key] !== true
      }

      /** 向导完成是否可置 mode=auto（全部五步通过；四项门控的 UI 面） */
      function wizardComplete(stepBad = {}) {
        return WIZARD_STEPS.every((s) => stepBad[s.key] !== true)
      }

      // ── 降级判定（MC-16 ②/MB-28 第一级：React 渲染壳缺席 ≠ 通知丢失）────────────────
      function degradeDecision({ reactDomAvailable = false, petEnabled = true, panelChannelEnabled = true } = {}) {
        if (petEnabled && reactDomAvailable) return { level: 'normal', removePetContainer: false, note: '桌宠正常挂载' }
        if (petEnabled && !reactDomAvailable) {
          return {
            level: 'panel-only',
            removePetContainer: true,
            note: '桌宠渲染组件不可用（已静默移除）：通知不丢——设置→彩票节的事件横幅、心跳红标与事件列表（/api/events）仍送达',
            panelChannelUnaffected: panelChannelEnabled,
          }
        }
        return { level: 'pet-off', removePetContainer: true, note: '桌宠已整体关闭（S-123：事件照常分发其他渠道）', panelChannelUnaffected: panelChannelEnabled }
      }

      // ── 红点未读游标（DC-102 窗口；localStorage 持久 lastReadId）────────────────────
      /** events（升序数组）中 lastReadId 之后的条数；游标不在窗口 → 全部计未读 */
      function unreadCount(events, lastReadId) {
        if (!Array.isArray(events) || events.length === 0) return 0
        if (!lastReadId) return events.length
        const i = events.findIndex((e) => e?.id === lastReadId)
        return i >= 0 ? events.length - 1 - i : events.length
      }

      /** 未读「中奖」战果数（主人 2026-10-25 拍板：只有中奖才通知——红点/冒泡/面板未读只统计 won===true 的战果） */
      function winUnreadCount(events, lastReadId) {
        if (!Array.isArray(events) || events.length === 0) return 0
        let start = 0
        if (lastReadId) {
          const i = events.findIndex((e) => e?.id === lastReadId)
          if (i >= 0) start = i + 1
        }
        return events.slice(start).filter((e) => e?.won === true).length
      }

      // ── 详略选择（DC-107 全局单档；拍板17/18）─────────────────────────────────────
      function verbosityChoice(current) {
        return current === 'chatty'
          ? { value: 'concise', label: '简洁', next: 'chatty', desc: '只号码 + 合规字段 + 诚实基调句' }
          : { value: 'chatty', label: '叨逼叨', next: 'concise', desc: '号码 + ≤100 字结构化摘要 + 合规字段' }
      }

      /** 事件冒泡预览行（桌宠消息卡标题）：标题 + 号码行（无 body 依赖） */
      function bubbleTitle(event) {
        if (!event) return ''
        const kindText = { predict: '出号', quickpick: '来一注', result: '战果', apology: '致歉', alert: '告警', advice: '建议', heartbeat: '心跳', test: '测试通知' }[event.kind] ?? '通知'
        const game = event.game ? `· ${event.game} ` : ''
        const issue = event.issue ? `第 ${event.issue} 期` : ''
        return `🐟 ${kindText} ${game}${issue}`.trim()
      }

      // ── 第二波：学习/数据/结论区文案与纯逻辑（docs/19 §6/§8；FR-1015/BC-112——文案即需求，
      //    常量定稿进设计防自由发挥；client.js 内联副本等价断言，MD-21）──────────────────────

      /** 上传页文案（§6 定稿原文；MA-25 正向断言口径） */
      const LEARNING_COPY = '📚 学习 = 严格回测检验：上传的技巧会先清洗拆成卡片，再用你的本地全量历史逐一回测。结论可能证明技巧无效——多数技巧的结论会是「与随机无异」，这会如实记录、不会美化。学习影响的是「我们知道的多少」，不改变中奖概率。'

      /** 上传控件旁提示（§6 定稿原文；FR-1013 收窄口径 W2A-04） */
      const UPLOAD_HINT = '支持 .txt / .md（≤20MB）；PDF/EPUB 请先转为文本（暂不支持直接解析）。'

      /** 结论页口径行（§6 定稿原文；每条结论恒拼） */
      const VERDICT_CALIBER = '口径：本地全量历史 N 期滚动回测 · 命中判据回测前预注册 · 基线=判据滞后自评满足率 · 单侧精确二项检验（α=0.05）。「与随机无异」= 命中率与随机基线无统计学差异。开奖是独立随机事件，回测结论不改变中奖概率，也不驱动任何自动行为。'

      /** 状态页待补文案（§6 定稿原文；S-119） */
      const PENDING_LLM_NOTE = '拆卡环节暂不可用（模型未就绪/超时）——已标『待补』，恢复后自动重试，绝不静默丢弃'

      /** 全量回拉确认框文案（§2.5 定稿原文；AC-108 计数口径） */
      const FULLBACKFILL_CONFIRM = '将从官方数据源全量回拉历史开奖（约 140–160 个请求、15–30 分钟，批间隔 2 秒；17:00–22:30 错峰窗口内不开始、跨入自动暂停待续；可随时中止，断点保留）。数据经四项校验后入本地库——已抓取的数据不会重复请求（异常中断重启至多重访一个小批次）。确定开始？'

      /** 体彩深翻提示注（docs/19 §13.3 未验证项③——面板如实显示） */
      const SPORTTERY_DEEP_NOTE = '注：体彩 pageNo 深翻（>2 页）行为未实测——真实全量首跑时请关注进度与错误提示（若中止，断点保留可续拉）。'

      /** 拒收原因拼装（§6 状态页定稿句式） */
      function rejectedNote(reasons) {
        return `拒收原因：${Array.isArray(reasons) ? reasons.join('；') : String(reasons ?? '')}（支持格式与上限见上）`
      }

      /** rule-dup 保守拒入提示（§4.5 三态；面板如实显示） */
      function ruleDupHint(existingName) {
        return `疑似重复被保守拒入（词法相似度 ≥0.8，与『${existingName}』）`
      }

      /** 结论档文案映射（离散档，禁百分比置信度——BC-007/W2-D05） */
      function verdictTextOf(verdict) {
        return verdict === 'better-in-sample' ? '样本内优于随机' : '与随机无异'
      }

      /** 上传格式校验（.txt/.md 白名单；S-118） */
      function uploadFormatOk(name) {
        const m = String(name ?? '').toLowerCase().match(/\.(txt|md)$/)
        return m ? { ok: true, ext: m[1] } : { ok: false, ext: null, error: UPLOAD_HINT }
      }

      /** 文件大小格式化 */
      function formatBytes(n) {
        const b = Number(n) || 0
        if (b < 1024) return `${b} B`
        if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`
        return `${(b / 1024 / 1024).toFixed(1)} MB`
      }

      /** 上传面 token 估算与周预算占比（§4.1，BC-107 补位：字节/12 保守口径，标注估算口径） */
      function uploadEstimate(bytes, weeklyCap) {
        const tokens = Math.max(0, Math.ceil(Number(bytes ?? 0) / 12))
        const cap = Number(weeklyCap) > 0 ? Number(weeklyCap) : 0
        return { tokens, pct: cap > 0 ? Number(((tokens / cap) * 100).toFixed(2)) : null, basis: '估算口径：字节/12' }
      }

      /** 回拉进度行（§2.4 诚实显示：已拉至 <最早期号>（N 期在库），非百分比——W2A-08） */
      function backfillProgressText(progressNote, countInStore) {
        if (!progressNote) return '尚未回拉'
        return countInStore != null ? `${progressNote}（${countInStore} 期在库）` : progressNote
      }

      /** 学习任务状态徽标文案（queued/cleaning/splitting/dedup/done/pending-llm/rejected + 等待标注） */
      function jobBadgeText(job) {
        const base = { queued: '排队中', cleaning: '清洗中', splitting: '拆卡中', dedup: '判重中', done: '完成', 'pending-llm': '待补', rejected: '已拒收' }[job?.status] ?? String(job?.status ?? '—')
        return job?.waitingNote ? `${base} · ${job.waitingNote}` : base
      }

      return { WIZARD_STEPS, wizardCanAdvance, wizardComplete, degradeDecision, unreadCount, winUnreadCount, verbosityChoice, bubbleTitle, LEARNING_COPY, UPLOAD_HINT, VERDICT_CALIBER, PENDING_LLM_NOTE, FULLBACKFILL_CONFIRM, SPORTTERY_DEEP_NOTE, rejectedNote, ruleDupHint, verdictTextOf, uploadFormatOk, formatBytes, uploadEstimate, backfillProgressText, jobBadgeText };
    })();
    // <<< END GENERATED

    const inject = ["slots"];
    const NS = "koi";

    function apply(ctx) {
      // 桌宠挂载（D-003）：设置节渲染之外，独立 root 挂 document.body；降级不炸。
      // 开关闭环（主人 2026-10-25 反馈）：启动读 pet.enabled（关=不挂载）；× 立即卸载并持久化；设置页可重开。
      exports.__petControl = {
        enable() { try { return mountPet(require, { onClosePet: () => unmountPet() }) } catch (e) { return { ok: false, error: String(e) } } },
        disable() { unmountPet() },
      };
      ctx.effect(() => {
        let disposed = false;
        (async () => {
          try {
            const r = await fetch(`${API}/status`, { headers: { accept: "application/json" } });
            const j = await r.json().catch(() => ({}));
            if (disposed) return;
            if (j.pet && j.pet.enabled === false) return; // 主人已关闭桌宠：不挂载（事件仍见面板与渠道）
          } catch { /* 状态不可得时按启用处理 */ }
          if (disposed) return;
          try {
            const r = exports.__petControl.enable();
            if (!r.ok) console.warn("[koi] 桌宠挂载降级（通知不丢，见设置→彩票事件区）：" + r.error);
          } catch (e) { console.warn("[koi] 桌宠挂载异常：" + String(e)); }
        })();
        return () => { disposed = true; unmountPet(); };
      }, "koi: pet");
      ctx.effect(
        () =>
          ctx.slots.inject("settings.section", () =>
            ctx.slots.register(
              { name: "settings.section", id: NS, order: 7, label: () => "彩票" },
              KoiSection,
            ),
            "koi: settings section",
          ),
        "koi: settings section",
      );
    }

    exports.apply = apply;
    exports.inject = inject;
    exports.KoiSection = KoiSection;
    exports.KoiPet = KoiPet;
    exports.mountPet = mountPet;
    exports.unmountPet = unmountPet;
    return module.exports;
  },
});
