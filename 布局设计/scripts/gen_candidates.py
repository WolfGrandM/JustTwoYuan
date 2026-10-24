# -*- coding: utf-8 -*-
"""生成候选布局 A/B/C → candidates/*.json（含行馈电分配）
坐标系：原点西南角，x 向东 0-900，y 向北 0-1320，单位 cm。
A=全沿墙直排基线（预期摆不下）；B=规整岛式；C=岛式北移开放变体。
馈电模型：10A 五孔=2位×4工位=8工位/孔；行端馈电≤500cm；研究生行走线槽分接。
"""
import json, os, copy

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(BASE, "candidates")
os.makedirs(OUT, exist_ok=True)

STD = {"w": 80, "d": 60, "h": 74}
CHAIR = 45

# 电位孔（room.json 同步）：xy + 容量（已扣固定占用）
POCKETS = {
    "P-E1": {"xy": (900, 870),  "cap": 6, "res": "饮水机+16A预留"},
    "P-E2": {"xy": (900, 585),  "cap": 6, "res": "EQ1+EQ2 各占1位"},
    "P-W1": {"xy": (0, 905),    "cap": 8, "res": ""},
    "P-W2": {"xy": (0, 540),    "cap": 8, "res": ""},
    "P-S1": {"xy": (240, 0),    "cap": 8, "res": ""},
    "P-S2": {"xy": (500, 0),    "cap": 8, "res": ""},
    "P-N1": {"xy": (660, 1320), "cap": 8, "res": ""},
    "P-N2": {"xy": (420, 1320), "cap": 8, "res": ""},
}

def P(asset_id, kind, group, x, y, w, d, rot=0, seat_dir=None, extra=None):
    if rot in (90, 270):
        w, d = d, w  # w/d 一律存旋转后的实际占地
    p = {"asset_id": asset_id, "kind": kind, "group": group,
         "x": x, "y": y, "w": w, "d": d, "rot": rot}
    if seat_dir: p["seat_dir"] = seat_dir
    if extra: p.update(extra)
    return p

def row_y(prefix, group, n, x, y0, seat_dir, pitch=80):
    """沿 y 轴 n 工位（桌 80×60 竖放）+ 椅；E=人坐桌西朝东，W=人坐桌东朝西"""
    out = []
    for k in range(n):
        y = y0 + k * pitch
        out.append(P(f"{prefix}-{k+1}", "desk", group, x, y, 80, 60, rot=90, seat_dir=seat_dir))
        cx = x - 45 if seat_dir == "E" else x + 60
        out.append(P(f"{prefix}-C{k+1}", "chair", group, cx, y + 17, CHAIR, CHAIR))
    return out

GRAD_YS = [546, 618, 690, 762, 834, 911]  # 南→北；电位槽 534-546 / 899-911
def grad_row():
    out = []
    for i, y in enumerate(GRAD_YS):
        out.append(P(f"G-GRAD-{i+1}", "desk", "GRAD", 0, y, 65, 45, rot=90, seat_dir="W"))
        out.append(P(f"G-GRAD-C{i+1}", "chair", "GRAD", 45, y + 10, CHAIR, CHAIR))
    return out

DISPLAY_TABLES = lambda: [
    P("DISP-T1", "desk", "DISPLAY", 230, 0, 120, 45),
    P("DISP-T2", "desk", "DISPLAY", 361, 0, 110, 50),
    P("DISP-T3", "desk", "DISPLAY", 482, 0, 110, 50),
    P("DISP-T4", "desk", "DISPLAY", 603, 0, 160, 60),
]

def manhattan(a, b): return abs(a[0]-b[0]) + abs(a[1]-b[1])

