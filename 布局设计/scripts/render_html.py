# -*- coding: utf-8 -*-
"""render_html.py —— 候选布局渲染：candidates/{A,B,C}.html + 候选对比.html + 会话预览 fragment
用法: python scripts/render_html.py
"""
import json, os, subprocess, sys, math

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(BASE, "candidates")
VIZ = r"C:\Users\10170\.zcode\v2\visualizations\c32cf1871cab5645c74f5458ba8d8fafee8e5278f607466a0bbb532f5f6a9023"

RW, RD = 900, 1320
S = 0.5          # cm → px
OX, OY = 55, 45  # 边距

COLORS = {
    "work": "#4e8fd9", "grad": "#7b61c4", "leisure": "#3ba272", "display": "#d9924e",
    "equipment": "#b05fc0", "storage": "#8a7a55", "reserved": "#a0a0a0",
    "GROUP": {"IND": "#4e8fd9", "JAVA": "#2f7fbf", "AI": "#5aa2e0", "EMB": "#6f9fd8",
              "GRAD": "#7b61c4", "DISPLAY": "#d9924e", "LEIS": "#3ba272", "EQ": "#b05fc0", "STORE": "#8a7a55"},
}

def tx(x): return OX + x * S
def ty(y): return OY + (RD - y) * S

