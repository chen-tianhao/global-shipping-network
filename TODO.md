# wsc-3d 待办

## 数据侧

- [ ] **港口等待 TEU 时序导出（P2 遗留，暂缓）**
  - 现状：`Port_Waiting_Statistics.csv` 是全程均值，图表面板只能用柱状均值，无法做“点击港口 → 等待 TEU 时序”。
  - 做法：在仿真侧新增零侵入观察者（参照 `simulation_model/trajectory_recorder.py` 的 `on_start/on_finish` 订阅方式），按统计区间（5 天）记录每港 `origin / transship / total waiting TEU`；`StatBundle` 增加 `portWaitingByPeriod`；图表面板增加“港口等待时序”模式。
  - 验收：点击港口后，图表显示该港约 72 期等待 TEU 曲线，悬停/游标能与时钟联动。
- [ ] **替代航线 `S*-ALT-*` 几何导出**
  - 现状：`routes.json` 只有 14 条主航线，`isAlternative` 全为 false；`user_strategy.py` 当前返回 `None`，运行期替代航线未落入导出。
  - 做法：在仿真侧导出运行期生成的替代航线（route id、挂靠顺序、启用时间窗），`build_geo.py` 沿用同一套避陆寻路生成几何。
- [x] **360 天真实轨迹导出与分块**
  - 已导出：`python export_trajectory.py --warmup 140 --days 360`，实测 **95 分钟**，6,766 航次 / 20,425 状态区间 / 43 船，两个 CSV 合计约 2 MB。
  - **结论：不需要分块。** 2 MB 一次性加载 + 关键帧插值，比占位模式的 52 万点还轻。原计划按 30 天切块属过度设计。
- [ ] **轨迹导出携带 service route id / vessel class**
  - 现状：`voyages.csv`/`states.csv` 只有 `VesselIndex`；真实轨迹的 `routeId` 只能置空，HUD“所属航线”显示 `—`。
  - 做法：`TrajectoryRecorder` 在 `on_start` 时读取 vessel 当前的 service route（或 vessel class），写入两列；前端 `RealTrajectoryProvider` 映射到 `VesselTrack.routeId`，恢复航线归属与贴线校验。
- [ ] **补全 `states.csv` 的 `Port` 列**
  - 现状：部分 `served` / `queuing` 行的 `Port` 为空（`TrajectoryRecorder._current_port_name` 在初始状态或未关联 segment 时取不到），前端只能隐藏该区间，导致真实模式可见船数少于导出船数。
  - 做法：在 `_make_start_handler` 里补充从 `current_segment`/泊位关系取港口名的回退；或导出时写入港口 id。验收：真实模式下每艘有状态区间的船都能落到港口锚点。

## 渲染 / 交互（P4 已完成部分）

- [x] `requestRenderMode` 真正节流：`clock.onTick` 只在仿真日变化时 `requestRender()`；冒烟断言“暂停 1.2 s 内 `postRender` ≤ 5”（实测 0）。
- [x] 生产构建移除 `preserveDrawingBuffer`（改为 `false`；截图走浏览器合成器，不受影响）。
- [x] `VesselLayer.update` 复用模块级 `Cartesian3` 暂存（`PointPrimitive.position` setter 会克隆，故不存在别名）；`DisruptionLayer.update` 的字符串键改为数值比较。
- [x] `webglcontextlost` 提示与恢复（取消默认行为 + 居中提示，`webglcontextrestored` 后重绘）。
- [x] credit 容器：底图为 `none` 时折叠，接入瓦片源（`baseLayerActive`）后自动恢复显示。
- [x] 陆地底色（B 方案）：`scripts/build_landmask.mjs` 生成 4096×2048 等经纬 RGBA 贴图（约 10 km/px、150 KB），`SingleTileImageryProvider` 叠加，边缘只向陆地一侧羽化；`npm run build:mask`。透明像素的 RGB 也填成陆地色，避免 mipmap 采样把黑色渗进海岸。
- [x] 海岸线精度 0.12° → 0.02°、小岛阈值 0.9° → 0.15°（1299 环 / 34,770 点 / 640 KB），否则区域级缩放下矢量线会被贴图"打脸"。
- [ ] 城市级精度的进一步方案：A（矢量陆地填充 + `GroundPrimitive`）或直接接影像底图；当前贴图在 ~10 km/px 以下会糊。
- [x] 分块懒加载：**不必要**。全量轨迹 2 MB（20,425 状态 / 6,766 航次），一次性加载即可。

## 工程化

- [x] `npm run build:geo` / `verify:geo` 的解释器解析：新增 `scripts/run-python.mjs`（`$WSC_PYTHON` → `.venv` → 托管运行时 → PATH），探针要求 `import numpy`；`$WSC_PYTHON` 无效时直接失败而不是静默回退。已补 `scripts/requirements.txt`。
- [ ] CI 串起 `typecheck → build → verify:motion → smoke`；`verify:geo` 在具备 numpy 的环境单独跑。
- [ ] 统一规划文档与实际数据口径（20/22 港口、`disruptions.json`）。`RouteVM.capacityTeu` 已由 `Service_Route_Utilization.csv` 关联补齐。

## 移动端（`mobile` 分支）

- [x] P0 布局：≤640px 切到「全屏地球 + 底部 sheet」，详情/图例/图层/图表全部搬入；顶部状态条与底部时间条压缩；`100dvh` + `env(safe-area-inset-*)`。
- [x] 触屏交互：关闭 hover 提示、拾取半径 3 → 22 px、详情面板加「定位到此处」替代双击飞行。
- [x] 图表窄屏收敛：隐藏 OD 矩阵（390 px 下每格约 14 px）。
- [x] 陆地底色窄屏改用 `landmask-2k.png`（GPU 约 8 MB，桌面仍用 4096）。
- [x] 横竖屏切换时布局双向搬迁，横屏回到浮动三栏。
- [ ] sheet 展开会盖住底部时间条：考虑展开时把时间条上移到 sheet 之上，或把时间控制并进 sheet。
- [ ] sheet 支持下拉/上滑手势（当前只有点击手柄）。
- [ ] 移动端 `resolutionScale` 限流（P2）。
- [ ] 真机回归：iOS Safari 安全区、双指缩放与双击冲突、中端安卓帧率。
- [ ] `flyToHome` 在竖屏下按宽高比调整 padding（当前非洲/欧洲占比偏大）。
