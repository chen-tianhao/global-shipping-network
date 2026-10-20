# 如何验证 3D 沙盘（P1–P4）

本页回答一个问题：**怎么确认"底图 none + 可插拔地图接口 + 船舶沿不穿陆航线运动 + 真实轨迹可切换"这几步真的做完了、做对了。**

---

## 一、命令行验证（约 1 分钟，全自动）

```bash
cd wsc-3d

# 0a. 首次克隆：地理资产（需要一个能 import numpy 的 Python 与 node）
#     解析顺序：$WSC_PYTHON → .venv → 托管运行时 → PATH 上的 python。
#     没有可用解释器时，脚本会打印修复方式而不是抛出 ModuleNotFoundError。
npm run build:geo     # 航线几何（A*，耗时最长）
npm run build:coast   # 海岸线矢量（0.02°，1299 环 / 约 640 KB）
npm run build:mask    # 陆海底色贴图（4096×2048，约 150 KB）

# 0b. 统计数据 + 真实轨迹：Output/*.csv → public/data/stats；
#     Output/trajectory → public/data/trajectory（含 meta.json）
npm run build:data

# 1. 构建（分层边界检查 + 类型检查 + 打包）
#    分层规则：cesium/ 不许取数，viewmodel/ 与 ui/ 不许 import Cesium
npm run build

# 2. 起本地服务
npm run preview          # http://127.0.0.1:4173/

# 3. 无头浏览器冒烟（另开一个终端）
npm run smoke

# 4. 运动几何复核（大圆插值 / 跨经线 / 相机跨度）
npm run verify:motion

# 5. P3 真实轨迹模式冒烟（先完成第 0 步）
npm run smoke "http://127.0.0.1:4173/?provider=real"
```

`npm run smoke` 会真实启动 Chromium 打开页面，自动检查并**打印结论**：

| 检查项 | 通过标准 |
| --- | --- |
| 应用初始化 | `window.__WSC__` 存在，无未捕获异常 |
| 无控制台报错 | console error / page error 均为 0（favicon 404 除外） |
| 船舶数量 | 43 条船全部创建且可见（14 条主航线按配船数生成） |
| 时钟推进 | 仿真日在播放期间持续增长 |
| 船舶位移 | 2.5 秒后船的位置发生变化（即插值渲染生效） |
| **船舶贴线** | 所有可见船舶距所属航线 **< 10 nm**（1 小时采样 + 帧间插值；跨经线采样错误会到数千海里） |
| **扰动图层** | 8 个扰动对象全部创建；6 条拥堵航段全部使用 `routes.json` 的真实航段几何，而非两港直线 |
| **图表面板** | 3 个页签（ATT 时序 / 港口等待 / OD 矩阵）；Plotly 首图渲染成功 |
| **交互联动** | 时间条"下一扰动"跳到 Day 40 并暂停；图表悬停把时钟定位到 Day 120 并暂停；图表选中上海后详情面板显示 `Shanghai`，页签切到"港口等待" |
| **相机与预热** | 4 个视角预设存在；勾选预热后时钟起点变为 `2025-08-14`（Day -140），时间条显示 `Day -140` |
| **真实轨迹模式**（`?provider=real`） | `isPlaceholder=false`、占位横幅消失；时钟范围 `Day 0…360`；43 船全部可见；预热起点 `2025-08-14`（Day -140） |
| **航线弧线** | 渲染前按 ≤50 km 加密，最长弦 50 km；断言 `maxRouteSegKm ≤ 60`、顶点数 ≥ 3000。未加密时最长弦 8,787 km、下沉 1,757 km |
| **渲染节流** | 暂停后 1.2 秒内 `postRender` 次数 ≤ 5（预期 0）；这项曾经必然失败——`clock.onTick` 每帧无条件 `requestRender()` |
| 时间轴刻度 | 占位模式覆盖 2026-01-01 → 2026-12-27；真实模式覆盖 2026-01-01 → 2026-01-11 |
| 截图 | 输出 `smoke-screenshot.png`（初始场景）与 `smoke-interaction.png`（选中上海 + 预热期后的场景） |

`verify:motion` 会编译 `src/data/geo/geoMath.ts` 并对每条航段做 25 nm 步长的大圆采样，
检查采样点是否贴着大圆弧、中点是否等于独立向量中点、跨 180° 经线是否走短弧，
以及 S4/S9 的相机经度跨度是否收敛到太平洋（< 150°）。

看到 `SMOKE OK` 即通过；失败会明确列出哪几项不合格。