def svg_plan(cand, pw):
    """SVG 平面图"""
    e = []
    # 分区
    for z in cand["zones"]:
        pts = " ".join(f"{tx(p[0])},{ty(p[1])}" for p in z["polygon"])
        c = COLORS[z["type"]]
        dash = ' stroke-dasharray="6 4"' if z["type"] == "reserved" else ""
        e.append(f'<polygon points="{pts}" fill="{c}" fill-opacity="0.13" stroke="{c}" stroke-width="1.5"{dash}/>')
        cx = sum(p[0] for p in z["polygon"])/len(z["polygon"]); cy = sum(p[1] for p in z["polygon"])/len(z["polygon"])
        e.append(f'<text x="{tx(cx)}" y="{ty(cy)}" font-size="11" fill="{c}" text-anchor="middle" font-weight="600">{z["label"]}</text>')
    # 主通道虚线中心线
    for c in cand.get("corridors", []):
        if c["role"] != "main": continue
        r = c["rect"]
        if r[2]-r[0] >= r[3]-r[1]:
            e.append(f'<line x1="{tx(r[0])}" y1="{ty((r[1]+r[3])/2)}" x2="{tx(r[2])}" y2="{ty((r[1]+r[3])/2)}" stroke="#c9a227" stroke-width="1.2" stroke-dasharray="10 6" opacity="0.7"/>')
        else:
            e.append(f'<line x1="{tx((r[0]+r[2])/2)}" y1="{ty(r[1])}" x2="{tx((r[0]+r[2])/2)}" y2="{ty(r[3])}" stroke="#c9a227" stroke-width="1.2" stroke-dasharray="10 6" opacity="0.7"/>')
    # 家具
    for p in cand["placements"]:
        x0, y0, x1, y1 = p["x"], p["y"], p["x"]+p["w"], p["y"]+p["d"]
        X0, Y0, X1, Y1 = tx(x0), ty(y1), tx(x1), ty(y0)
        k = p["kind"]; g = p["group"]
        unfed = any(p["asset_id"] in r.get("seats_unfed", []) for r in cand["rows"])
        if k == "chair":
            e.append(f'<rect x="{X0}" y="{Y0}" width="{(x1-x0)*S}" height="{(y1-y0)*S}" rx="4" fill="{COLORS["GROUP"].get(g,"#999")}" fill-opacity="0.35" stroke="none"><title>椅 {p["asset_id"]}</title></rect>')
            continue
        fill = COLORS["GROUP"].get(g, "#999")
        stroke_w = 2.2 if unfed else 1
        stroke = "#d43f3f" if unfed else "#555"
        extra = ""
        if p.get("tall"): extra = ' stroke-dasharray="4 2"'
        e.append(f'<rect x="{X0}" y="{Y0}" width="{(x1-x0)*S}" height="{(y1-y0)*S}" fill="{fill}" fill-opacity="{0.85 if k=="desk" else 0.5}" stroke="{stroke}" stroke-width="{stroke_w}"{extra}><title>{p["asset_id"]} {p["w"]}×{p["d"]}{" ⚠需电工确认" if unfed else ""}</title></rect>')
        if k == "desk" and (x1-x0)*S > 30 and (y1-y0)*S > 26:
            short = g[:2] if g not in ("DISPLAY",) else "展"
            e.append(f'<text x="{(X0+X1)/2}" y="{(Y0+Y1)/2+4}" font-size="10" fill="#fff" text-anchor="middle" pointer-events="none">{short}</text>')
        if unfed:
            e.append(f'<text x="{(X0+X1)/2}" y="{Y0-3}" font-size="12" fill="#d43f3f" text-anchor="middle" font-weight="700">⚠</text>')
        if k == "equipment":
            e.append(f'<text x="{(X0+X1)/2}" y="{(Y0+Y1)/2+4}" font-size="10" fill="#fff" text-anchor="middle" pointer-events="none">{"设A" if "1" in p["asset_id"] else "设B"}</text>')
        if p["asset_id"].startswith("WATER"):
            e.append(f'<text x="{(X0+X1)/2}" y="{(Y0+Y1)/2+4}" font-size="9" fill="#fff" text-anchor="middle" pointer-events="none">饮</text>')
    # 门窗
    for o in [(0,54),(0,512),(0,970)]:
        e.append(f'<line x1="{tx(o[0])}" y1="{ty(o[1]+296)}" x2="{tx(o[0])}" y2="{ty(o[1])}" stroke="#3b82c4" stroke-width="5"/>')
    for dy in [(1165,1265),(55,155)]:
        e.append(f'<line x1="{tx(900)}" y1="{ty(dy[1])}" x2="{tx(900)}" y2="{ty(dy[0])}" stroke="#c94f4f" stroke-width="5"/>')
        hinge = dy[1] if dy[1] == 1265 else dy[0]
        flip = -1 if hinge == 1265 else 1
        e.append(f'<path d="M {tx(900)} {ty(hinge)} A {100*S} {100*S} 0 0 {0 if flip<0 else 1} {tx(800)} {ty(hinge)}" fill="none" stroke="#c94f4f" stroke-width="1" stroke-dasharray="4 3"/>')
        e.append(f'<line x1="{tx(900)}" y1="{ty(hinge)}" x2="{tx(800)}" y2="{ty(hinge)}" stroke="#c94f4f" stroke-width="1.5"/>')
    # 电位孔 + 配电箱
    for pid, xy in [("P-W1",(0,905)),("P-W2",(0,540)),("P-S1",(240,0)),("P-S2",(500,0)),("P-N1",(660,1320)),("P-N2",(420,1320)),("P-E1",(900,870)),("P-E2",(900,585))]:
        n = len(pw["pocket_load"][ {"P-W1":2,"P-W2":4,"P-S1":2,"P-S2":2,"P-N1":2,"P-N2":2,"P-E1":0,"P-E2":0}[pid] ]["seats"]) if False else 0
        e.append(f'<circle cx="{tx(xy[0])}" cy="{ty(xy[1])}" r="5" fill="#e03131" stroke="#fff" stroke-width="1.2"><title>{pid} 10A五孔(2位)</title></circle>')
        dx = 12 if xy[0] < 450 else -34
        dy2 = -8 if xy[1] > 660 else 12
        e.append(f'<text x="{tx(xy[0])+dx}" y="{ty(xy[1])+dy2}" font-size="10" fill="#e03131" font-weight="600">{pid}</text>')
    dbx, dby = (pw["wiring"].get("db_xy") or (None, None))
    if dbx is not None:
        e.append(f'<rect x="{tx(dbx)-40*S}" y="{ty(dby)-20*S}" width="{80*S}" height="{20*S}" fill="none" stroke="#e8a013" stroke-width="1.5" stroke-dasharray="5 3"/><title>配电箱(假设位)前1m净空</title>')
        e.append(f'<rect x="{tx(dbx)-8}" y="{ty(dby)-8}" width="16" height="16" fill="#e8a013" stroke="#fff" stroke-width="1"><title>配电箱 DB1（位置假设，待电工确认）</title></rect>')
        e.append(f'<text x="{tx(dbx)-46}" y="{ty(dby)+4}" font-size="10" fill="#e8a013" text-anchor="end">DB?</text>')
    # 房间轮廓 + 指北
    e.append(f'<rect x="{tx(0)}" y="{ty(1320)}" width="{RW*S}" height="{RD*S}" fill="none" stroke="#333" stroke-width="2.5"/>')
    e.append(f'<text x="{tx(450)}" y="{ty(1320)-8}" font-size="11" fill="#666" text-anchor="middle">北 ↑  9.0m</text>')
    e.append(f'<text x="{tx(-30)}" y="{ty(660)}" font-size="11" fill="#666" text-anchor="middle" transform="rotate(-90 {tx(-30)} {ty(660)})">西(窗) ← 13.2m → 东(两门)</text>')
    e.append(f'<text x="{tx(450)}" y="{ty(0)+16}" font-size="11" fill="#666" text-anchor="middle">南 9.0m</text>')
    return f'<svg viewBox="0 0 {OX*2+RW*S} {OY*2+RD*S}" style="width:100%;max-width:560px" role="img" aria-label="布局平面图">{"".join(e)}</svg>'

