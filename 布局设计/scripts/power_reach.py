# -*- coding: utf-8 -*-
"""power_reach.py —— 供电可达性复验 + 走线友好度 (W1-W4) + 评分卡原始值
用法: python scripts/power_reach.py --layout candidates/B.json --room data/room.json --assets data/assets.json
退出码: 0=全部工位有供电方案或已标注, 1=存在未标注的不可达, 2=输入错误
"""
import json, sys, math, argparse

def manhattan(a, b): return abs(a[0]-b[0]) + abs(a[1]-b[1])

DB_XY = None  # 从 room.json 读

def wall_path_turns(a, b):
    """沿墙脚路径 a→b（都在墙面上），返回 (长度, 转弯数)。房间 900×1320。"""
    corners = [(0, 0), (900, 0), (900, 1320), (0, 1320)]
    # 同墙: 直接
    if a[0] == b[0] or a[1] == b[1]:
        return manhattan(a, b), 0
    best = (1e9, 99)
    for c in corners:
        # a→角→b，要求两段都贴墙（共坐标分量）
        if (a[0] == c[0] or a[1] == c[1]) and (c[0] == b[0] or c[1] == b[1]):
            L = manhattan(a, c) + manhattan(c, b)
            if L < best[0]: best = (L, 1)
    for c1 in corners:
        for c2 in corners:
            if c1 == c2: continue
            if (a[0] == c1[0] or a[1] == c1[1]) and (c1[0] == c2[0] or c1[1] == c2[1]) \
               and (c2[0] == b[0] or c2[1] == b[1]):
                L = manhattan(a, c1) + manhattan(c1, c2) + manhattan(c2, b)
                if L < best[0]: best = (L, 2)
    return best

def rect(p): return [p["x"], p["y"], p["x"]+p["w"], p["y"]+p["d"]]

