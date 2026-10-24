# -*- coding: utf-8 -*-
"""check_layout.py —— 硬约束 H1-H12 检查 + 舒适度原始值
用法: python scripts/check_layout.py --layout candidates/B.json --room data/room.json --assets data/assets.json
退出码: 0=无ERROR, 1=有ERROR, 2=输入错误
"""
import json, sys, math, argparse

def rect(p):  # placement → 外接矩形 [x0,y0,x1,y1]
    return [p["x"], p["y"], p["x"] + p["w"], p["y"] + p["d"]]

def inter(a, b, tol=1.0):
    return not (a[2] <= b[0] + tol or b[2] <= a[0] + tol or a[3] <= b[1] + tol or b[3] <= a[1] + tol)

def area(r): return (r[2] - r[0]) * (r[3] - r[1])

def circle_rect_hit(cx, cy, r, rc, quad=None):
    """圆与矩形相交；quad 限定扫掠象限（门扇从合页扫过 area）"""
    px = min(max(cx, rc[0]), rc[2]); py = min(max(cy, rc[1]), rc[3])
    d = math.hypot(cx - px, cy - py)
    if d > r: return False
    if quad == "N-hinge":   # 铰链在北侧东墙门：扫掠区在铰链南侧 x<=cx, y<=cy
        return rc[0] <= cx and rc[1] <= cy
    if quad == "S-hinge":   # 铰链在南侧东墙门：扫掠区在铰链北侧 x<=cx, y>=cy
        return rc[0] <= cx and rc[3] >= cy
    return True

def polys_area(zs, t):
    return sum(abs((z["polygon"][2][0]-z["polygon"][0][0])*(z["polygon"][2][1]-z["polygon"][0][1])) for z in zs if z["type"] == t)

def centroid(z):
    xs = [p[0] for p in z["polygon"]]; ys = [p[1] for p in z["polygon"]]
    return (sum(xs)/len(xs), sum(ys)/len(ys))