LEGEND = """
<div style="display:flex;flex-wrap:wrap;gap:10px;font-size:12px;margin:6px 0">
 <span><span style="display:inline-block;width:12px;height:12px;background:#4e8fd9"></span> 工业</span>
 <span><span style="display:inline-block;width:12px;height:12px;background:#2f7fbf"></span> java</span>
 <span><span style="display:inline-block;width:12px;height:12px;background:#5aa2e0"></span> ai</span>
 <span><span style="display:inline-block;width:12px;height:12px;background:#6f9fd8"></span> 嵌入式</span>
 <span><span style="display:inline-block;width:12px;height:12px;background:#7b61c4"></span> 研究生</span>
 <span><span style="display:inline-block;width:12px;height:12px;background:#d9924e"></span> 展示</span>
 <span><span style="display:inline-block;width:12px;height:12px;background:#3ba272"></span> 休闲</span>
 <span><span style="display:inline-block;width:12px;height:12px;background:#b05fc0"></span> 设备</span>
 <span><span style="display:inline-block;width:12px;height:12px;background:#8a7a55"></span> 存储</span>
 <span><span style="display:inline-block;width:12px;height:12px;background:#e03131;border-radius:50%"></span> 电位孔10A</span>
 <span><span style="display:inline-block;width:12px;height:12px;background:#e8a013"></span> 配电箱(假设)</span>
 <span><span style="display:inline-block;width:12px;height:2px;background:#c9a227"></span> 主通道</span>
 <span style="color:#d43f3f">⚠ = 需电工确认</span>
</div>"""