> 冒烟默认使用 `C:\Program Files\Google\Chrome\Application\chrome.exe`，
> 换浏览器：`WSC_CHROME="路径" npm run smoke`；换目标地址：`npm run smoke http://其他地址/`。

---

## 二、浏览器手工验证（5 分钟）

打开 <http://127.0.0.1:4173/>，逐项核对：

**画面**
- [ ] 深色裸地球上有**自绘海岸线**（因为底图 = none，这是唯一能看到大陆的方式）
- [ ] **陆地比海面明显更亮**（"陆地底色"图层）：缩放到区域级（约 900 km 高）后，仍能一眼看出哪侧是陆地
- [ ] 左上"图层"里关掉"陆地底色"，陆地与海面恢复同色；关掉"海岸线"，边界线消失
- [ ] 青色航线**贴着海岸走**：亚欧线绕好望角/苏伊士，跨太平洋线沿大圆航路
- [ ] 22 个港口有圆点 + 名称，近看颜色不同（按等待 TEU 上色）
- [ ] 船舶小点沿航线移动，颜色代表状态

**交互**
- [ ] 顶部播放条：播放/暂停可切，速度可调（1 时/秒 ~ 3 天/秒），拖动滑块可跳到任意一天
- [ ] **"下一扰动"**：点击跳到下一个扰动起点（首次 Day 40）并暂停，相机定位到受影响港口/航段；连续点击可逐个走完 8 个事件
- [ ] 底部 Cesium 时间轴可拖动，刻度是仿真日期而非真实日期
- [ ] 左下角图层开关：逐个关掉海岸线 / 航线 / 港口 / 扰动事件 / 船舶，画面相应增减
- [ ] **单击**港口/航线/船舶 → 高亮 + 右侧详情；**双击** → 相机飞过去（单击不再强制拉镜头）
- [ ] 鼠标悬停在要素上 → 跟随指针的轻量 tooltip（港口/航线/船舶/扰动）
- [ ] 左下角"视角"：全球 / 东亚 / 北欧 / 北美四个预设可切换
- [ ] 左下角"时间范围"：勾选"含预热期"后，时间条起点变为 `Day -140`（2025-08-14），取消后回到 `Day 0`
- [ ] 点击航线 → 显示里程、配船数、舱位利用率
- [ ] 左上角有黄色横幅：**"船舶运动为占位数据"**——这是刻意的，防止把占位运动误读为仿真结果

**图表与联动（P2）**
- [ ] 右下角统计图表面板有三个页签：ATT 时序 / 港口等待 / OD 矩阵
- [ ] ATT 时序：悬停曲线 → 三维时钟定位到对应天并暂停；竖线随当前时钟移动
- [ ] 点击三维港口 → 图表面板自动切到"港口等待"，对应柱状高亮；点击柱状 → 三维选中并飞到该港
- [ ] OD 矩阵：22×22 热力图；点击单元高亮起讫两港并把相机框到两港之间，底部提示该 OD 的平均在途 TEU
- [ ] 图表页签可"收起/展开"，不遮挡地球操作

> 说明：`Port_Waiting_Statistics.csv` 是**全程均值**，不是时序；因此"港口等待"图是柱状均值，
> 真正的港口时序需要仿真侧新增按统计区间的快照导出（数据侧待办）。ATT 是现有唯一的时序 CSV。

**控制台（F12）**
- [ ] 无红色报错

---

## 三、验证"地图接口预留"这件事本身

接口代码在 `src/cesium/baseLayer/baseLayerProvider.ts`，验证方式有两种：

1. **读文档**：`src/cesium/baseLayer/README.md` 写清了三步接入法（建 provider 文件 → 注册到 `BASE_LAYER_REGISTRY` → 在 `src/app/config.ts` 或 URL 参数里启用）。
2. **实测回退链路**：访问 `http://127.0.0.1:4173/?baseLayer=不存在的名字`
   → 页面应正常打开并回退到无底图，同时控制台有一条 warning 列出可用底图 id。
   这说明"未知底图 → 安全回退"的防线是真实生效的，而不是只写在注释里。

---

## 四、验证"船不穿陆地"这件事本身

这条保证由两层组成，必须**两层都过**：

```bash
npm run verify:geo          # 第一层：航线几何（0.1° 独立网格重放全部 70 个航段）
npm run verify:motion       # 第二层：船舶采样是否贴着那条航线（大圆 + 跨经线）
```

- `verify:geo` 输出应包含 `land crossing: 0`（陆地穿越为 0）、若干 coastal graze（擦岸警告，属正常）。
  参考报告在 `public/data/geo_report.json`（含每条航段的里程与绕行比）。
