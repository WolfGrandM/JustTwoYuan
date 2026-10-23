/**
 * dsh-koi —— 客户端半边：DSH「设置」里的 **彩票** section（v1 极简版）
 *
 * 主人 2026-10-23 定的范围：只要「现在来一注」按钮，不做完整设置页/历史页。
 * 所以这一页只有：
 *   · 今天开什么 + 每个彩种当前状态一行
 *   · 每个彩种一张卡：最新号 + 「现在来一注」按钮（点了显示她的完整推送正文）
 *   · 「测试推送」按钮（第一次装必点：手机收到 = NapCat 通道通 ✓）
 *   · 模拟账本一行摘要
 * 配置都在服务器 ~/.dsh/koi.config.json 里改（页面上不提供编辑）。
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
    ].join("");

    const PHASE_TEXT = {
      off: "今天不开",
      idle: "等待 17:30 出号",
      predicted: "号已出，推送中…",
      pushed: "已推送 ✓ 等开奖",
      settled: "已对账 ✓",
      failed: "今天出号失败",
      skipped: "今天没赶上",
    };

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

    function KoiSection() {
      useStyleOnce();
      const [st, setSt] = useState(null);
      const [err, setErr] = useState("");
      const [qp, setQp] = useState({});     // game → { status, message, picksLine, error }
      const [busy, setBusy] = useState(""); // game | 'test'
      const [testMsg, setTestMsg] = useState("");
      const pollRef = useRef(null);

      const load = useCallback(async () => {
        try {
          const r = await fetch(`${API}/status`, { headers: { accept: "application/json" } });
          const j = await r.json().catch(() => ({}));
          if (!r.ok || j.ok === false) throw new Error(j.error || `HTTP ${r.status}`);
          setSt(j); setErr("");
        } catch (e) { setErr(String(e.message ?? e)); }
      }, []);

      useEffect(() => { load(); const t = setInterval(load, 30_000); return () => clearInterval(t); }, [load]);

      // 加餐任务轮询（组件卸载时停掉）
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

      const testPush = async () => {
        setBusy("test"); setTestMsg("");
        try {
          const r = await fetch(`${API}/test-push`, { method: "POST", headers: { accept: "application/json" } });
          const j = await r.json().catch(() => ({}));
          setTestMsg(j.detail ?? (j.ok ? "已发出 ✓" : "失败"));
        } catch (e) { setTestMsg(String(e.message ?? e)); }
        finally { setBusy(""); }
      };

      if (!st) {
        return h("div", { className: "koi" },
          h("h3", { className: "koi-title" }, "彩票 · 锦鲤"),
          err ? h("div", { className: "koi-err" }, err) : h("div", { className: "koi-intro" }, "读取中…"));
      }

      const metaOf = (k) => (st.allGames ?? []).find((x) => x.key === k) ?? {};
      const gameKeys = (st.allGames ?? []).map((x) => x.key);

      return h("div", { className: "koi" },
        h("h3", { className: "koi-title" }, "彩票 · 锦鲤"),
        h("p", { className: "koi-intro" },
          `今天是 ${st.today}，开奖彩种：${(st.calendar ?? []).map((k) => metaOf(k).name || k).join("、") || "无"}。`,
          `每个开奖日 17:30 左右她研究完会私聊推送（QQ ${st.pushTargetMasked ?? ""}），22:00 起自动对账报战果。`,
          h("br"),
          `推送通道：${st.push?.detail ?? "未知"}`,
          st.scheduler?.ok ? null : h("span", { className: "koi-err" }, " · 调度器未启动 ✗")),
        h("p", { className: "koi-intro" },
          "模拟账本：", st.ledgerText ?? "（空）",
          h("span", { className: "koi-badge" }, "口径：若每期正式预测都买")),

        gameKeys.map((k) => {
          const g = st.games?.[k] ?? {};
          const meta = metaOf(k);
          const q = qp[k] ?? {};
          const phaseText = PHASE_TEXT[g.phase] ?? g.phase;
          return h("div", { className: "koi-card", key: k },
            h("div", { className: "koi-card-head" },
              h("span", { className: "koi-name" }, `${meta.emoji ?? ""} ${meta.name ?? k}`,
                h("span", { className: "koi-badge" }, g.spec ?? "")),
              h("span", { className: "koi-phase" }, phaseText + (g.pushErr ? ` · 推送失败：${g.pushErr}` : "") + (g.lastError ? ` · ${g.lastError}` : ""))),
            g.picksLine ? h("div", { className: "koi-picks" }, `${g.issue ? `第 ${g.issue} 期 · ` : ""}${g.picksLine}${g.via === "fallback" ? "（兜底号）" : ""}`) : null,
            h("div", { style: { display: "flex", gap: "8px" } },
              h("button", { className: "koi-btn", onClick: () => startQuick(k), disabled: !!busy },
                busy === k || q.status === "running" ? "她正在研究…（1–4 分钟）" : "现在来一注"),
              k === gameKeys[0]
                ? h("button", { className: "koi-btn koi-btn2", onClick: testPush, disabled: !!busy }, busy === "test" ? "发送中…" : "测试推送")
                : null),
            q.error ? h("div", { className: "koi-err" }, q.error) : null,
            q.message ? h("div", { className: "koi-out" }, q.message) : null,
            testMsg && k === gameKeys[0] ? h("div", { className: q.ok === false ? "koi-err" : "koi-intro" }, testMsg) : null);
        }),

        err ? h("div", { className: "koi-err" }, err) : null,
        h("p", { className: "koi-intro" },
          "配置（人设 / 出号时间 / 彩种开关 / 推送 QQ）在服务器 ",
          h("code", null, st.configPath ?? "~/.dsh/koi.config.json"),
          " 里改；改完下一轮 tick 生效，不用重启。",
          h("br"),
          "开奖是独立随机事件 —— 她研究得再认真也不改变概率，这条账本的价值在于诚实。"));
    }

    const inject = ["slots"];
    const NS = "koi";

    function apply(ctx) {
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
    return module.exports;
  },
});