def scorecard(all_raw, cand_id, pw, chk):
    """归一化评分卡"""
    skip_w = pw.get("skip_wiring")
    dims = [("S1 采光均匀度", "S1_window_dist_avg", 0.20, "low"),
            ("S2 工位朝向", "S2_orientation_avg", 0.25, "high"),
            ("S3 公共点步行", "S3_walk_dist_avg_cm", 0.25, "low"),
            ("S4 开放感", "S4_openness", 0.20, "high"),
            ("S5 噪音距离", "S5_noise_dist_cm", 0.10, "high")]
    vals = {d[0]: {c: all_raw[c][d[1]] for c in all_raw} for d in dims}
    rows, total = [], 0
    for name, key, w, better in dims:
        vs = vals[name]; lo, hi = min(vs.values()), max(vs.values())
        sc = {}
        for c, v in vs.items():
            sc[c] = 10.0 if hi == lo else (10*(hi-v)/(hi-lo) if better == "low" else 10*(v-lo)/(hi-lo))
        unit = {"S1_window_dist_avg":"cm","S2_orientation_avg":"/10","S3_walk_dist_avg_cm":"cm","S4_openness":"","S5_noise_dist_cm":"cm"}[key]
        s = sc[cand_id]
        total += s*w
        rows.append(f"<tr><td>{name}</td><td class='num'>{vs[cand_id]:.1f}{unit}</td><td class='num'>{s:.1f}</td><td class='num'>{w:.2f}</td></tr>")
    conf = len(pw["electrician_confirm_seats"])
    wiring_rows = ("<tr><td colspan=4 style='color:#888'>走线/电位由电工统一考虑（按用户要求，布局不建模）</td></tr>"
                   if skip_w else f"""
    <tr><td>走线 W1 干线转弯</td><td class='num'>{pw['wiring']['turns_total']}</td><td colspan=2>{'少' if pw['wiring']['turns_total']<=6 else '中'}</td></tr>
    <tr><td>走线 W2 对齐率</td><td class='num'>{min(pw['wiring']['alignment_ratio'].values()):.0%}~</td><td colspan=2>✓</td></tr>
    <tr><td>走线 W3 岛⊥进线</td><td class='num'>{pw['wiring']['island_orientation_pass']}/{pw['wiring']['island_orientation_total']}</td><td colspan=2>{'部分(南北墙馈电与长轴平行)'}</td></tr>
    <tr><td>走线 W4 压线冲突</td><td class='num'>{len(pw['wiring']['conduit_conflicts'])}</td><td colspan=2>{'✓' if not pw['wiring']['conduit_conflicts'] else '△ 明线情形需架顶/暗线'}</td></tr>""")
    hard = f"""
    <tr><td colspan=4 style="background:#f5f0e0"><b>硬指标</b></td></tr>
    <tr><td>工位数</td><td class='num'>{chk['metrics']['seat_count']} / 44</td><td colspan=2>{'✓' if chk['metrics']['seat_count']==44 else '✗ 缺口 '+str(44-chk['metrics']['seat_count'])}</td></tr>
    <tr><td>需电工确认</td><td class='num'>{conf} 座</td><td colspan=2>{'✓ 全部现有电位覆盖' if conf==0 else '⚠ ' + ','.join(pw['electrician_confirm_seats'])}</td></tr>
    <tr><td>休闲区</td><td class='num'>{chk['metrics']['leisure_m2']}㎡</td><td colspan=2>{'✓' if 7.5<=chk['metrics']['leisure_m2']<=12.5 else '✗ 应8–12㎡'}</td></tr>
    <tr><td>杂物缓冲</td><td class='num'>{chk['metrics']['buffer_m2']}㎡</td><td colspan=2>{'✓' if 2.5<=chk['metrics']['buffer_m2']<=5.5 else '△'}</td></tr>
    <tr><td>主通道最窄</td><td class='num'>{chk['metrics']['main_corridor_min_cm']}cm</td><td colspan=2>{'✓ ≥120' if (chk['metrics']['main_corridor_min_cm'] or 0)>=120 else '✗'}</td></tr>
    <tr><td>占地率</td><td class='num'>{chk['metrics']['occupancy_rate']:.1%}</td><td colspan=2>✓ ≤75%</td></tr>{wiring_rows}"""
    tbl = f"<table class='score'><tr><th>维度</th><th>原始值</th><th>得分</th><th>权重</th></tr>{''.join(rows)}{hard}</table>"
    return tbl, total

CSS = """
body{font-family:'Microsoft YaHei',system-ui,sans-serif;margin:24px;max-width:1180px;color:#222;background:#fafafa}
h1{font-size:22px} h2{font-size:17px;margin:18px 0 6px}
.tabs{display:flex;gap:6px;margin:14px 0}
.tabs button{padding:7px 18px;border:1px solid #bbb;background:#fff;border-radius:6px;cursor:pointer;font-size:14px}
.tabs button.on{background:#2f6db4;color:#fff;border-color:#2f6db4}
.panel{display:none;background:#fff;border:1px solid #ddd;border-radius:10px;padding:18px}
.panel.on{display:block}
.flex{display:flex;gap:24px;flex-wrap:wrap;align-items:flex-start}
.score{border-collapse:collapse;font-size:13px;min-width:340px}
.score td,.score th{border-bottom:1px solid #e3e3e3;padding:5px 10px;text-align:left}
.score .num{text-align:right;font-variant-numeric:tabular-nums}
.total{font-size:16px;margin:8px 0}
.note{font-size:12px;color:#666;margin:6px 0}
table.loads{border-collapse:collapse;font-size:12px}
.loads td,.loads th{border:1px solid #ddd;padding:3px 8px}
.badge{display:inline-block;padding:2px 8px;border-radius:10px;font-size:12px;color:#fff}
"""

def page(title, tabs_html, body):
    return f"""<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>{title}</title><style>{CSS}</style></head>
<body>{tabs_html}{body}</body></html>"""

def run(cmd):
    r = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", cwd=BASE)
    return json.loads(r.stdout)

