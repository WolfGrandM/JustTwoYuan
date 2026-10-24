# -*- coding: utf-8 -*-
"""生成候选 F —— 用户手绘方案：
北墙整排单排桌(0.6深,桌前1m) + 三个4×2双排块(8座,1.2深,块间2m,从东墙西伸) + 端头0.7m，
节奏 0.6+1+1.2+2+1.2+2+1.2+0.7=9.9m 占据北半区，南端 y0..330 留给东南门(常闭)+通道。
右半空区(西墙窗侧)：研究生6 + 补位单桌5 + 休闲/设备/储物。电力/走线不建模。
座位：北排9 + 块24 + 研究生6 + 单桌5 = 44。
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

pl = []
# ── 北墙单排 7 座（0.6 深，电位槽 414-426 / 654-666 留空，东南端避开东北门回转），人坐南侧 ──
nx = [20, 100, 180, 260, 426, 506, 666]
groups_n = ["IND"]*4 + ["JAVA"]*2 + ["AI"]*1
for i, (x, g) in enumerate(zip(nx, groups_n)):
    pl.append(P(f"N-ROW-{i+1}", "desk", g, x, 1260, 80, 60, seat_dir="S"))
    pl.append(P(f"N-ROW-C{i+1}", "chair", g, x + 17, 1215, CHAIR, CHAIR))
# ── 三个 4×2 双排块（从东墙西伸 x580..900）──
def block(prefix, y0, groups_south_row, groups_north_row):
    out = []
    for k, g in enumerate(groups_south_row):   # 南排（y0..y0+60）：人坐块南侧
        out.append(P(f"{prefix}-S{k+1}", "desk", g, 580 + k*80, y0, 80, 60, seat_dir="S"))
        out.append(P(f"{prefix}-SC{k+1}", "chair", g, 580 + k*80 + 17, y0 - 45, CHAIR, CHAIR))
    for k, g in enumerate(groups_north_row):   # 北排（y0+60..y0+120）：人坐块北侧
        out.append(P(f"{prefix}-N{k+1}", "desk", g, 580 + k*80, y0 + 60, 80, 60, seat_dir="N"))
        out.append(P(f"{prefix}-NC{k+1}", "chair", g, 580 + k*80 + 17, y0 + 120, CHAIR, CHAIR))
    return out
pl += block("B1", 1000, ["IND"]*4, ["JAVA"]*4)          # y1000..1120
pl += block("B2", 680,  ["JAVA"]*2 + ["AI"]*2, ["AI"]*4)  # y680..800
pl += block("B3", 360,  ["EMB"]*4, ["EMB"]*4)           # y360..480
# ── 研究生 6 座（西墙窗带单排）──
for i, y in enumerate([500, 565, 630, 695, 760, 825]):
    pl.append(P(f"G-GRAD-{i+1}", "desk", "GRAD", 0, y, 65, 45, rot=90, seat_dir="W"))
    pl.append(P(f"G-GRAD-C{i+1}", "chair", "GRAD", 45, y + 10, CHAIR, CHAIR))
# ── 补位单桌 7：工业2 + java3(2标准+长桌) + ai1 + 嵌入式1 ──
pl += [P("S-IND-1", "desk", "IND", 150, 700, 80, 60, seat_dir="N"),
       P("S-IND-C1", "chair", "IND", 167, 760, CHAIR, CHAIR),
       P("S-IND-2", "desk", "IND", 236, 700, 80, 60, seat_dir="N"),
       P("S-IND-C2", "chair", "IND", 253, 760, CHAIR, CHAIR),
       P("S-JAVA-1", "desk", "JAVA", 322, 700, 80, 60, seat_dir="N"),
       P("S-JAVA-C1", "chair", "JAVA", 339, 760, CHAIR, CHAIR),
       P("S-AI-1", "desk", "AI", 408, 700, 80, 60, seat_dir="N"),
       P("S-AI-C1", "chair", "AI", 425, 760, CHAIR, CHAIR),
       P("S-EMB-1", "desk", "EMB", 494, 700, 80, 60, seat_dir="N"),
       P("S-EMB-C1", "chair", "EMB", 511, 760, CHAIR, CHAIR),
       P("S-JAVA-2", "desk", "JAVA", 280, 560, 80, 60, seat_dir="S"),
       P("S-JAVA-C2", "chair", "JAVA", 297, 515, CHAIR, CHAIR),
       P("S-JAVA-3", "desk", "JAVA", 430, 560, 120, 45, seat_dir="S"),
       P("S-JAVA-C3", "chair", "JAVA", 447, 515, CHAIR, CHAIR)]
# ── 休闲（西南开区 9㎡）：饮水机+2凳+茶水台 ──
pl += [P("WATER", "leisure", "LEIS", 300, 80, 33, 33),
       P("LEIS-S1", "chair", "LEIS", 200, 150, CHAIR, CHAIR),
       P("LEIS-S2", "chair", "LEIS", 200, 230, CHAIR, CHAIR),
       P("TEA-TABLE", "leisure", "LEIS", 160, 280, 65, 45)]
# ── 设备台（中西）──
pl += [P("EQ-1", "equipment", "EQ", 150, 430, 120, 60, extra={"ops_face": "E"}),
       P("EQ-2", "equipment", "EQ", 460, 200, 150, 100, extra={"ops_face": "E"})]
# ── 存储：架子×2 + 杂物柜×4（西北区）──
pl += [P("S-SHELF-1", "storage", "STORE", 60, 1000, 200, 60, extra={"tall": True}),
       P("S-SHELF-2", "storage", "STORE", 272, 1000, 200, 60, extra={"tall": True}),
       P("S-CAB-1", "storage", "STORE", 60, 1080, 100, 50),
       P("S-CAB-2", "storage", "STORE", 172, 1080, 100, 50),
       P("S-CAB-3", "storage", "STORE", 284, 1080, 100, 50),
       P("S-CAB-4", "storage", "STORE", 396, 1080, 100, 50)]

zones = [
    {"id": "Z-NROW", "type": "work", "label": "北墙单排9（0.6深+1m过道）", "polygon": [[0, 1155], [900, 1155], [900, 1320], [0, 1320]]},
    {"id": "Z-B1", "type": "work", "label": "双排块B1 8座（IND4+JAVA4）", "polygon": [[580, 895], [900, 895], [900, 1225], [580, 1225]]},
    {"id": "Z-B2", "type": "work", "label": "双排块B2 8座（JAVA2+AI6）", "polygon": [[580, 575], [900, 575], [900, 905], [580, 905]]},
    {"id": "Z-B3", "type": "work", "label": "双排块B3 8座（EMB8）", "polygon": [[580, 255], [900, 255], [900, 585], [580, 585]]},
    {"id": "Z-GRAD", "type": "grad", "label": "研究生区(西墙窗带)", "polygon": [[0, 470], [150, 470], [150, 920], [0, 920]]},
    {"id": "Z-LEIS", "type": "leisure", "label": "休闲/茶水 9㎡", "polygon": [[150, 60], [450, 60], [450, 360], [150, 360]]},
    {"id": "Z-EQ", "type": "equipment", "label": "设备区", "polygon": [[150, 430], [350, 430], [350, 650], [150, 650]]},
    {"id": "Z-STORE", "type": "storage", "label": "存储(架子×2)", "polygon": [[60, 1000], [472, 1000], [472, 1060], [60, 1060]]},
    {"id": "Z-BUF", "type": "reserved", "label": "杂物缓冲 4.2㎡", "polygon": [[150, 870], [500, 870], [500, 980], [150, 980]]},
]
corridors = [
    {"id": "M1", "role": "door_approach", "rect": [790, 1170, 900, 1260], "note": "东北门door_approach进门段(门宽100)"},
    {"id": "M2n", "role": "secondary", "rect": [10, 1160, 580, 1260], "note": "北排桌前过道 100（西段）"},
    {"id": "M3a", "role": "secondary", "rect": [580, 845, 900, 955], "note": "块间过道1 110（B1/B2之间2m档）"},
    {"id": "M3b", "role": "secondary", "rect": [580, 525, 900, 635], "note": "块间过道2 110（B2/B3之间2m档）"},
    {"id": "M4", "role": "door_approach", "rect": [785, 155, 900, 340], "note": "东南门(常闭)到达通道"},
    {"id": "M5", "role": "secondary", "rect": [60, 1090, 560, 1155], "note": "西北联络带 65"},
]
rows = []  # 电力/走线不建模（用户指示）

cand = {"candidate_id": "F", "name": "手绘方案·北排+三双排块",
        "concept": "按用户手绘：北墙整排单排桌(0.6深,桌前1m,电位槽留空9座) + 三个4×2双排块(8座/块,1.2深,"
                   "从东墙西伸,块间2m) + 端头0.7m，节奏0.6+1+1.2+2+1.2+2+1.2+0.7=9.9m占北半区；"
                   "南端留东南门(常闭)+通道。西半开区：研究生6(西墙窗带)+补位单桌5+休闲9㎡+设备+储物。"
                   "座位：9+24+6+5=44。电力/走线不建模。",
        "placements": pl, "zones": zones, "corridors": corridors, "rows": rows,
        "misc_unplaced": ["空余 2×65×45、2×110×50、1×160×60、1×120×45 作机动台面（不占位）",
                          "椅子若干按 44 工位+2 凳配置"]}
path = os.path.join(BASE, "candidates", "F.json")
with open(path, "w", encoding="utf-8") as f:
    json.dump(cand, f, ensure_ascii=False, indent=1)
seats = sum(1 for p in pl if p["kind"] == "desk" and p.get("seat_dir"))
print(f"F: {len(pl)} placements, {seats} seats → {path}")
