# 数据规范（JSON 格式定义）

所有文件单位 cm，坐标见 SKILL.md 坐标系约定。字段带 `?` 为可选；`!` 为必填。未知值填 `null` 并加入缺口清单，**不得臆造现场数据**。

## data/room.json —— 房间静态数据

```jsonc
{
  "meta": { "source_file": "工作簿1.csv", "parsed_at": "ISO时间", "open_questions": ["…"] },
  "room": {
    "width_x_cm": 900,        // ! 东西向内净宽
    "depth_y_cm": 1320,       // ! 南北向内净深
    "height_cm": 250,         // ! 层高
    "area_m2": 118.8
  },
  "openings": [               // ! 门窗，position 指洞口起点在所在墙上的坐标（西/南墙从原点端起算，东墙从南端起算，北墙从西端起算）
    {
      "id": "D-NE", "type": "door", "wall": "east",
      "position_cm": 1180, "width_cm": 90,
      "swing": "inward", "hinge": "north",   // 内开/外开、铰链端；null=未知
      "note": "东北角门（CSV 原称北墙门口）"
    },
    { "id": "W1", "type": "window", "wall": "west", "position_cm": 12, "width_cm": 400, "sill_height_cm": 90, "top_height_cm": 210 }
  ],
  "power": {
    "outlet_pockets": [       // ! 现有电位孔。位置未知时 position_cm=null 并进缺口清单
      { "id": "P1", "wall": "west", "position_cm": 300, "spec": "10A", "pocket_count": 1, "note": "" }
    ],
    "distribution_box": { "id": "DB1", "wall": "north", "position_cm": 450, "spec": null, "front_clearance_cm": 100 }
  },
  "electrical": {             // 电气内检参数（负荷计算用）
    "always_on": [ { "name": "饮水机", "watts": null } ],
    "demand_basis": "平时在室 ≤10 人，需用系数按此档取",
    "cooling": "无空调无风扇"
  }
}
```

## data/assets.json —— 家具/设备/分区需求

```jsonc
{
  "meta": { "source_file": "工作簿1.csv" },
  "work_groups": [            // ! 五组工位区（含研究生组）
    {
      "id": "G-IND", "name": "工业",
      "seats": 4,                          // ! 工位数
      "desk": { "w_cm": 120, "d_cm": 60, "h_cm": 75 },   // 单工位桌；同组拼桌时给拼法
      "desk_layout": "back-to-back 2x2",   // 拼法描述：back-to-back / 单排 / 对拼 等，null=未知
      "per_seat_power": "10A",
      "note": "CSV 行号/原文摘录"
    }
  ],
  "grad_extension": { "seats": 6, "source": "空余桌椅分配，不足后补", "desk": { "w_cm": 120, "d_cm": 60, "h_cm": 75 } },
  "spare": [                  // ! 空余桌椅（先满足研究生组，余者作杂物台面）
    { "kind": "desk", "w_cm": 120, "d_cm": 60, "qty": 6, "assigned": "grad" }
  ],
  "equipment": [              // ! 设备台（功率为缺口重点）
    { "id": "EQ1", "name": "设备台A", "w_cm": 60, "d_cm": 120, "h_cm": 81, "watts": null, "owner_group": null, "power_spec": "按功率配电位", "ops_clearance_cm": 60 }
  ],
  "storage": [
    { "id": "S1", "kind": "架子", "w_cm": 60, "d_cm": 200, "h_cm": 160, "qty": 3, "tall": true, "avoid_window": true },
    { "id": "S2", "kind": "杂物柜", "w_cm": 50, "d_cm": 100, "h_cm": 70, "qty": 1 }
  ],
  "leisure": { "target_m2": 10, "flex_m2": [8, 12], "items": ["饮水机(10A)", "16A预留×1"], "location_hint": "东墙北门附近" },
  "display": { "tables": 4, "location_hint": "南门侧", "powered": false },
  "buffer": { "target_m2_range": [3, 5], "location_hint": "架子附近" },
  "spare_chairs": { "qty": null }
}
```

## candidates/*.json —— 候选布局（P2 产出）

```jsonc
{
  "candidate_id": "B", "name": "规整岛式",
  "zones": [                  // 分区多边形（内含 placements 的包络+缓冲）。type 枚举：
    // work | grad | leisure | display | equipment | storage | buffer | reserved | corridor
    { "id": "Z1", "type": "work", "label": "工业组", "polygon": [[x,y],[x,y],…] }
  ],
  "placements": [             // ! 每件家具一条
    { "asset_id": "G-IND-D1", "ref": "assets.json 内条目或派生", "group": "G-IND",
      "x": 100, "y": 200,     // 家具外接矩形西南角
      "rot": 0,               // 0/90/180/270
      "seat_dir": "E",        // 坐姿朝向 N/E/S/W（用于椅后空间与朝向评分）
    }
  ],
  "corridors": [              // 显式声明的通道（用于疏散校验），不声明则由净空自动判定
    { "id": "C1", "from": "D-NE", "to": "D-SE", "min_width_cm": 120 }
  ]
}
```

字段约束：`zones[].polygon` 顶点按逆时针；所有 placement 必须落在某个 zone 内或与 zone 关联；同 candidate 内 asset_id 唯一。