- `verify:motion` 输出应包含 `VERIFY MOTION OK`：11,000+ 个采样点全部贴在大圆弧上，
  4 条跨 180° 经线的航段走短弧，S4/S9 的相机跨度分别收敛到约 122°/124°（而不是 354°/360°）。
- `npm run smoke` 的"船舶贴线"再兜一层端到端：运行时每条船距其航线 < 10 nm。
  两层几何校验 + 一层运行时校验，才等价于"船不穿陆地"。

---

## 五、验证 P3 真实轨迹

```bash
npm run build:data -- --warm-up-days=140 --measurement-days=360
npm run preview
# 浏览器打开：http://127.0.0.1:4173/?provider=real
npm run smoke "http://127.0.0.1:4173/?provider=real"
```

通过时应看到：

- 顶部黄色"占位数据"横幅**消失**，副标题变为 `运动：真实轨迹 -140…360`；
- 时钟范围 `2026-01-01 → 2026-12-27`，与占位模式一致；
- **43 艘船全部有轨迹**（全量导出覆盖所有船），昼夜位置由 `states.csv` 驱动；
- 预热开关显示 140 天，勾选后时钟起点 `2025-08-14`（Day -140）；
- `SMOKE OK`，且 `isPlaceholder=false`、`hasPlaceholderWarning=false`。

**时间与位置口径**

- `SimDay = (year-1 timestamp - meta.measurementStartIso) / 86400000`；预热期为负。
- `states.csv` 的 `sailing` 区间按 `voyages.csv` 的离港/到港时间在对应航段几何上插值；
  `queuing` / `served` 停在港口锚点。
- `meta.json` 的 `measurementStartIso` 由 `build-data.mjs` 按 `--warm-up-days` 生成；
  本次全量导出的口径为 `0001-05-21T00:00:00`（140 天预热）。
- 全量轨迹已导出：`python export_trajectory.py --warmup 140 --days 360`（实测 95 分钟，6,766 航次 / 20,425 个状态区间，约 2 MB），
  前端资产用 `npm run build:data -- --warm-up-days=140 --measurement-days=360` 生成。

---

## 六、已知边界（读结果时别误判）

- 默认运动来自 `PlaceholderMotionProvider`：等速巡航、无排队/靠泊/扰动响应，**只用于打通渲染链路**；`?provider=real` 才使用导出轨迹。
- 当前真实轨迹为**全量导出**：140 天预热 + 360 天计测、43 艘船、6,766 个航次、20,425 个状态区间，两个 CSV 合计约 2 MB，**不需要分块**（这也是 TODO 里分块项的结论）。
- 导出不携带 service route id，因此真实轨迹的 `routeId` 为 null：HUD 船舶详情里"所属航线"显示 `—`，冒烟的贴线检查会跳过这些船（但位置仍按 `routes.json` 的航段几何插值）。
- `queuing` / `served` 的位置是港口锚点，不是泊位级位置。
- `states.csv` 中 `sailing` 行的 `Port` 为空是正常的（船在海上）；另有 43 条 `queuing` / 49 条 `served`（初始状态，未关联 segment）缺港口名，这些区间只能隐藏。全量样本下 43 艘船在 Day 0.5 均已可见，影响可忽略；补全项仍记在 `TODO.md`。
- 统计数据（ATT/港口等待/OD）与轨迹现在都来自**同一批 360 天**运行，时间口径已对齐。
- 占位轨迹按 **1 小时**采样（43 船 × 8,641 帧 ≈ 37 万点）。渲染层在帧间做直线插值，急弯处的切角约 3 nm，冒烟阈值设为 10 nm；若要进一步压到 1 nm 以内，可把步长减半，代价是内存翻倍。
- 底图 = none，所以画面只有自绘海岸线 + 陆海底色；接入你自己的地图服务后，这两层会自动关闭（也可在左下角手动开关），避免盖住影像。
- **陆地底色是单张 4096×2048 等经纬贴图**（约 10 km/px，GPU 约 32 MB）：区域级缩放够用，城市级再放大仍会看到软过渡；精确边界始终由矢量海岸线承担。
- 贴图由 Natural Earth `land` 生成，**不含湖泊**：五大湖、里海以外的内陆湖会被当作陆地着色（里海在源数据里是唯一一个孔洞，已正确挖空）。
- 海岸线矢量已提到 0.02°（1299 环 / 34,770 点 / 640 KB，gzip 后约 250 KB），足够与贴图对齐；再细就会超过 Natural Earth 50m 本身的精度。
- 4 条 Tanger Med↔Rotterdam 相关航段的"绕行比 > 2"警告是正常的：其名义航段本身横穿欧洲大陆，几何上必须绕行。
- 图表使用 vendored `public/vendor/plotly.min.js`（4.5 MB，懒加载）。首次打开"统计图表"时可能有一两秒的"正在加载图表库"提示；不阻塞三维启动。
- "港口等待"是全程均值，"OD 矩阵"是平均在途 TEU；只有 ATT 是时序。港口等待时序需要仿真侧新增按区间快照导出（见 `TODO.md`）。
- 预热期（占位模式 Day -140 ~ -1 / 真实模式 Day -20 ~ -1）的船舶位置同样来自对应 provider；占位模式的预热位置不代表真实行为。
- **航线是"加密后的弦"，不是真正的测地线图元**：`PolylineCollection` 的 `Polyline` 没有 `arcType`（传入会被静默忽略），所以 `RouteLayer` 与拥堵航段在提交前用 `densifyGreatCircle` 按 50 km 采样（弦误差 49 m），并去掉首尾重复点、用 `loop` 闭合。全库 5,767 个顶点。
- **暂停时画面不再重绘**（`requestRenderMode` 现在真的生效）：拖动时间轴、切换图层、移动相机都会各自请求一帧，所以视觉上没有差别；但如果你在控制台用 `toDataURL()` 抓图，会得到空帧——`preserveDrawingBuffer` 已关闭，截图请用浏览器截图或 `npm run smoke`（走合成器捕获，不受影响）。
- **Credit 容器**在底图为 `none` 时被折叠（没有可署名内容）；接入瓦片源后会自动恢复显示，`src/cesium/baseLayer/README.md` 里要求保留的 attribution 因此不会被吞掉。
- **WebGL 上下文丢失**时画面中央会出现"渲染上下文丢失，正在尝试恢复 …"提示；恢复后自动消失并重绘一帧。

