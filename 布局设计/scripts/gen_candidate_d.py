# -*- coding: utf-8 -*-
"""生成候选 D —— 用户方案：对头三对成大桌（6座，240×120），短边贴墙半岛布置，前后各留1.5m。
不考虑配电箱/电位规格/走线（电工负责）。东南门常闭：仅保留门回转与基本到达通道。
"""
import json, os

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CHAIR = 45

def P(asset_id, kind, group, x, y, w, d, rot=0, seat_dir=None, extra=None):
    if rot in (90, 270):
        w, d = d, w
    p = {"asset_id": asset_id, "kind": kind, "group": group,
         "x": x, "y": y, "w": w, "d": d, "rot": rot}
    if seat_dir: p["seat_dir"] = seat_dir
    if extra: p.update(extra)
    return p

def row_y(prefix, group, n, x, y0, seat_dir, pitch=80):
    out = []
    for k in range(n):
        y = y0 + k * pitch
        out.append(P(f"{prefix}-{k+1}", "desk", group, x, y, 80, 60, rot=90, seat_dir=seat_dir))
        cx = x - 45 if seat_dir == "E" else x + 60
        out.append(P(f"{prefix}-C{k+1}", "chair", group, cx, y + 17, CHAIR, CHAIR))
    return out

def row_x(prefix, group, n, x0, y, seat_dir):
    """沿 x 轴 n 桌（80×60），N排(face S,椅在北) / S排(face N,椅在南)"""
    out = []
    for k in range(n):
        x = x0 + k * 80
        out.append(P(f"{prefix}-{k+1}", "desk", group, x, y, 80, 60, seat_dir=seat_dir))
        cy = y - 45 if seat_dir == "S" else y + 60
        out.append(P(f"{prefix}-C{k+1}", "chair", group, x + 17, cy, CHAIR, CHAIR))
    return out

def grad_row():
    out = []
    for i, y in enumerate([546, 618, 690, 762, 834, 911]):  # 南→北，电位槽 534-546/899-911
        out.append(P(f"G-GRAD-{i+1}", "desk", "GRAD", 0, y, 65, 45, rot=90, seat_dir="W"))
        out.append(P(f"G-GRAD-C{i+1}", "chair", "GRAD", 45, y + 10, CHAIR, CHAIR))
    return out

pl = []
# ── 大桌 T1/T2（北墙半岛，y1080..1320）：工业10 + java2 ──
pl += row_y("T1-W", "IND", 3, 150, 1080, "E")   # T1 西排面东
pl += row_y("T1-E", "IND", 3, 210, 1080, "W")   # T1 东排面西
pl += row_y("T2-W", "IND", 3, 420, 1080, "E")   # T2 西排 工业3
pl.append(P("T2-E-1", "desk", "IND", 480, 1080, 80, 60, rot=90, seat_dir="W"))
pl.append(P("T2-E-C1", "chair", "IND", 540, 1097, CHAIR, CHAIR))
pl += row_y("T2-E2", "JAVA", 2, 480, 1160, "W") # T2 东排 java2
# ── 大桌 T3（东墙半岛，x660..900 y760..880）：java6 ──
pl += row_x("T3-N", "JAVA", 3, 660, 760, "S")
pl += row_x("T3-S", "JAVA", 3, 660, 820, "N")
# ── 大桌 T4（东墙半岛，x660..900 y360..480）：java2+ai2+嵌入式2 混编 ──
pl += row_x("T4-N", "JAVA", 2, 660, 360, "S")
pl += row_x("T4-N2", "AI", 1, 820, 360, "S")
pl += row_x("T4-S", "AI", 1, 660, 420, "N")
pl += row_x("T4-S2", "EMB", 2, 740, 420, "N")
# ── 大桌 T5/T6（南墙半岛，y0..240）：ai6 / 嵌入式6 ──
pl += row_y("T5-W", "AI", 3, 150, 0, "E")
pl += row_y("T5-E", "AI", 3, 210, 0, "W")
pl += row_y("T6-W", "EMB", 3, 420, 0, "E")
pl += row_y("T6-E", "EMB", 3, 480, 0, "W")
# ── 单桌补位：嵌入式标准桌 + java长桌 ──
pl.append(P("S-EMB-1", "desk", "EMB", 300, 400, 80, 60, seat_dir="N"))
pl.append(P("S-EMB-C1", "chair", "EMB", 317, 460, CHAIR, CHAIR))
pl.append(P("S-JAVA-1", "desk", "JAVA", 610, 480, 120, 45, rot=90, seat_dir="E"))
pl.append(P("S-JAVA-C1", "chair", "JAVA", 565, 510, CHAIR, CHAIR))
# ── 研究生 6 座（西墙窗带单排）──
pl += grad_row()
# ── 展示/临时工位（灵活）：东南角2桌 + 中部临时岛2桌 + 休闲茶水台 ──
pl.append(P("DISP-T1", "desk", "DISPLAY", 690, 0, 110, 50))
pl.append(P("DISP-T2", "desk", "DISPLAY", 300, 560, 160, 60))
pl.append(P("DISP-T3", "desk", "DISPLAY", 472, 565, 120, 45))
pl.append(P("DISP-T4", "desk", "DISPLAY", 655, 1195, 65, 45))
# ── 休闲（东北门附近）：饮水机+2凳 ──
pl += [P("WATER", "leisure", "LEIS", 860, 1040, 33, 33),
       P("LEIS-S1", "chair", "LEIS", 710, 1100, CHAIR, CHAIR),
       P("LEIS-S2", "chair", "LEIS", 730, 1180, CHAIR, CHAIR)]