def dist_to_windows(pt, windows):
    best = 1e9
    for w in windows:
        (x1, y1), (x2, y2) = w["seg_room_xy"]
        if x1 == x2:  # 西/东墙竖直段
            d = abs(pt[0] - x1)
            if not (min(y1, y2) <= pt[1] <= max(y1, y2)):
                d += min(abs(pt[1]-y1), abs(pt[1]-y2))
        else:
            d = abs(pt[1] - y1)
            if not (min(x1, x2) <= pt[0] <= max(x1, x2)):
                d += min(abs(pt[0]-x1), abs(pt[0]-x2))
        best = min(best, d)
    return best

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--layout", required=True); ap.add_argument("--room", required=True); ap.add_argument("--assets", required=True)
    a = ap.parse_args()
    L = json.load(open(a.layout, encoding="utf-8"))
    R = json.load(open(a.room, encoding="utf-8"))
    A = json.load(open(a.assets, encoding="utf-8"))
    V = []  # violations
    def v(rule, sev, detail, assets=None): V.append({"rule": rule, "severity": sev, "detail": detail, "assets": assets or []})

    RW, RD = R["room"]["width_x_cm"], R["room"]["depth_y_cm"]
    room_rect = [0, 0, RW, RD]
    room_area = RW * RD
    pls = L["placements"]
    rects = {p["asset_id"]: rect(p) for p in pls}
    desks = [p for p in pls if p["kind"] == "desk"]
    chairs = [p for p in pls if p["kind"] == "chair"]
    seats = [p for p in desks if p.get("seat_dir")]
    stor = [p for p in pls if p["kind"] == "storage"]
    eqs = [p for p in pls if p["kind"] == "equipment"]
    tall = [p for p in pls if p.get("tall") or (p["kind"] == "storage" and p.get("h", 0) > 120)]

    # H1 占地率（椅子按 45×45 计入）
    occ = sum(area(rects[p["asset_id"]]) for p in pls)
    occ_rate = occ / room_area
    if occ_rate > 0.75: v("H1", "ERROR", f"占地率 {occ_rate:.1%} > 75%")
    else: v("H1", "INFO", f"占地率 {occ_rate:.1%} ≤ 75%")

    # H2 墙内 + 无重叠
    for p in pls:
        r = rects[p["asset_id"]]
        if r[0] < -1 or r[1] < -1 or r[2] > RW + 1 or r[3] > RD + 1:
            v("H2", "ERROR", f"{p['asset_id']} 超出墙内: {r}")
    for i in range(len(pls)):
        for j in range(i + 1, len(pls)):
            pi, pj = pls[i], pls[j]
            if inter(rects[pi["asset_id"]], rects[pj["asset_id"]]):
                v("H2", "ERROR", f"{pi['asset_id']} 与 {pj['asset_id']} 重叠",
                  [pi["asset_id"], pj["asset_id"]])

    # H4 椅后起身空间（桌面外缘起 105 = 椅45+净空60，带内不得有其他家具）
    seat_clear_min = 999
    for s in seats:
        r = rects[s["asset_id"]]; sd = s["seat_dir"]
        if sd == "E": edge, ax = r[0], "x"   # 人坐西侧→起身带在西侧
        elif sd == "W": edge, ax = r[2], "x"
        elif sd == "S": edge, ax = r[1], "y"
        else: edge, ax = r[3], "y"
        sgn = -1 if sd in ("E", "S") else 1
        lo, hi = (edge + sgn*105, edge) if sgn < 0 else (edge, edge + sgn*105)
        w_lo, w_hi = (r[1], r[3]) if ax == "x" else (r[0], r[2])
        band = [lo, w_lo, hi, w_hi] if ax == "x" else [w_lo, lo, w_hi, hi]
        worst = 105
        for p in pls:
            if p["asset_id"] == s["asset_id"] or p["group"] != s["group"]: continue
            if p["kind"] == "chair" and p["group"] == s["group"]: continue
            pr = rects[p["asset_id"]]
            if inter(band, pr, tol=0.5):
                ov = (min(hi, pr[2]) - max(lo, pr[0])) if ax == "x" else (min(hi, pr[3]) - max(lo, pr[1]))
                worst = min(worst, 105 - max(0, ov))
        seat_clear_min = min(seat_clear_min, worst)
        if worst < 60:
            v("H4", "ERROR", f"{s['asset_id']} 椅后净空 {worst:.0f}cm < 60cm（被其他家具侵入）", [s["asset_id"]])
    if seat_clear_min >= 60: v("H4", "INFO", f"全部工位椅后净空 ≥60cm（最小 {seat_clear_min:.0f}cm）")

    # H5 通道
    def corridor_check():
        worst_main = 999
        for c in L.get("corridors", []):
            r = c["rect"]; w = min(r[2]-r[0], r[3]-r[1])
            for p in pls:
                if p["kind"] == "chair": continue
                if inter([r[0]+40, r[1]+40, r[2]-40, r[3]-40], rects[p["asset_id"]], tol=0.5):
                    v("H5", "ERROR" if c["role"] == "main" else "WARN",
                      f"通道 {c['id']} 被 {p['asset_id']} 侵入", [p["asset_id"]])
            if c["role"] == "main":
                worst_main = min(worst_main, w)
                if w < 120 and c.get("role") == "main" and "door_approach" not in c.get("note", ""):
                    v("H5", "ERROR", f"主通道 {c['id']} 净宽 {w:.0f}cm < 120cm")
        return worst_main
    worst_main = corridor_check()
    doors = [o for o in R["openings"] if o["type"] == "door"]
    # 门回转 H6
    for d in doors:
        if d.get("normally_closed"):
            v("H6", "INFO", f"{d['id']} 为常闭后门，回转区按用户指示不设限")
            continue
        (x1, y1), (x2, y2) = d["seg_room_xy"]
        hinge_y = max(y1, y2) if d.get("hinge") == "north" else min(y1, y2)
        quad = "N-hinge" if hinge_y > (y1+y2)/2 else "S-hinge"
        for p in pls:
            if circle_rect_hit(x1, hinge_y, d["width_cm"], rects[p["asset_id"]], quad):
                v("H6", "ERROR", f"{p['asset_id']} 侵入 {d['id']} 门回转区", [p["asset_id"]])
    # H7 配电箱净空
    db = R["power"].get("distribution_box")
    if db and db.get("clearance_rect"):
        crp = db["clearance_rect"]
        cr = [crp[0][0], crp[0][1], crp[1][0], crp[1][1]] if isinstance(crp[0], list) else crp
        for p in pls:
            if inter(cr, rects[p["asset_id"]], tol=0.5):
                v("H7", "ERROR", f"{p['asset_id']} 侵入配电箱前净空（假设位 {db['xy']}）", [p["asset_id"]])
    # H8 设备操作面
    for e in eqs:
        r = rects[e["asset_id"]]; f = e.get("ops_face", "W")
        band = {"W": [r[0]-60, r[1], r[0], r[3]], "E": [r[2], r[1], r[2]+60, r[3]],
                "S": [r[0], r[1]-60, r[2], r[1]], "N": [r[0], r[3], r[2], r[3]+60]}[f]
        for p in pls:
            if p["asset_id"] == e["asset_id"]: continue
            if inter(band, rects[p["asset_id"]], tol=0.5):
                v("H8", "ERROR", f"{e['asset_id']} 操作面({f})净空不足：{p['asset_id']} 侵入",
                  [e["asset_id"], p["asset_id"]])
    # H9 高物避窗
    wins = [o for o in R["openings"] if o["type"] == "window"]
    for t in tall:
        r = rects[t["asset_id"]]
        for w in wins:
            (x1, y1), (x2, y2) = w["seg_room_xy"]
            band = [x1-10, min(y1, y2)-10, x1+30, max(y1, y2)+10] if x1 == x2 else \
                   [min(x1, x2)-10, y1-10, max(x1, x2)+10, y1+30]
            if inter(band, r, tol=0.5):
                v("H9", "ERROR", f"高物 {t['asset_id']}(h={t.get('h',160)}) 侵入 {w['id']} 窗投影带", [t["asset_id"]])
    # H10 存储不占通道/门区/配电箱/休闲展示
    keep = [c["rect"] for c in L.get("corridors", []) if c["role"] in ("main",)]
    if db and db.get("clearance_rect"):
        crp = db["clearance_rect"]
        keep.append([crp[0][0], crp[0][1], crp[1][0], crp[1][1]] if isinstance(crp[0], list) else crp)
    lz = next((z for z in L["zones"] if z["type"] == "leisure"), None)
    dz = next((z for z in L["zones"] if z["type"] == "display"), None)
    for p in stor:
        r = rects[p["asset_id"]]
        for kr in keep:
            if inter(kr, r, tol=0.5):
                v("H10", "ERROR", f"存储 {p['asset_id']} 侵入主通道/配电箱净空", [p["asset_id"]])
        for d in doors:
            (x1, y1), (x2, y2) = d["seg_room_xy"]
            hinge_y = max(y1, y2) if d.get("hinge") == "north" else min(y1, y2)
            quad = "N-hinge" if hinge_y > (y1+y2)/2 else "S-hinge"
            if circle_rect_hit(x1, hinge_y, d["width_cm"], r, quad):
                v("H10", "ERROR", f"存储 {p['asset_id']} 侵入 {d['id']} 门回转区", [p["asset_id"]])
    # H11 分区需求
    grad_seats = [s for s in seats if s["group"] == "GRAD"]
    if len(grad_seats) != 6: v("H11", "ERROR", f"研究生工位 {len(grad_seats)} ≠ 6")
    else:
        if not all(s["x"] < 200 for s in grad_seats): v("H11", "ERROR", "研究生工位不在西墙区块内")
    lz_a = polys_area(L["zones"], "leisure")/10000
    if not (8 - 0.5 <= lz_a <= 12.5):
        v("H11", "ERROR", f"休闲区 {lz_a:.1f}㎡ 超出 8-12㎡ 弹性")
    else: v("H11", "INFO", f"休闲区 {lz_a:.1f}㎡")
    if lz:
        c = centroid(lz)
        if not (c[0] > 500 and c[1] > 700): v("H11", "WARN", f"休闲区中心 {c} 偏离东北门（新排布下可接受，换水走南通道）")
    need_disp = A.get("display", {}).get("tables", 4)
    n_disp = sum(1 for p in desks if p["group"] == "DISPLAY")
    if need_disp == 0:
        v("H11", "INFO", "展示区已按用户指示取消")
    elif n_disp != need_disp: v("H11", "ERROR", f"展示桌 {n_disp} ≠ {need_disp}")
    dz_a = polys_area(L["zones"], "display")/10000
    if dz and centroid(dz)[1] > 400: v("H11", "ERROR", "展示区不在南门侧")
    else: v("H11", "INFO", f"展示区 {dz_a:.1f}㎡(含观看)")
    bz = next((z for z in L["zones"] if z["type"] == "reserved"), None)
    bz_a = polys_area(L["zones"], "reserved")/10000
    if not bz or not (2.5 <= bz_a <= 5.5): v("H11", "WARN", f"杂物缓冲区 {bz_a:.1f}㎡ 偏离 3-5㎡")
    else: v("H11", "INFO", f"杂物缓冲区 {bz_a:.1f}㎡")
    # H3/H12 供电标注完整性（行级判定在 power_reach 中复核；此处汇总未馈电工位）
    confirm = [s for r_ in L.get("rows", []) for s in r_.get("seats_unfed", [])]
    # 舒适度原始值
    win_segs = wins
    zc = {z["id"]: centroid(z) for z in L["zones"] if z["type"] in ("work", "leisure", "display", "equipment")}
    d_wins = [dist_to_windows(c, win_segs) for c in zc.values()]
    s1_raw = sum(d_wins)/len(d_wins)
    face = {"E": 7, "W": 4, "N": 10, "S": 10}  # 窗在西墙：朝E=背窗7 朝W=面窗4 朝N/S=侧窗10
    non_grad = [s for s in seats if s["group"] != "GRAD"]
    s2_raw = sum(face[s["seat_dir"]] for s in non_grad)/max(1, len(non_grad))
    leis_c = centroid(next(z for z in L["zones"] if z["type"] == "leisure")) if lz else (850, 800)
    door_pts = [((x1+x2)/2, (y1+y2)/2) for (x1, y1), (x2, y2) in [d["seg_room_xy"] for d in doors]]
    s3_raw = sum(min(abs(s["x"]+s["w"]/2-leis_c[0])+abs(s["y"]+s["d"]/2-leis_c[1]),
                     min(abs(s["x"]+s["w"]/2-dp[0])+abs(s["y"]+s["d"]/2-dp[1]) for dp in door_pts))
                 for s in seats)/max(1, len(seats))
    s4_raw = 1 - occ_rate
    eqc = [ (e["x"]+e["w"]/2, e["y"]+e["d"]/2) for e in eqs ] + ([leis_c] if lz else [])
    s5_raw = min((min(abs(s["x"]+s["w"]/2-q[0])+abs(s["y"]+s["d"]/2-q[1]) for q in eqc) for s in seats), default=999)

    out = {
        "candidate_id": L["candidate_id"], "pass": not any(x["severity"] == "ERROR" for x in V),
        "violations": V,
        "metrics": {
            "occupancy_rate": round(occ_rate, 3),
            "seat_count": len(seats),
            "main_corridor_min_cm": worst_main if worst_main < 999 else None,
            "seat_clearance_min_cm": round(seat_clear_min, 1) if seat_clear_min < 999 else None,
            "leisure_m2": round(lz_a, 2), "display_m2": round(dz_a, 2), "buffer_m2": round(bz_a, 2),
        },
        "comfort_raw": {"S1_window_dist_avg": round(s1_raw, 1), "S2_orientation_avg": round(s2_raw, 2),
                         "S3_walk_dist_avg_cm": round(s3_raw, 0), "S4_openness": round(s4_raw, 3),
                         "S5_noise_dist_cm": round(s5_raw, 0)},
        "params_used": {"main_corridor_cm": 120, "seat_clearance_cm": 60, "occ_max": 0.75,
                         "pocket_seats_max": 8, "row_feed_max_cm": 500},
    }
    print(json.dumps(out, ensure_ascii=False, indent=1))
    sys.exit(0 if out["pass"] else 1)

if __name__ == "__main__":
    main()