---

## 七、部署（静态站点）

构建产物是纯静态的，把 `dist/` 的**内容**整体上传即可。关键只有一条：`data/` 必须和 `index.html` **同级**。

```text
<站点根>/
├── index.html
├── assets/                  # JS / CSS（带 hash）
├── cesium/                  # Cesium 运行时
├── vendor/plotly.min.js     # 图表库（懒加载）
└── data/
    ├── ports.json
    ├── routes.json
    ├── route_plan.csv
    ├── vessel_classes.csv
    ├── coastline.json       # 可选：海岸线矢量
    ├── landmask.png         # 可选：陆海底色
    ├── stats/*.csv          # 7 个统计表
    └── trajectory/          # 可选：真实轨迹
        ├── meta.json
        ├── voyages.csv
        └── states.csv
```

**Cloudflare Pages 配置（当前部署方式）**

| 配置项 | 值 |
| --- | --- |
| Root directory | `wsc-3d` |
| Build command | `npm ci && npm run build` |
| Build output directory | `dist` |
| 环境变量 | `NODE_VERSION=22.12.0`（仓库已带 `.nvmrc`，一般不用再填） |

三个必须记住的点：

1. **不要把 `dist/` 的内容拷回仓库根再提交。** 仓库根的 `index.html` 必须是 Vite 源入口（引 `/src/main.ts`）。拷回来之后，`vite build` 会把上一次的产物当成源码入口再打一次包，于是源码改动永远不生效、`assets/` 和 `cesium/` 还会被重复提交几十 MB。
2. **`public/data` 下的生成物必须入库**（`.gitignore` 已放行）。Pages 的构建机没有 `WSC_SimulationChallenge_2026` 的仿真输出，也没预装 numpy，跑不了 `build:geo` / `build:data`；不入库就必然出现 `/data/ports.json` 404。
3. 构建末尾的 `check:dist` 会在缺文件时直接失败，Pages 的构建日志里能一眼看到缺哪一项、该跑哪个命令。

**局域网 / Tailscale 预览**

```bash
npx vite preview --port 4173 --host 100.85.181.126
```

绑定到具体网卡而不是 `0.0.0.0`：只有 Tailscale 网段可达，不暴露到物理局域网。
注意绑定后 `127.0.0.1` 不再监听，冒烟必须显式传地址：

```bash
WSC_SHOTS=0 npm run smoke "http://100.85.181.126:4173/"
```

Windows 防火墙需要放行 `node.exe` 入站（本机 Private/Public 已有 Node.js 规则）。

**路径解析规则**

