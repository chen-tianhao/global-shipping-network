# wsc-3d — 航运网络 3D 可视化

Cesium + Vite + TypeScript 的航运仿真 3D 可视化前端。

## 快速启动

```bash
npm install
npm run build
npx vite preview --port 4173 --host 100.85.181.126
```

## 更新数据集

当仿真项目（`WSC_SimulationChallenge_2026`）的输入或输出发生变化后，按下表选择要执行的步骤。

### 更新仿真程序中的输入和输出

输入文件路径：`../WSC_SimulationChallenge_2026/SimulationChallenge2026_Py/Input/`

输出文件路径：`../WSC_SimulationChallenge_2026/SimulationChallenge2026_Py/Output/`

### 完整流程（输入数据变了）

```bash
cd wsc-3d

# 1. 同步仿真输出（轨迹 + 统计） → public/data/
npm run build:data

# 2. 重建航线几何（读 Input/*.csv） → routes.json + waterways.json
npm run build:geo

# 3. 重建地表掩膜（读 waterways.json 刻水道） → landmask.png
npm run build:mask

# 4. 编译前端 + 几何校验 → dist/
npm run build
```

> ⚠️ `build:mask` 必须在 `build:geo` 之后执行，因为它依赖 `build:geo` 生成的 `waterways.json`。

### 仅仿真参数变了（港口/航线拓扑未变）

```bash
cd wsc-3d
npm run build:data   # 同步新轨迹
npm run build        # 编译 + 校验
```

### 命令依赖关系

```
build:data   →  public/data/trajectory/  +  public/data/stats/
build:geo    →  public/data/routes.json  +  public/data/waterways.json
                  ↓
build:mask   →  public/data/landmask.png  +  landmask-2k.png
                  ↓
build        →  dist/  +  check:routes  +  check:smoothness
```

### 数据来源

| 文件                       | 路径                                                                   | 用途                                        |
| ------------------------ | -------------------------------------------------------------------- | ----------------------------------------- |
| 输入 CSV **（需要先更新）**       | `../WSC_SimulationChallenge_2026/SimulationChallenge2026_Py/Input/`  | 港口、航线、航段、需求等                              |
| 仿真输出 **（需要先更新）**         | `../WSC_SimulationChallenge_2026/SimulationChallenge2026_Py/Output/` | 轨迹（trajectory/）、统计（*.csv）                 |
| 地理数据 **（运行npm命令时会自动更新）** | `public/data/`                                                       | routes.json、landmask.png、waterways.json 等 |

### 常用命令速查

| 命令                                                   | 说明                         |
| ---------------------------------------------------- | -------------------------- |
| `npm run build:data`                                 | 从仿真 Output 拷贝轨迹和统计数据       |
| `npm run build:geo`                                  | 从 Input CSV 寻路 + 平滑，生成航线几何 |
| `npm run build:mask`                                 | 重建地球贴图（含水道刻槽）              |
| `npm run build`                                      | 编译 + 压陆/平滑性校验              |
| `npm run check:routes`                               | 检查航线压陆                     |
| `npm run check:smoothness`                           | 检查航线折线/锯齿                  |
| `npm run smoke`                                      | 无头浏览器冒烟测试                  |
| `npx vite preview --port 4173 --host 100.85.181.126` | 本地预览（Tailscale）            |

## 项目结构

```
wsc-3d/
├── public/data/          # 前端数据资产（routes.json、landmask.png 等）
│   ├── trajectory/       # 船舶轨迹时序（states.csv + voyages.csv）
│   └── stats/            # 仿真统计聚合表
├── src/                  # 前端源码
├── scripts/              # 构建与校验脚本
│   ├── build_geo.py      # 航线寻路 + 平滑（Python）
│   ├── build_landmask.mjs # 地球贴图生成
│   ├── build-data.mjs    # 仿真输出 → public/data 同步
│   ├── check_route_land.mjs
│   └── check_route_smoothness.mjs
└── package.json
```