# ── 设备台（西墙南段）──
pl += [P("EQ-2", "equipment", "EQ", 0, 260, 150, 100, rot=90, extra={"ops_face": "E"}),
       P("EQ-1", "equipment", "EQ", 0, 420, 120, 60, rot=90, extra={"ops_face": "E"})]
# ── 存储：中部架/柜群 + 东北角柜 ──
pl += [P("S-SHELF-1", "storage", "STORE", 160, 830, 200, 60, extra={"tall": True}),
       P("S-SHELF-2", "storage", "STORE", 372, 830, 200, 60, extra={"tall": True}),
       P("S-SHELF-3", "storage", "STORE", 584, 640, 200, 60, rot=90, extra={"tall": True}),
       P("S-CAB-1", "storage", "STORE", 160, 902, 100, 50),
       P("S-CAB-2", "storage", "STORE", 272, 902, 100, 50),
       P("S-CAB-3", "storage", "STORE", 384, 902, 100, 50),
       P("S-CAB-4", "storage", "STORE", 695, 1268, 100, 50)]

zones = [
    {"id": "Z-T12", "type": "work", "label": "大桌T1/T2（工业10+java2）前后1.5m", "polygon": [[0, 1080], [420, 1080], [420, 1320], [0, 1320]]},
    {"id": "Z-T3", "type": "work", "label": "大桌T3（java6）", "polygon": [[510, 610], [900, 610], [900, 1030], [510, 1030]]},
    {"id": "Z-T4", "type": "work", "label": "大桌T4（java2+ai2+嵌入式2）", "polygon": [[510, 210], [900, 210], [900, 630], [510, 630]]},
    {"id": "Z-T56", "type": "work", "label": "大桌T5（ai6）/T6（嵌入式6）", "polygon": [[0, 0], [690, 0], [690, 390], [0, 390]]},
    {"id": "Z-GRAD", "type": "grad", "label": "研究生区(西墙窗带)", "polygon": [[0, 515], [150, 515], [150, 1000], [0, 1000]]},
    {"id": "Z-LEIS", "type": "leisure", "label": "休闲/茶水 8.1㎡", "polygon": [[610, 980], [900, 980], [900, 1260], [610, 1260]]},
    {"id": "Z-DISP", "type": "display", "label": "展示/临时工位(灵活)", "polygon": [[660, 0], [900, 0], [900, 390], [660, 390]]},
    {"id": "Z-EQ", "type": "equipment", "label": "设备区", "polygon": [[0, 250], [160, 250], [160, 550], [0, 550]]},
    {"id": "Z-STORE", "type": "storage", "label": "架子/杂物柜群", "polygon": [[150, 820], [660, 820], [660, 960], [150, 960]]},
    {"id": "Z-BUF", "type": "reserved", "label": "杂物缓冲 4.5㎡", "polygon": [[150, 980], [600, 980], [600, 1080], [150, 1080]]},
]
corridors = [
    {"id": "M1", "role": "main", "rect": [780, 1130, 900, 1265], "note": "东北门(常用入口)通道段 120"},
    {"id": "M2", "role": "main", "rect": [150, 960, 850, 1080], "note": "北横通道 120（大桌T1/T2端头前）"},
    {"id": "M3a", "role": "main", "rect": [150, 240, 295, 555], "note": "中西通道 145"},
    {"id": "M3b", "role": "main", "rect": [300, 630, 580, 825], "note": "中南通道 195"},
    {"id": "M4", "role": "secondary", "rect": [560, 240, 655, 390], "note": "中东通道 95"},
    {"id": "M4c", "role": "secondary", "rect": [600, 240, 800, 315], "note": "东南联系带 115"},
    {"id": "M5", "role": "door_approach", "rect": [690, 55, 800, 240], "note": "东南门(常闭)到达通道 110"},
]
rows = []  # 走线/馈电按用户要求不考虑

cand = {"candidate_id": "D", "name": "用户方案·对拼大桌半岛式",
        "concept": "标准桌两两对拼（人对坐）×3对=6座大桌（240×120），短边贴墙半岛布置，两条长边各留1.5m。"
                   "北墙T1/T2（工业10+java2）、东墙T3（java6）/T4（混编6）、南墙T5（ai6）/T6（嵌入式6）；"
                   "研究生6座西墙窗带单排；java长桌+1标准桌作补位单桌。展示台按灵活功能分散（东南角+中部临时岛+休闲茶水台）。"
                   "配电箱/电位规格/走线均由电工统一考虑，布局不建模。东南门常闭，仅保留回转与到达通道。",
        "placements": pl, "zones": zones, "corridors": corridors, "rows": rows,
        "misc_unplaced": ["空余 1×65×45 + 1×110×50 作机动台面（不占位）",
                          "椅子若干按 44 工位+2 凳配置"]}
path = os.path.join(BASE, "candidates", "D.json")
with open(path, "w", encoding="utf-8") as f:
    json.dump(cand, f, ensure_ascii=False, indent=1)
seats = sum(1 for p in pl if p["kind"] == "desk" and p.get("seat_dir"))
print(f"D: {len(pl)} placements, {seats} seats → {path}")