- `dataBaseUrl` 默认是 `data`，**相对当前页面 URL** 解析。站点是 `https://host/ship/` → 请求 `https://host/ship/data/...`。
- 放在子路径时**务必带结尾斜杠**访问：`/ship/`。`/ship` 会被解析成站点根，`assets` 和 `data` 全部 404（多数静态服务器会自动 301，但反向代理未必）。
- 数据放在别处（CDN / 对象存储）时：
  - URL 覆盖：`?data=https://cdn.example.com/wsc/`
  - 或在 `index.html` 的模块脚本**之前**：`<script>window.WSC_CONFIG = { dataBaseUrl: 'https://cdn.example.com/wsc' }</script>`

**最容易踩的坑：生成物被 git 忽略**

`public/data` 下的 `*.json`、`stats/`、`trajectory/`、`landmask.png` 都是脚本产物，**不在版本控制里**。所以"从 git 拉代码 → `vite build` → 部署"的流水线打出来的包**没有数据**，上线后就会报：

```text
SyntaxError: Unexpected token '<', "<!doctype "... is not valid JSON
```

因为静态服务器对缺失路径回退到 `index.html`，返回 200 + HTML。流水线里必须补：

```bash
npm run build:geo      # routes.json / ports.json
npm run build:coast    # coastline.json
npm run build:mask     # landmask.png
npm run build:data -- --warm-up-days=140 --measurement-days=360
npm run build          # 末尾自动跑 check:dist
```

`npm run check:dist` 会逐项检查 `dist/data` 是否存在、是否为空、JSON 是否真的是 JSON；缺任何必需文件都会直接失败并打印补哪一步。也可以单独跑：`npm run check:dist`。

**线上仍报这个错时的 30 秒定位**

在浏览器直接打开 `https://host/.../data/ports.json`：

- 看到 JSON → 数据没问题，检查是不是 `?data=` 指错了目录；
- 看到 `<!doctype html>` → 该路径**没有文件**，服务器回退到了首页。对照上面的目录树补文件。

---

## 八、移动端（≤ 640 px）

桌面布局是三个浮动面板（214 + 250 + 380 px），390 px 的手机上必然互相遮挡，所以窄屏切换成**全屏地球 + 底部抽屉**：

| 断点 | 布局 |
| --- | --- |
| `> 640px` | 现有三栏浮动面板 |
| `≤ 640px` | 顶部状态条 + 底部时间条 + 底部 sheet（详情 / 图例 / 图层 / 图表，可滚动） |

**窄屏下的具体变化**

- 详情、图例、图层、图表全部搬进 sheet，点击地球上的对象会自动把 sheet 抬起；
- 时间条固定在 sheet 的 dock（手柄下方），展开时不会被内容盖住；手柄支持上滑/下滑拖拽，点击也可切换；
- 触屏没有 hover，悬浮提示关闭；`"定位到此处"` 按钮替代桌面端的双击飞行；
- 拾取半径从 3 px 提到 22 px，手指点得中；
- 图表只保留 `ATT 时序` 与 `港口等待`：22×22 的 OD 矩阵在 390 px 下每格约 14 px，低于触控目标下限；
- 陆地底色改用 `landmask-2k.png`（GPU 约 8 MB，不再是 32 MB）；
- `100dvh` + `env(safe-area-inset-*)`，避开 iOS 地址栏与刘海；
- 横竖屏切换时布局会**双向搬迁**（横屏宽于断点，面板自动搬回地球上方，sheet 移除）。

**验证**

```bash
npm run smoke:mobile        # 390×844 视口，自动断言 sheet 结构
```

输出三张图：

| 文件 | 内容 |
| --- | --- |
| `smoke-mobile.png` | 竖屏初始状态（sheet 收起） |
| `smoke-mobile-sheet.png` | 点开 sheet：详情 + 图例 + 图层 |
| `smoke-mobile-interaction.png` | 交互后（选中上海、切到港口等待页签） |

断言包含：viewport 确实是 390 px、sheet 存在、详情与图表确实在 sheet 内、时间条确实在 dock 内且完整落在视口里、页签数为 2、拖拽手柄向下可关闭/向上可打开、旋转到 844×390 后 sheet 被移除且面板回到浮动布局。

截图是诊断产物，不是断言：`WSC_SHOTS=0 npm run smoke:mobile` 可在禁止写文件的限制环境下跑完整检查。

**当前的已知限制**

- 未在真机上验证过：iOS Safari 的安全区、双指缩放与页面手势的冲突、低端安卓的帧率。真机回归是下一步。
- 桌面端不受影响：`npm run smoke` 会断言 `sheet` 不存在、页签仍为 3 个。