def inter(a, b, tol=1.0):
    return not (a[2] <= b[0]+tol or b[2] <= a[0]+tol or a[3] <= b[1]+tol or b[3] <= a[1]+tol)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--layout", required=True); ap.add_argument("--room", required=True); ap.add_argument("--assets", required=True)
    a = ap.parse_args()
    L = json.load(open(a.layout, encoding="utf-8"))
    R = json.load(open(a.room, encoding="utf-8"))
    A = json.load(open(a.assets, encoding="utf-8"))
    pk = {p["id"]: p for p in R["power"]["outlet_pockets"]}
    db = R["power"].get("distribution_box") or {}
    db_xy = tuple(db.get("xy", (830, 1320)))
    seats = {p["asset_id"]: p for p in L["placements"] if p["kind"] == "desk" and p.get("seat_dir")}
    problems = []

    # 逐座供电表
    per_seat, per_unfed = [], []
    pocket_seats = {k: [] for k in pk}
    for r in L["rows"]:
        for f in r.get("feeds", []):
            for sid in f["seats"]:
                pocket_seats[f["pocket"]].append(sid)
                per_seat.append({"seat_id": sid, "pocket_id": f["pocket"], "row": r["row_id"],
                                 "path_len_cm": round(f["feed_len_cm"], 0), "tap": "走线槽分接",
                                 "reachable": True, "method": f["method"]})
        for sid in r.get("seats_unfed", []):
            per_unfed.append({"seat_id": sid, "row": r["row_id"],
                              "reason": "周边电位孔容量已满或延线超 500cm", "action": "需电工确认(改造新增电位)"})
    # 设备/饮水机固定占用（容量在生成器已预留，此处展示）
    fixed = {"P-E1": ["饮水机(10A)", "16A预留位"], "P-E2": ["EQ-1", "EQ-2"]}

    # 容量与负荷复验
    pocket_load = []
    for pid, p in pk.items():
        n = len(pocket_seats[pid])
        watts = n * 120 * 0.5
        if pid == "P-E1": watts += 600  # 饮水机常开
        if pid == "P-E2": watts += 1000  # EQ1+EQ2 (不常开，极端同开)
        bits = math.ceil(max(n, 1) / 4)
        ok = n <= 8 and watts <= bits * 1500 + 1
        pocket_load.append({"pocket_id": pid, "seats": pocket_seats[pid], "seat_count": n,
                            "diversified_watts": round(watts), "within_limit": ok,
                            "note": (fixed.get(pid) and "固定占用: " + ",".join(fixed[pid])) or ""})
        if not ok: problems.append(f"{pid} 过载: {n}工位 {watts:.0f}W")

    # W1 干线（配电箱→各被引用孔，沿墙脚）
    used_pockets = sorted({f["pocket"] for r in L["rows"] for f in r.get("feeds", [])} | set(fixed))
    turns_detail, turns_total = [], 0
    for pid in used_pockets:
        xy = (pk[pid]["x"], pk[pid]["y"]) if "x" in pk[pid] else tuple(pk[pid]["xy"])
        Lp, t = wall_path_turns(db_xy, xy)
        turns_total += t
        turns_detail.append({"pocket": pid, "turns": t, "path_len_cm": Lp})
    # W2 对齐率
    groups = {}
    for p in L["placements"]:
        if p["kind"] == "desk" and p["group"] in ("IND", "EMB", "JAVA", "AI", "GRAD", "DISPLAY"):
            groups.setdefault(p["group"], []).append(p)
    align = {}
    for g, ps in groups.items():
        if len(ps) < 2: align[g] = 1.0; continue
        xs = sorted(set((p["x"], p["w"]) for p in ps))
        aligned = sum(1 for p in ps if any(abs(p["x"]-x) < 3 and p["w"] == w for x, w in xs if (x, w) != (p["x"], p["w"])))
        align[g] = round(max(aligned / len(ps), 1 - 1/len(ps)), 2) if len(ps) > 1 else 1.0
    # 简化：行内同宽同列即对齐——按组统计主 x 边占比
    align2 = {}
    for g, ps in groups.items():
        from collections import Counter
        cx = Counter(p["x"] for p in ps).most_common(1)[0][1]
        align2[g] = round(cx / len(ps), 2)
    # W3 岛朝向：行长轴(y) vs 馈电孔墙法线
    island_ori = []
    for r in L["rows"]:
        for f in r.get("feeds", []):
            wall = pk[f["pocket"]]["wall"]
            long_axis = "N-S"
            feed_axis = {"north": "N-S", "south": "N-S", "east": "E-W", "west": "E-W"}[wall]
            ok = long_axis != feed_axis
            island_ori.append({"row": r["row_id"], "long_axis": long_axis, "feed_wall": wall, "ok": ok})
    # W4 贴墙高物 vs 墙脚线管带（仅统计干线沿墙段）
    conflicts = []
    foot = 30
    for pid in used_pockets:
        wall = pk[pid]["wall"]
        # 干线从配电箱到该孔的沿墙路径上的墙脚带
        for t in turns_detail:
            if t["pocket"] != pid: continue
        xy = (pk[pid]["x"], pk[pid]["y"]) if "x" in pk[pid] else tuple(pk[pid]["xy"])
        if wall == "north":
            band = [min(db_xy[0], xy[0]), 1320-foot, max(db_xy[0], xy[0]), 1320]
        elif wall == "south":
            band = [min(0, xy[0]) , 0, max(900, xy[0]), foot] if xy[0] < db_xy[0] else [xy[0], 0, 900, foot]
            band = [min(xy[0], 900), 0, max(xy[0], 0), foot]
        else:
            continue
        for p in L["placements"]:
            if p.get("tall") and p["kind"] == "storage" and inter(band, rect(p), tol=0.5):
                conflicts.append({"pocket": pid, "asset": p["asset_id"], "note": "高物压墙脚线管带（明线情形），暗线/架顶走线可解"})
    w4 = len(conflicts)

    out = {
        "candidate_id": L["candidate_id"],
        # 有条件通过：所有工位要么有馈电方案，要么已显式标注"需电工确认"；无过载；W4 压线冲突单列
        "pass": not problems,
        "per_seat": per_seat, "per_seat_unreachable": per_unfed,
        "pocket_load": pocket_load,
        "wiring": {
            "db_xy": list(db_xy), "db_assumed": bool(db.get("assumed")),
            "turns_total": turns_total, "turns_detail": turns_detail,
            "alignment_ratio": align2,
            "island_orientation_pass": sum(1 for o in island_ori if o["ok"]),
            "island_orientation_total": len(island_ori),
            "island_orientation_detail": island_ori,
            "conduit_conflicts": conflicts,
        },
        "electrician_confirm_seats": [u["seat_id"] for u in per_unfed],
    }
    print(json.dumps(out, ensure_ascii=False, indent=1))
    sys.exit(0 if out["pass"] else 1)

if __name__ == "__main__":
    main()
