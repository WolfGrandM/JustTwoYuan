# 脚本接口约定

两个独立 Python 脚本（仅用标准库 + openpyxl 按需），存 `scripts/`，一次编写反复复用。校验逻辑内置脚本中边算边查，不设独立审查阶段。均以 JSON 走 stdin/文件、stdout 输出报告，退出码：0=通过，1=有 ERROR，2=输入格式错误。

## scripts/check_layout.py —— 约束检查器

```
python scripts/check_layout.py --layout candidates/B.json \
  --room data/room.json --assets data/assets.json [--params data/params.json]
```

- `--params` 可选：覆盖 rules.md 中 ⚙ 默认参数（如 `{"main_corridor_cm": 120}`）。未给的参数用内置默认值并在报告 `params_used` 里回显。

stdout 报告：

```jsonc
{
  "candidate_id": "B",
  "pass": false,               // 无 ERROR 即 true
  "violations": [
    { "rule": "H4", "severity": "ERROR|WARN", "detail": "G-IND-D3 椅后净空 52cm < 60cm（被 EQ1 占用）", "assets": ["G-IND-D3"] }
  ],
  "metrics": {
    "occupancy_rate": 0.62, "main_corridor_min_cm": 135, "seat_clearance_min_cm": 61,
    "electrician_confirm_seats": ["G-AI-D2"], "zone_compliance": { "grad": "ok", "leisure_m2": 9.6 }
  },
  "params_used": { "main_corridor_cm": 120 }
}
```

severity 约定：**ERROR** = H1–H12 实测不满足且无标注豁免；**WARN** = 靠近阈值（±10%⚙）或有条件通过（H3/H12 带"需电工确认"标注）。迭代修复由调用方（P2/P4 流程）读报告后改 layout.json 重跑，脚本自身不改布局。

## scripts/power_reach.py —— 供电可达性 + 走线友好度

```
python scripts/power_reach.py --layout candidates/B.json \
  --room data/room.json --assets data/assets.json [--show-wiring]
```

stdout 报告：

```jsonc
{
  "per_seat": [
    { "seat_id": "G-IND-D1", "pocket_id": "P1", "path_len_cm": 240,
      "reachable": true, "method": "现有电位孔延线", "note": "" }
  ],
  "per_seat_unreachable": [
    { "seat_id": "G-AI-D2", "reason": "最近电位孔 P3 距离 620cm > 500cm", "action": "需电工确认" }
  ],
  "pocket_load": [ { "pocket_id": "P1", "seats": ["G-IND-D1","G-IND-D2"], "diversified_watts": 620, "within_limit": true } ],
  "wiring": {                    // --show-wiring 时附路径几何，供叠加图渲染；否则仅指标
    "turns_total": 6, "turns_detail": [ { "pocket": "P1", "turns": 2, "path": [[x,y],…] } ],
    "alignment_ratio": 0.86, "island_orientation": [ { "zone": "Z1", "long_axis": "N-S", "feed_dir": "E-W", "ok": true } ],
    "conduit_conflicts": []
  },
  "pass": true                   // 无 unreachable 未标注 && 无 conduit_conflicts
}
```

路径长度算法（H3 的"可行延线距离"）：工位桌边最近点到电位孔，沿"桌边 → 本行桌列中线/墙脚带 → 电位孔"的曼哈顿折线（允许贴行走向），不做斜穿；同一行多个工位允许共享干线段（路径长度按分摊后计算）。

## 渲染约定（candidates/*.html）

交互式 HTML 平面图必须含：分区着色（work/grad/leisure/display/equipment/storage/buffer 各一色，预留区虚线边框）、全部家具外接矩形（含 id/组名/尺寸 hover）、电位孔与配电箱符号（配电箱 1m 净空圈）、「需电工确认」工位醒目标注、门扇开启弧线、指北针与比例尺、图例。多候选时每个候选一个 HTML + 一张评分卡（S1–S5、W 指标、电确认工位数）。