def _greedy(rows_order, caps0):
    caps = dict(caps0); used = {k: [] for k in POCKETS}; rows_out = []
    for r in rows_order:
        r = dict(r); r["feeds"] = []; unfed = []
        if r.get("slot_feed"):
            ends = r["ends"]; n = len(r["seats"])
            half_s = r["seats"][: n * 2 // 3] if len(ends) > 1 else r["seats"]
            half_n = [s for s in r["seats"] if s not in half_s]
            for grp, pocket, end in ((half_s, r["prefs"][0], ends[0]), (half_n, r["prefs"][-1], ends[-1])):
                if not grp: continue
                d = manhattan(end, POCKETS[pocket]["xy"])
                if d <= 500 and caps[pocket] >= len(grp):
                    caps[pocket] -= len(grp); used[pocket] += grp
                    r["feeds"].append({"pocket": pocket, "seats": grp, "feed_len_cm": d, "method": "现有电位孔延线(槽位分接)"})
                else:
                    unfed += grp
        else:
            remaining = list(r["seats"])
            for pref in r["prefs"]:
                if not remaining: break
                end = min(r["ends"], key=lambda e: manhattan(e, POCKETS[pref]["xy"]))
                d = manhattan(end, POCKETS[pref]["xy"])
                take = min(len(remaining), caps[pref])
                if d > 500 or take == 0: continue
                grp = remaining[:take]; remaining = remaining[take:]
                caps[pref] -= take; used[pref] += grp
                r["feeds"].append({"pocket": pref, "seats": grp, "feed_len_cm": d, "method": "现有电位孔延线(行端馈电)"})
            unfed += remaining
        r["seats_unfed"] = unfed
        rows_out.append(r)
    return rows_out, used, caps

def assign_feeds(rows):
    """全排列择优：穷举行处理顺序，取 未馈电数最少、其次最大馈距最短 的方案"""
    import itertools
    caps0 = {k: v["cap"] for k, v in POCKETS.items()}
    slot = [r for r in rows if r.get("slot_feed")]
    free = [r for r in rows if not r.get("slot_feed")]
    best = None
    for perm in itertools.permutations(free):
        rows_out, used, caps = _greedy(slot + list(perm), caps0)
        n_unfed = sum(len(r["seats_unfed"]) for r in rows_out)
        max_len = max((f["feed_len_cm"] for r in rows_out for f in r["feeds"]), default=0)
        key = (n_unfed, max_len)
        if best is None or key < best[0]:
            best = (key, rows_out, used, caps)
    _, rows_out, used, caps = best
    return rows_out, used, caps

def finalize(cand):
    cand["rows"], used, caps = assign_feeds(cand["rows"])
    cand["pocket_usage"] = {k: {"seats": v, "cap": POCKETS[k]["cap"]} for k, v in used.items()}
    path = os.path.join(OUT, f"{cand['candidate_id']}.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(cand, f, ensure_ascii=False, indent=1)
    seats = sum(1 for p in cand["placements"] if p["kind"] == "desk" and p.get("seat_dir"))
    unfed = sum(len(r["seats_unfed"]) for r in cand["rows"])
    print(f"{cand['candidate_id']}: {seats} seats ({unfed} 需电工确认) → {path}")
    return cand

def base_common():
    return grad_row()

def candidate_B():
    pl = base_common()
    pl += row_y("G-IND", "IND", 10, 195, 320, "E")
    pl += row_y("G-EMB", "EMB", 9, 255, 400, "W")
    pl += row_y("G-JAVA", "JAVA", 10, 485, 320, "E")
    pl.append(P("G-JAVA-L", "desk", "JAVA", 485, 200, 120, 45, rot=90, seat_dir="E"))
    pl.append(P("G-JAVA-LC", "chair", "JAVA", 440, 237, CHAIR, CHAIR))
    pl += row_y("G-AI", "AI", 8, 545, 480, "W")
    pl.append(P("S-SHELF-1", "storage", "STORE", 130, 1260, 200, 60, extra={"tall": True}))
    pl.append(P("S-SHELF-2", "storage", "STORE", 426, 1260, 200, 60, extra={"tall": True}))
    pl.append(P("S-SHELF-3", "storage", "STORE", 60, 60, 200, 60, rot=90, extra={"tall": True}))
    pl += [P("S-CAB-1", "storage", "STORE", 15, 0, 100, 50),
           P("S-CAB-2", "storage", "STORE", 125, 0, 100, 50),
           P("S-CAB-3", "storage", "STORE", 20, 1260, 100, 50),
           P("S-CAB-4", "storage", "STORE", 15, 1030, 100, 50)]
    pl += [P("EQ-1", "equipment", "EQ", 790, 170, 120, 60, rot=90, extra={"ops_face": "W"}),
           P("EQ-2", "equipment", "EQ", 780, 320, 150, 100, rot=90, extra={"ops_face": "W"})]
    pl += [P("WATER", "leisure", "LEIS", 855, 850, 33, 33),
           P("LEIS-S1", "chair", "LEIS", 810, 600, CHAIR, CHAIR),
           P("LEIS-S2", "chair", "LEIS", 810, 950, CHAIR, CHAIR)]
    pl += DISPLAY_TABLES()
    zones = [
        {"id": "Z-WORK", "type": "work", "label": "四组工位岛", "polygon": [[150, 200], [695, 200], [695, 1120], [150, 1120]]},
        {"id": "Z-GRAD", "type": "grad", "label": "研究生区(西墙窗带)", "polygon": [[0, 515], [150, 515], [150, 1000], [0, 1000]]},
        {"id": "Z-LEIS", "type": "leisure", "label": "休闲/茶水 7.8㎡", "polygon": [[780, 480], [900, 480], [900, 1130], [780, 1130]]},
        {"id": "Z-DISP", "type": "display", "label": "成果展示+观看", "polygon": [[230, 0], [780, 0], [780, 230], [230, 230]]},
        {"id": "Z-EQ", "type": "equipment", "label": "公共设备区", "polygon": [[780, 155], [900, 155], [900, 470], [780, 470]]},
        {"id": "Z-STORE", "type": "storage", "label": "存储(北墙)", "polygon": [[130, 1260], [626, 1260], [626, 1320], [130, 1320]]},
        {"id": "Z-BUF", "type": "reserved", "label": "杂物缓冲 3.5㎡", "polygon": [[60, 1130], [350, 1130], [350, 1250], [60, 1250]]},
    ]
    corridors = [
        {"id": "M1", "role": "main", "rect": [780, 1130, 900, 1265], "note": "东北门通道段"},
        {"id": "M2", "role": "main", "rect": [360, 1130, 780, 1250], "note": "北横主通道 120"},
        {"id": "M3", "role": "main", "rect": [650, 60, 780, 1130], "note": "东纵主通道 130"},
        {"id": "M4", "role": "door_approach", "rect": [780, 55, 900, 155], "note": "东南门进深段(门宽100)"},
        {"id": "S1c", "role": "secondary", "rect": [360, 200, 440, 1130], "note": "岛间次过道 80"},
        {"id": "S2c", "role": "secondary", "rect": [90, 515, 150, 1000], "note": "研究生过道 60+"},
    ]
    rows = [
        {"row_id": "R-JLONG", "seats": ["G-JAVA-L"], "ends": [[507, 320], [507, 200]], "prefs": ["P-S2", "P-N2", "P-N1"]},
        {"row_id": "R-IND", "seats": [f"G-IND-{i}" for i in range(1, 11)], "ends": [[225, 320], [225, 1120]], "prefs": ["P-S1", "P-N2", "P-S2"]},
        {"row_id": "R-EMB", "seats": [f"G-EMB-{i}" for i in range(1, 10)], "ends": [[285, 400], [285, 1120]], "prefs": ["P-N2", "P-S1", "P-S2"]},
        {"row_id": "R-AI", "seats": [f"G-AI-{i}" for i in range(1, 9)], "ends": [[575, 480], [575, 1120]], "prefs": ["P-N1", "P-E2", "P-E1"]},
        {"row_id": "R-JAVA", "seats": [f"G-JAVA-{i}" for i in range(1, 11)], "ends": [[515, 320], [515, 1120]], "prefs": ["P-S2", "P-N1", "P-N2"]},
        {"row_id": "R-GRAD", "seats": [f"G-GRAD-{i}" for i in range(1, 7)], "ends": [[22, 546], [22, 976]], "prefs": ["P-W2", "P-W1"], "slot_feed": True},
    ]
    return {"candidate_id": "B", "name": "规整岛式（紧凑共享过道）",
            "concept": "两组背靠背双面岛纵贯中部（y320..1120），长轴南北；东墙带状设备+休闲；北墙存储；南墙展示。工位紧凑、岛长轴⊥东墙进线。",
            "placements": pl, "zones": zones, "corridors": corridors, "rows": rows,
            "misc_unplaced": ["空余剩 2×65×45 作机动杂物台面（不占位）", "椅子若干按工位+2 配"]}

def candidate_C():
    pl = base_common()
    pl += row_y("G-IND", "IND", 10, 195, 170, "E")
    pl += row_y("G-EMB", "EMB", 9, 255, 250, "W")
    pl += row_y("G-JAVA", "JAVA", 10, 485, 170, "E")
    pl.append(P("G-JAVA-L", "desk", "JAVA", 485, 50, 120, 45, rot=90, seat_dir="E"))
    pl.append(P("G-JAVA-LC", "chair", "JAVA", 440, 70, CHAIR, CHAIR))
    pl += row_y("G-AI", "AI", 8, 545, 330, "W")
    pl.append(P("S-SHELF-1", "storage", "STORE", 130, 1260, 200, 60, extra={"tall": True}))
    pl.append(P("S-SHELF-2", "storage", "STORE", 426, 1260, 200, 60, extra={"tall": True}))
    pl.append(P("S-SHELF-3", "storage", "STORE", 60, 970, 200, 60, rot=90, extra={"tall": True}))
    pl += [P("S-CAB-1", "storage", "STORE", 15, 0, 100, 50),
           P("S-CAB-2", "storage", "STORE", 125, 0, 100, 50),
           P("S-CAB-3", "storage", "STORE", 20, 1260, 100, 50),
           P("S-CAB-4", "storage", "STORE", 0, 1180, 100, 50)]
    pl += [P("EQ-1", "equipment", "EQ", 430, 1000, 120, 60, extra={"ops_face": "N"}),
           P("EQ-2", "equipment", "EQ", 310, 1000, 150, 100, rot=90, extra={"ops_face": "W"})]
    pl += [P("WATER", "leisure", "LEIS", 855, 990, 33, 33),
           P("LEIS-S1", "chair", "LEIS", 790, 1000, CHAIR, CHAIR),
           P("LEIS-S2", "chair", "LEIS", 790, 1080, CHAIR, CHAIR)]
    pl += DISPLAY_TABLES()
    zones = [
        {"id": "Z-WORK", "type": "work", "label": "四组工位岛", "polygon": [[150, 50], [650, 50], [650, 1070], [150, 1070]]},
        {"id": "Z-GRAD", "type": "grad", "label": "研究生区(西墙窗带)", "polygon": [[0, 515], [150, 515], [150, 1000], [0, 1000]]},
        {"id": "Z-LEIS", "type": "leisure", "label": "休闲/茶水 9.0㎡", "polygon": [[580, 980], [900, 980], [900, 1260], [580, 1260]]},
        {"id": "Z-DISP", "type": "display", "label": "成果展示(观看带在南侧过道)", "polygon": [[230, 0], [780, 0], [780, 50], [230, 50]]},
        {"id": "Z-EQ", "type": "equipment", "label": "公共设备区", "polygon": [[250, 990], [540, 990], [540, 1160], [250, 1160]]},
        {"id": "Z-STORE", "type": "storage", "label": "存储(北墙)", "polygon": [[130, 1260], [626, 1260], [626, 1320], [130, 1320]]},
        {"id": "Z-BUF", "type": "reserved", "label": "杂物缓冲 3.3㎡", "polygon": [[230, 1160], [560, 1160], [560, 1260], [230, 1260]]},
    ]
    corridors = [
        {"id": "M1", "role": "main", "rect": [780, 1130, 900, 1265], "note": "东北门通道段"},
        {"id": "M2", "role": "main", "rect": [560, 980, 780, 1250], "note": "北开放区主通道"},
        {"id": "M3", "role": "main", "rect": [650, 60, 780, 970], "note": "东纵主通道 130"},
        {"id": "M4", "role": "door_approach", "rect": [780, 55, 900, 155], "note": "东南门进深段(门宽100)"},
        {"id": "S1c", "role": "secondary", "rect": [360, 170, 440, 970], "note": "岛间次过道 80"},
        {"id": "S2c", "role": "secondary", "rect": [90, 515, 150, 1000], "note": "研究生过道 60+"},
        {"id": "S3c", "role": "secondary", "rect": [340, 60, 440, 170], "note": "展示观看带 100×110"},
    ]
    rows = [
        {"row_id": "R-JLONG", "seats": ["G-JAVA-L"], "ends": [[507, 50], [507, 170]], "prefs": ["P-S2", "P-S1", "P-N2"]},
        {"row_id": "R-IND", "seats": [f"G-IND-{i}" for i in range(1, 11)], "ends": [[225, 170], [225, 970]], "prefs": ["P-S1", "P-S2", "P-N2"]},
        {"row_id": "R-EMB", "seats": [f"G-EMB-{i}" for i in range(1, 10)], "ends": [[285, 250], [285, 970]], "prefs": ["P-S2", "P-N2", "P-S1"]},
        {"row_id": "R-JAVA", "seats": [f"G-JAVA-{i}" for i in range(1, 11)], "ends": [[515, 170], [515, 970]], "prefs": ["P-N2", "P-E1", "P-N1"]},
        {"row_id": "R-AI", "seats": [f"G-AI-{i}" for i in range(1, 9)], "ends": [[575, 330], [575, 970]], "prefs": ["P-N1", "P-E2", "P-E1"]},
        {"row_id": "R-GRAD", "seats": [f"G-GRAD-{i}" for i in range(1, 7)], "ends": [[22, 546], [22, 976]], "prefs": ["P-W2", "P-W1"], "slot_feed": True},
    ]
    return {"candidate_id": "C", "name": "北移开放变体（大开放北区）",
            "concept": "岛式整体北移（y170..970）：南端让出 110cm 展示观看带，北部形成 320×280 开放休闲/设备区；全部 44 工位可由现有 8 孔分区馈电，无需电工新增。",
            "placements": pl, "zones": zones, "corridors": corridors, "rows": rows,
            "misc_unplaced": ["空余剩 2×65×45 作机动杂物台面（不占位）", "椅子若干按工位+2 配"]}

def candidate_A():
    """基线：全沿墙直排。验证摆得下与否——预期工位不足。"""
    pl = base_common()
    nx = [20, 100, 180, 260, 426, 666]  # 槽位 414..426 / 654..666
    for i, x in enumerate(nx):
        pl.append(P(f"G-IND-{i+1}", "desk", "IND", x, 1260, 80, 60, seat_dir="N"))
        pl.append(P(f"G-IND-C{i+1}", "chair", "IND", x + 17, 1215, CHAIR, CHAIR))
    for i, x in enumerate([0, 80]):
        pl.append(P(f"G-EMB-{i+1}", "desk", "EMB", x, 0, 80, 60, seat_dir="S"))
        pl.append(P(f"G-EMB-C{i+1}", "chair", "EMB", x + 17, 60, CHAIR, CHAIR))
    ex = [155, 235, 315, 395, 475, 581, 661, 741, 875]  # 槽位 579..591 / 864..876
    for i, y in enumerate(ex):
        pl.append(P(f"G-AI-{i+1}", "desk", "AI", 840, y, 80, 60, rot=90, seat_dir="E"))
        pl.append(P(f"G-AI-C{i+1}", "chair", "AI", 795, y + 17, CHAIR, CHAIR))
    pl.append(P("G-JAVA-1", "desk", "JAVA", 508, 1260, 80, 60, seat_dir="N"))
    pl.append(P("G-JAVA-C1", "chair", "JAVA", 525, 1215, CHAIR, CHAIR))
    pl += [P("EQ-2", "equipment", "EQ", 0, 120, 150, 100, extra={"ops_face": "E"}),
           P("EQ-1", "equipment", "EQ", 230, 120, 120, 60, rot=90, extra={"ops_face": "E"})]
    pl += [P("S-CAB-1", "storage", "STORE", 0, 240, 100, 50),
           P("S-CAB-2", "storage", "STORE", 110, 240, 100, 50),
           P("S-SHELF-3", "storage", "STORE", 60, 300, 200, 60, rot=90, extra={"tall": True})]
    pl += [P("WATER", "leisure", "LEIS", 745, 960, 33, 33),
           P("LEIS-S1", "chair", "LEIS", 690, 980, CHAIR, CHAIR),
           P("LEIS-S2", "chair", "LEIS", 690, 1060, CHAIR, CHAIR)]
    pl += DISPLAY_TABLES()
    zones = [
        {"id": "Z-WORK", "type": "work", "label": "沿墙直排工位", "polygon": [[0, 0], [900, 0], [900, 1320], [0, 1320]]},
        {"id": "Z-GRAD", "type": "grad", "label": "研究生区", "polygon": [[0, 515], [150, 515], [150, 1000], [0, 1000]]},
        {"id": "Z-LEIS", "type": "leisure", "label": "休闲角 4.2㎡(不足)", "polygon": [[640, 950], [780, 950], [780, 1250], [640, 1250]]},
        {"id": "Z-DISP", "type": "display", "label": "成果展示", "polygon": [[230, 0], [780, 0], [780, 210], [230, 210]]},
        {"id": "Z-EQ", "type": "equipment", "label": "设备区", "polygon": [[0, 110], [290, 110], [290, 240], [0, 240]]},
    ]
    corridors = [
        {"id": "M1", "role": "main", "rect": [746, 1130, 900, 1265], "note": "东北门段(135)"},
        {"id": "M2", "role": "main", "rect": [160, 1050, 746, 1210], "note": "北横通道"},
        {"id": "M3", "role": "main", "rect": [290, 240, 780, 1050], "note": "中央大通道"},
        {"id": "M4", "role": "door_approach", "rect": [780, 55, 900, 155], "note": "东南门段"},
    ]
    rows = [
        {"row_id": "R-IND-N", "seats": [f"G-IND-{i}" for i in range(1, 7)], "ends": [[60, 1320], [706, 1320]], "prefs": ["P-N2", "P-N1"], "slot_feed": True},
        {"row_id": "R-AI-E", "seats": [f"G-AI-{i}" for i in range(1, 10)], "ends": [[900, 195], [900, 915]], "prefs": ["P-E2", "P-E1"], "slot_feed": True},
        {"row_id": "R-EMB-S", "seats": ["G-EMB-1", "G-EMB-2"], "ends": [[40, 60]], "prefs": ["P-S1"]},
        {"row_id": "R-JAVA-N", "seats": ["G-JAVA-1"], "ends": [[548, 1320]], "prefs": ["P-N1"]},
        {"row_id": "R-GRAD", "seats": [f"G-GRAD-{i}" for i in range(1, 7)], "ends": [[22, 546], [22, 976]], "prefs": ["P-W2", "P-W1"], "slot_feed": True},
    ]
    return {"candidate_id": "A", "name": "全沿墙直排（基线验证）",
            "concept": "全部桌沿北/南/东墙单排+研究生西墙排。验证纯沿墙能否放下 44 工位——结论：不足（详见检查报告缺口）。",
            "placements": pl, "zones": zones, "corridors": corridors, "rows": rows,
            "misc_unplaced": ["java 剩 10 工位、嵌入式 7、工业 3 无墙位可摆（26/44）",
                              "架子×2 无法贴墙布置（北墙/东墙被工位占用，西墙窗带禁高物）"]}

if __name__ == "__main__":
    for gen in (candidate_A, candidate_B, candidate_C):
        finalize(gen())
