# -*- coding: utf-8 -*-
"""生成候选 G —— 用户手绘 v2（带方位）：
东墙 3 块 + 西墙 3 块（各 4×2 双排，长边 E-W 3.2m×1.2m 深），中间 260cm 中央大道。
后门（东南门）当不存在；东北门为唯一入口。
座位 44：E1 工业8 / E2 java8 / E3 ai8 / W1 研究生6 / W2 嵌入式8 / W3 混编6(IND2+JAVA3含长桌+EMB1)。
其余物品（休闲/设备/架子2/柜4/缓冲）由本方案布置：
休闲 9㎡ 东北门旁；设备台 NE 区+南带；架子 2：北墙东段+南带；柜 4 分散；缓冲 4.8㎡ 东南门区。
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

def block_e(prefix, y0, groups_south, groups_north):
    """东墙块：x580..900，南排(y0..y0+60)人坐南侧，北排(y0+60..y0+120)人坐北侧"""
    out = []
    for k, g in enumerate(groups_south):
        out.append(P(f"{prefix}-S{k+1}", "desk", g, 580 + k*80, y0, 80, 60, seat_dir="S"))
        out.append(P(f"{prefix}-SC{k+1}", "chair", g, 580 + k*80 + 17, y0 - 45, CHAIR, CHAIR))
    for k, g in enumerate(groups_north):
        out.append(P(f"{prefix}-N{k+1}", "desk", g, 580 + k*80, y0 + 60, 80, 60, seat_dir="N"))
        out.append(P(f"{prefix}-NC{k+1}", "chair", g, 580 + k*80 + 17, y0 + 120, CHAIR, CHAIR))
    return out

def block_w4(prefix, y0, groups_south, groups_north):
    """西墙块：x0..320（4 桌）"""
    out = []
    for k, g in enumerate(groups_south):
        out.append(P(f"{prefix}-S{k+1}", "desk", g, k*80, y0, 80, 60, seat_dir="S"))
        out.append(P(f"{prefix}-SC{k+1}", "chair", g, k*80 + 17, y0 - 45, CHAIR, CHAIR))
    for k, g in enumerate(groups_north):
        out.append(P(f"{prefix}-N{k+1}", "desk", g, k*80, y0 + 60, 80, 60, seat_dir="N"))
        out.append(P(f"{prefix}-NC{k+1}", "chair", g, k*80 + 17, y0 + 120, CHAIR, CHAIR))
    return out

# ── 东列三块 ──
pl += block_e("E1", 120, ["IND"]*4, ["IND"]*4)            # y120..240 工业8
pl += block_e("E2", 420, ["JAVA"]*4, ["JAVA"]*4)          # y420..540 java8
pl += block_e("E3", 720, ["AI"]*4, ["AI"]*4)              # y720..840 ai8
# ── 西列三块 ──
# W1 研究生 6（65×45 桌 3+3，x0..195）
for k in range(3):
    pl.append(P(f"W1-S{k+1}", "desk", "GRAD", k*65, 120, 65, 45, seat_dir="S"))
    pl.append(P(f"W1-SC{k+1}", "chair", "GRAD", k*65 + 10, 75, CHAIR, CHAIR))
    pl.append(P(f"W1-N{k+1}", "desk", "GRAD", k*65, 195, 65, 45, seat_dir="N"))
    pl.append(P(f"W1-NC{k+1}", "chair", "GRAD", k*65 + 10, 240, CHAIR, CHAIR))
pl += block_w4("W2", 420, ["EMB"]*4, ["EMB"]*4)           # y420..540 嵌入式8
# W3 混编 6（x0..280）：南排 IND IND JAVA；北排 JAVA长桌 JAVA EMB
pl += [P("W3-S1", "desk", "IND", 0, 720, 80, 60, seat_dir="S"),
       P("W3-SC1", "chair", "IND", 17, 675, CHAIR, CHAIR),
       P("W3-S2", "desk", "IND", 80, 720, 80, 60, seat_dir="S"),
       P("W3-SC2", "chair", "IND", 97, 675, CHAIR, CHAIR),
       P("W3-S3", "desk", "JAVA", 160, 720, 80, 60, seat_dir="S"),
       P("W3-SC3", "chair", "JAVA", 177, 675, CHAIR, CHAIR),
       P("W3-N1", "desk", "JAVA", 0, 780, 120, 45, seat_dir="N"),
       P("W3-NC1", "chair", "JAVA", 30, 840, CHAIR, CHAIR),
       P("W3-N2", "desk", "JAVA", 120, 780, 80, 60, seat_dir="N"),
       P("W3-NC2", "chair", "JAVA", 137, 840, CHAIR, CHAIR),
       P("W3-N3", "desk", "EMB", 200, 780, 80, 60, seat_dir="N"),
       P("W3-NC3", "chair", "EMB", 217, 840, CHAIR, CHAIR)]
# ── 休闲（东北门旁 9㎡）：饮水机+茶水台+2凳 ──
pl += [P("WATER", "leisure", "LEIS", 860, 955, 33, 33),
       P("TEA-TABLE", "leisure", "LEIS", 770, 955, 65, 45),
       P("LEIS-S1", "chair", "LEIS", 655, 950, CHAIR, CHAIR),
       P("LEIS-S2", "chair", "LEIS", 655, 1015, CHAIR, CHAIR)]
# ── 设备台：EQ2 NE区（长边朝东留操作面）、EQ1 北墙西段 ──
pl += [P("EQ-2", "equipment", "EQ", 450, 1050, 150, 100, rot=90, extra={"ops_face": "E"}),
       P("EQ-1", "equipment", "EQ", 330, 1200, 120, 60, extra={"ops_face": "E"})]
# ── 存储：架子×2（北墙东段 / 南带西段）+ 杂物柜×4 ──
pl += [P("S-SHELF-1", "storage", "STORE", 590, 1215, 200, 60, extra={"tall": True}),
       P("S-SHELF-2", "storage", "STORE", 330, 5, 200, 60, extra={"tall": True}),
       P("S-CAB-1", "storage", "STORE", 340, 1125, 100, 50),
       P("S-CAB-2", "storage", "STORE", 340, 1060, 100, 50),
       P("S-CAB-3", "storage", "STORE", 230, 1075, 100, 50),
       P("S-CAB-4", "storage", "STORE", 230, 1135, 100, 50)]

zones = [
    {"id": "Z-E1", "type": "work", "label": "E1 工业8", "polygon": [[580, 75], [900, 75], [900, 285], [580, 285]]},
    {"id": "Z-E2", "type": "work", "label": "E2 java8", "polygon": [[580, 375], [900, 375], [900, 585], [580, 585]]},
    {"id": "Z-E3", "type": "work", "label": "E3 ai8", "polygon": [[580, 675], [900, 675], [900, 945], [580, 945]]},
    {"id": "Z-W1", "type": "grad", "label": "研究生区6(西墙窗边)", "polygon": [[0, 75], [195, 75], [195, 285], [0, 285]]},
    {"id": "Z-W2", "type": "work", "label": "W2 嵌入式8", "polygon": [[0, 375], [320, 375], [320, 585], [0, 585]]},
    {"id": "Z-W3", "type": "work", "label": "W3 混编6", "polygon": [[0, 675], [280, 675], [280, 945], [0, 945]]},
    {"id": "Z-LEIS", "type": "leisure", "label": "休闲/茶水 8.4㎡(东北门旁)", "polygon": [[630, 830], [900, 830], [900, 1140], [630, 1140]]},
    {"id": "Z-EQ", "type": "equipment", "label": "设备区", "polygon": [[330, 1060], [550, 1060], [550, 1260], [330, 1260]]},
    {"id": "Z-STORE", "type": "storage", "label": "存储(架子×2)", "polygon": [[590, 1215], [790, 1215], [790, 1275], [590, 1275]]},
    {"id": "Z-BUF", "type": "reserved", "label": "杂物缓冲 4.8㎡(后门区)", "polygon": [[500, 0], [900, 0], [900, 120], [500, 120]]},
]
corridors = [
    {"id": "M1", "role": "door_approach", "rect": [800, 1165, 900, 1265], "note": "东北门(唯一使用)进门段"},
    {"id": "M2", "role": "main", "rect": [320, 130, 580, 1050], "note": "中央大道 260（东西两列之间）"},
    {"id": "M3a", "role": "secondary", "rect": [580, 285, 900, 375], "note": "E1/E2 块间过道 90"},
    {"id": "M3b", "role": "secondary", "rect": [580, 585, 900, 675], "note": "E2/E3 块间过道 90"},
    {"id": "M4a", "role": "secondary", "rect": [0, 285, 320, 375], "note": "W1/W2 块间过道 90"},
    {"id": "M4b", "role": "secondary", "rect": [0, 585, 280, 675], "note": "W2/W3 块间过道 90"},
    {"id": "M5", "role": "secondary", "rect": [490, 0, 900, 120], "note": "南带通道/缓冲区前 120"},
]
rows = []  # 电力/走线不建模（用户指示）

cand = {"candidate_id": "G", "name": "手绘v2·东西双列六块",
        "concept": "按用户带方位手绘：东墙挂三块（工业8/java8/ai8），西墙挂三块（研究生6/嵌入式8/混编6含java长桌），"
                   "每块 4×2 双排背靠背（3.2×1.2m），中间 260cm 中央大道；后门（东南门）按不存在处理，"
                   "其区域作杂物缓冲；东北门旁布置休闲 9㎡；架子 2（北墙东段+南带）、柜 4、设备台 2 台。"
                   "座位 8+8+8+6+8+6 = 44。电力/走线不建模。",
        "placements": pl, "zones": zones, "corridors": corridors, "rows": rows,
        "misc_unplaced": ["空余 2×65×45、2×110×50、1×160×60、1×120×45 作机动台面（不占位）",
                          "椅子若干按 44 工位+2 凳配置"]}
path = os.path.join(BASE, "candidates", "G.json")
with open(path, "w", encoding="utf-8") as f:
    json.dump(cand, f, ensure_ascii=False, indent=1)
seats = sum(1 for p in pl if p["kind"] == "desk" and p.get("seat_dir"))
print(f"G: {len(pl)} placements, {seats} seats → {path}")