def main():
    data = {}
    for c in "ABCDEFG":
        cand = json.load(open(os.path.join(OUT, f"{c}.json"), encoding="utf-8"))
        chk = run([sys.executable, "scripts/check_layout.py", "--layout", f"candidates/{c}.json", "--room", "data/room.json", "--assets", "data/assets.json"])
        if c == "D":
            pw = {"skip_wiring": True, "electrician_confirm_seats": [],
                  "pocket_load": [{"pocket_id": p["id"], "seat_count": 0, "diversified_watts": 0, "note": "电位规格/延线由电工统一考虑", "seats": []} for p in json.load(open(os.path.join(BASE, "data", "room.json"), encoding="utf-8"))["power"]["outlet_pockets"]],
                  "wiring": {"turns_total": 0, "alignment_ratio": {"-": 1}, "island_orientation_pass": 0,
                             "island_orientation_total": 0, "conduit_conflicts": [], "db_xy": None}}
        else:
            pw = run([sys.executable, "scripts/power_reach.py", "--layout", f"candidates/{c}.json", "--room", "data/room.json", "--assets", "data/assets.json"])
        data[c] = (cand, chk, pw)
    all_raw = {c: d[1]["comfort_raw"] for c, d in data.items()}

    # 单候选页
    for c, (cand, chk, pw) in data.items():
        tbl, total = scorecard(all_raw, c, pw, chk)
        loads = "<table class='loads'><tr><th>电位孔</th><th>工位数</th><th>折算功率</th><th>备注</th></tr>" + "".join(
            f"<tr><td>{p['pocket_id']}</td><td>{p['seat_count']}</td><td>{p['diversified_watts']}W</td><td>{p['note']}</td></tr>"
            for p in pw["pocket_load"] if p["seat_count"] or p["note"]) + "</table>"
        feeds = ("<p class='note'>走线与馈电由电工统一考虑（按用户要求，布局不建模）；电位孔位置仅作图面参考。</p>"
                 if not cand["rows"] else
                 "<ul style='font-size:12.5px'>" + "".join(
            f"<li>{r['row_id']}: " + "；".join(f"{f['pocket']} 馈 {len(f['seats'])} 座（{f['feed_len_cm']:.0f}cm）" for f in r["feeds"])
            + (f"；<b style='color:#d43f3f'>⚠ {','.join(r['seats_unfed'])} 需电工确认</b>" if r["seats_unfed"] else "") + "</li>"
            for r in cand["rows"]) + "</ul>")
        status = "✅ 全部硬约束通过" if chk["pass"] else "❌ 未通过（见评分卡红项）"
        body = f"""
<div class="panel on"><h1>候选{c}：{cand['name']} <span class="badge" style="background:{'#2f9e44' if chk['pass'] else '#c92a2a'}">{status}</span></h1>
<p class="note">{cand['concept']}</p>
<div class="flex"><div>{svg_plan(cand, pw)}{LEGEND}</div>
<div style="flex:1;min-width:330px"><h2>评分卡（软评分 10 分制）</h2>{tbl}<p class="total">软评分合计：<b>{total:.2f}</b> / 10（仅供对比，硬指标优先）</p>
<h2>行馈电方案</h2>{feeds}<h2>电位孔负载</h2>{loads}</div></div></div>"""
        open(os.path.join(OUT, f"{c}.html"), "w", encoding="utf-8").write(page(f"候选{c} {cand['name']}", "", body))

    # 对比页（tab）
    tabs = "<div class='tabs' id='tb'>" + "".join(f"<button data-p='p{c}' class='{'on' if c=='G' else ''}'>候选{c} {data[c][0]['name']}</button>" for c in "ABCDEFG") + "</div>"
    panels = ""
    for c, (cand, chk, pw) in data.items():
        tbl, total = scorecard(all_raw, c, pw, chk)
        conf = len(pw["electrician_confirm_seats"])
        loads = "<table class='loads'><tr><th>电位孔</th><th>工位</th><th>功率</th></tr>" + "".join(
            f"<tr><td>{p['pocket_id']}</td><td>{p['seat_count']}</td><td>{p['diversified_watts']}W</td></tr>"
            for p in pw["pocket_load"] if p["seat_count"]) + "</table>"
        feeds = "<ul style='font-size:12.5px'>" + "".join(
            f"<li>{r['row_id']}: " + "；".join(f"{f['pocket']}×{len(f['seats'])}（{f['feed_len_cm']:.0f}cm）" for f in r["feeds"])
            + (f"；<b style='color:#d43f3f'>⚠ {','.join(r['seats_unfed'])} 需电工确认</b>" if r["seats_unfed"] else "") + "</li>"
            for r in cand["rows"]) + "</ul>"
        status = "✅ 硬约束通过" if chk["pass"] else "❌ 未通过"
        panels += f"""
<div class="panel {'on' if c=='G' else ''}" id="p{c}"><h2>候选{c}：{cand['name']} <span class="badge" style="background:{'#2f9e44' if chk['pass'] else '#c92a2a'}">{status}</span></h2>
<p class="note">{cand['concept']}</p>
<div class="flex"><div>{svg_plan(cand, pw)}{LEGEND}</div>
<div style="flex:1;min-width:330px">{tbl}<p class="total">软评分合计：<b>{total:.2f}</b>/10</p><h2>行馈电</h2>{feeds}<h2>电位孔负载</h2>{loads}</div></div></div>"""
    js = """<script>document.getElementById('tb').addEventListener('click',e=>{
 if(e.target.tagName!=='BUTTON')return;
 document.querySelectorAll('#tb button').forEach(b=>b.classList.toggle('on',b===e.target));
 document.querySelectorAll('.panel').forEach(p=>p.classList.toggle('on',p.id===e.target.dataset.p));});</script>"""
    open(os.path.join(OUT, "候选对比.html"), "w", encoding="utf-8").write(page("候选对比", tabs, panels + js))
    print("OK:", ", ".join(f"{c}.html" for c in "ABC"), "+ 候选对比.html")

    # 会话内预览 fragment（复用对比页主体，包装成 fragment 规范）
    if os.path.isdir(VIZ):
        frag = f"""<div id="lab-candidates" style="font-family:var(--font-family,inherit)">
<style>
#lab-candidates .tabs{{display:flex;gap:6px;margin:10px 0;flex-wrap:wrap}}
#lab-candidates .lp{{padding:6px 14px;border:1px solid var(--border);background:transparent;color:var(--foreground);border-radius:8px;cursor:pointer;font-size:13px}}
#lab-candidates .lp.on{{background:var(--primary);color:var(--primary-foreground);border-color:var(--primary)}}
#lab-candidates .panel{{display:none}}
#lab-candidates .panel.on{{display:block}}
#lab-candidates .flex{{display:flex;gap:20px;flex-wrap:wrap;align-items:flex-start}}
#lab-candidates table{{border-collapse:collapse;font-size:12px;color:var(--foreground)}}
#lab-candidates td,#lab-candidates th{{border-bottom:1px solid var(--border);padding:4px 8px;text-align:left}}
#lab-candidates .num{{text-align:right;font-variant-numeric:tabular-nums}}
#lab-candidates .legend{{display:flex;flex-wrap:wrap;gap:8px;font-size:11.5px;color:var(--foreground);margin:4px 0}}
#lab-candidates .legend span{{display:inline-flex;align-items:center;gap:4px}}
#lab-candidates .sw{{width:11px;height:11px;display:inline-block;border-radius:2px}}
</style>
{tabs.replace("class='tabs' id='tb'", "class='tabs' id='lc-tb'").replace("class='", "class='lp ").replace("lp on'", "lp on'")}
{panels.replace("class='badge'", "class='lc-badge'")}
<script>
document.getElementById('lc-tb').addEventListener('click',e=>{{
 if(e.target.tagName!=='BUTTON')return;
 document.querySelectorAll('#lc-tb button').forEach(b=>b.classList.toggle('on',b===e.target));
 document.querySelectorAll('#lab-candidates .panel').forEach(p=>p.classList.toggle('on',p.id===e.target.dataset.p));}});
</script></div>"""
        frag = frag.replace("<span class=\"badge\" style=\"background:", "<span class=\"lc-badge\" style=\"background:")
        frag = frag.replace(".badge", ".lc-badge")
        open(os.path.join(VIZ, "lab-layout-candidates.html"), "w", encoding="utf-8").write(frag)
        print("fragment OK")

if __name__ == "__main__":
    main()
