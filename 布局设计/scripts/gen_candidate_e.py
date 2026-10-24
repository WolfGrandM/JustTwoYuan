# -*- coding: utf-8 -*-
"""生成候选 E —— 用户方案 v2：
大桌 = 4 对桌（8 桌 8 座，320×120），长边平行贴南/北墙，墙侧座位压至 0.7m，房间侧 1.5m。
架子 2 个；取消展示区（茶水台归休闲）；电力/走线不建模。
4 大桌(32座) + 补位单桌6(工业2/java3/嵌入式1) + 研究生6 = 44。
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

def block_ns(prefix, group, x0, wall):
    """沿墙大桌：4对桌=8座（320×120块）。
    北墙(wall='N')：块 y1130..1250，墙侧带 y1250..1320(0.7m)，房间侧带 y980..1130(1.5m)
    南墙(wall='S')：块 y70..190，墙侧带 y0..70(0.7m)，房间侧带 y190..340(1.5m)
    seat_dir 按人所在侧记（与检查器 H4 约定一致）。"""
    out = []
    if wall == "N":
        rows = [(1130, "S", 1085), (1190, "N", 1250)]  # (桌y, 人侧, 椅y)
    else:
        rows = [(70, "S", 25), (130, "N", 190)]
    n = 0
    for dy, sd, cy in rows:
        for k in range(4):
            n += 1
            out.append(P(f"{prefix}-{n}", "desk", group, x0 + k * 80, dy, 80, 60, seat_dir=sd))
            out.append(P(f"{prefix}-C{n}", "chair", group, x0 + k * 80 + 17, cy, CHAIR, CHAIR))
    return out

pl = []
# ── 4 张大桌（两列对齐：x 55..375 / 465..785）──
pl += block_ns("B1", "IND", 55, "N")    # 工业 8
pl += block_ns("B2", "JAVA", 465, "N")  # java 8
pl += block_ns("B3", "AI", 55, "S")     # ai 8
pl += block_ns("B4", "EMB", 465, "S")   # 嵌入式 8
# ── 补位单桌 6：工业2 + java3(含长桌) + 嵌入式1 ──
pl += [P("S-IND-1", "desk", "IND", 110, 860, 80, 60, seat_dir="N"),
       P("S-IND-C1", "chair", "IND", 127, 920, CHAIR, CHAIR),
       P("S-IND-2", "desk", "IND", 202, 860, 80, 60, seat_dir="N"),
       P("S-IND-C2", "chair", "IND", 219, 920, CHAIR, CHAIR),
       P("S-JAVA-1", "desk", "JAVA", 295, 860, 80, 60, seat_dir="N"),
       P("S-JAVA-C1", "chair", "JAVA", 312, 920, CHAIR, CHAIR),
       P("S-JAVA-2", "desk", "JAVA", 475, 875, 120, 45, seat_dir="N"),
       P("S-JAVA-C2", "chair", "JAVA", 517, 920, CHAIR, CHAIR),
       P("S-JAVA-3", "desk", "JAVA", 515, 790, 80, 60, seat_dir="E"),
       P("S-JAVA-C3", "chair", "JAVA", 470, 807, CHAIR, CHAIR),
       P("S-EMB-1", "desk", "EMB", 400, 400, 80, 60, seat_dir="S"),
       P("S-EMB-C1", "chair", "EMB", 417, 355, CHAIR, CHAIR)]
# ── 研究生 6 座（西墙窗带单排，电位槽留空）──
for i, y in enumerate([546, 618, 690, 762, 834, 911]):
    pl.append(P(f"G-GRAD-{i+1}", "desk", "GRAD", 0, y, 65, 45, rot=90, seat_dir="W"))
    pl.append(P(f"G-GRAD-C{i+1}", "chair", "GRAD", 45, y + 10, CHAIR, CHAIR))
# ── 休闲（东墙中段 8.8㎡）：饮水机+2凳+茶水台 ──
pl += [P("WATER", "leisure", "LEIS", 860, 640, 33, 33),
       P("LEIS-S1", "chair", "LEIS", 700, 700, CHAIR, CHAIR),
       P("LEIS-S2", "chair", "LEIS", 700, 780, CHAIR, CHAIR),
       P("TEA-TABLE", "leisure", "LEIS", 640, 870, 65, 45)]
# ── 设备台（中西，长边朝北/东留操作面）──
pl += [P("EQ-1", "equipment", "EQ", 200, 460, 120, 60, extra={"ops_face": "S"}),
       P("EQ-2", "equipment", "EQ", 200, 530, 150, 100, rot=90, extra={"ops_face": "E"})]
# ── 存储：架子×2 + 杂物柜×4 ──
pl += [P("S-SHELF-1", "storage", "STORE", 840, 380, 200, 60, rot=90, extra={"tall": True}),
       P("S-SHELF-2", "storage", "STORE", 620, 400, 200, 60, extra={"tall": True}),
       P("S-CAB-1", "storage", "STORE", 790, 1268, 100, 50),
       P("S-CAB-2", "storage", "STORE", 660, 540, 100, 50),
       P("S-CAB-3", "storage", "STORE", 660, 470, 100, 50),
       P("S-CAB-4", "storage", "STORE", 0, 345, 100, 50)]

zones = [
    {"id": "Z-B1", "type": "work", "label": "大桌B1 工业8（墙侧0.7m/外侧1.5m）", "polygon": [[0, 980], [375, 980], [375, 1320], [0, 1320]]},
    {"id": "Z-B2", "type": "work", "label": "大桌B2 java8", "polygon": [[465, 980], [900, 980], [900, 1320], [465, 1320]]},
    {"id": "Z-B3", "type": "work", "label": "大桌B3 ai8", "polygon": [[0, 0], [375, 0], [375, 340], [0, 340]]},
    {"id": "Z-B4", "type": "work", "label": "大桌B4 嵌入式8", "polygon": [[465, 0], [900, 0], [900, 340], [465, 340]]},
    {"id": "Z-GRAD", "type": "grad", "label": "研究生区(西墙窗带)", "polygon": [[0, 515], [150, 515], [150, 1000], [0, 1000]]},
    {"id": "Z-LEIS", "type": "leisure", "label": "休闲/茶水 8.8㎡", "polygon": [[640, 620], [900, 620], [900, 960], [640, 960]]},
    {"id": "Z-EQ", "type": "equipment", "label": "设备区", "polygon": [[200, 460], [430, 460], [430, 680], [200, 680]]},
    {"id": "Z-STORE", "type": "storage", "label": "存储(架子×2)", "polygon": [[620, 380], [900, 380], [900, 580], [620, 580]]},
    {"id": "Z-BUF", "type": "reserved", "label": "杂物缓冲 3.1㎡", "polygon": [[400, 655], [635, 655], [635, 785], [400, 785]]},
]
corridors = [
    {"id": "M1", "role": "main", "rect": [790, 1105, 900, 1265], "note": "东北门(常用入口)door_approach进门段110(门宽100,内部主廊150+)"},
    {"id": "M2n", "role": "main", "rect": [465, 980, 900, 1130], "note": "B2外侧座前通道 150（兼座前空间）"},
    {"id": "M2c", "role": "secondary", "rect": [340, 460, 620, 650], "note": "中央通道 190"},
    {"id": "M3", "role": "main", "rect": [150, 690, 395, 850], "note": "中西通道 160"},
    {"id": "M5", "role": "secondary", "rect": [375, 460, 465, 1130], "note": "纵列间通道 90"},
    {"id": "M4", "role": "door_approach", "rect": [785, 155, 900, 380], "note": "东南门(常闭)到达通道 115"},
]
rows = []  # 电力/走线不建模（用户指示）

cand = {"candidate_id": "E", "name": "用户方案v2·八座大桌贴墙排",
        "concept": "大桌升级为4对桌=8座（320×120），长边平行贴南/北墙：墙侧座位压至0.7m（用户指定），房间侧留1.5m。"
                   "北墙B1(工业8)/B2(java8)，南墙B3(ai8)/B4(嵌入式8)，两列x对齐成行成排；"
                   "补位单桌6张（工业2/java3含长桌/嵌入式1）居中；研究生6座西墙窗带单排；"
                   "架子减为2个（东墙+中部），取消展示区（茶水台归休闲）；电力/走线由电工统一考虑。",
        "placements": pl, "zones": zones, "corridors": corridors, "rows": rows,
        "misc_unplaced": ["空余 1×65×45、2×110×50、1×160×60、1×120×45 作机动台面（不占位）",
                          "椅子若干按 44 工位+2 凳配置"]}
path = os.path.join(BASE, "candidates", "E.json")
with open(path, "w", encoding="utf-8") as f:
    json.dump(cand, f, ensure_ascii=False, indent=1)
seats = sum(1 for p in pl if p["kind"] == "desk" and p.get("seat_dir"))
print(f"E: {len(pl)} placements, {seats} seats → {path}")
