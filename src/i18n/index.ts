/**
 * Runtime localisation: two locales, one flat dictionary, no dependencies.
 *
 * WHY NOT A LIBRARY
 * -----------------
 * The whole UI is a few hundred strings in plain DOM. An i18n library would add
 * a runtime, a plural-rule engine and a build step for a problem that is solved
 * by one object lookup here.
 *
 * TWO KINDS OF TEXT
 * -----------------
 *   1. Static labels (panel titles, legend headings, buttons) are tagged with
 *      `data-i18n="key"`. `setLocale` walks the document once and rewrites
 *      them, so nothing needs to be rebuilt or re-parented - important because
 *      the mobile sheet moves panels around.
 *   2. Text that depends on state (a selected port, the warm-up day count, the
 *      clock read-out) carries placeholders and is rebuilt by the owning module
 *      through its own `refresh()`, which the bootstrap subscribes to.
 *
 * The Chinese dictionary is the source of truth: `MessageKey` is derived from
 * it, so the English table fails to compile if a key is missing.
 */

export type Locale = 'zh' | 'en';

export const LOCALES: Locale[] = ['zh', 'en'];

const DEFAULT_LOCALE: Locale = 'zh';
const STORAGE_KEY = 'wsc.locale';

const ZH = {
  'app.title': '全球集装箱航运网络 · 3D 沙盘',
  'app.loading': '正在加载网络与仿真数据 …',
  'app.error': '初始化失败：{message}',

  'status.subtitle': '底图：{base} · 运动：{motion}',
  'status.noTiles': '{base} — 无瓦片',
  'status.motionPlaceholder': '占位合成',
  'status.motionReal': '真实轨迹 {start}…{end}',
  'status.placeholder':
    '船舶运动为占位数据：等速沿航线巡航，不含排队、靠泊与扰动响应，不能读作仿真结果。',

  'locale.switchTo': '切换为英文',

  'baseLayer.none': '无底图（纯色地球 + 自绘海岸线）',
  'baseLayer.unknown': '未知底图 "{id}"，已回退到 none',
  'baseLayer.missingKey': '{label}（缺少 key，已回退到无底图）',

  'layer.coastline': '海岸线',
  'layer.landwash': '陆地底色',
  'layer.routes': '航线',
  'layer.ports': '港口',
  'layer.disruptions': '扰动事件',
  'layer.vessels': '船舶',

  'hud.legendPorts': '港口 · 等待 TEU',
  'hud.legendVessels': '船舶 · 状态',
  'hud.panelLegend': '图例',
  'hud.panelLayers': '图层',
  'hud.panelCamera': '视角',
  'hud.panelTimeRange': '时间范围',
  'hud.panelDetails': '详情',
  'hud.warmUp': '含预热期（{days} 天）',
  'hud.detailsEmpty': '点击地球上的港口、航线、船舶或扰动事件查看详情。',
  'hud.locate': '定位到此处',

  'state.sailing': '航行中',
  'state.queuing': '锚地等待',
  'state.served': '在泊作业',
  'state.idle': '闲置',

  'preset.global': '全球',
  'preset.east-asia': '东亚',
  'preset.north-europe': '北欧',
  'preset.north-america': '北美',

  'field.berths': '泊位数',
  'field.coords': '经纬度',
  'field.waitingTeu': '等待 TEU',
  'field.coordSource': '坐标来源',
  'value.sourceVerified': '公开资料核对',
  'value.sourceUnverified': '未核对',
  'field.seaAccess': '入海处理',
  'value.channelDredged': '已开凿通道',
  'field.serviceRoute': '所属航线',
  'field.route': '航线',
  'field.waypoints': '挂靠航段',
  'value.waypointCount': '{count} 个路径点',
  'field.distance': '航线里程',
  'field.vesselCount': '配船数',
  'field.capacity': '平均舱位',
  'field.utilization': '舱位利用率',
  'field.type': '类型',
  'value.closedPort': '港口关闭',
  'value.segmentCongestion': '航段拥堵',
  'field.target': '目标',
  'field.window': '时间窗',
  'field.magnitude': '强度',
  'value.closed': '关闭',
  'field.samples': '采样点',

  'time.play': '播放',
  'time.pause': '暂停',
  'time.nextDisruption': '下一扰动',
  'time.readout': '{day} · {date} / 至 Day {end}',
  'speed.hour1': '1 时/秒',
  'speed.hour6': '6 时/秒',
  'speed.day1': '1 天/秒',
  'speed.day3': '3 天/秒',

  'chart.title': '统计图表',
  'chart.tabAtt': 'ATT 时序',
  'chart.tabPorts': '港口活动',
  'chart.tabOd': 'OD 矩阵',
  'chart.collapse': '收起',
  'chart.expand': '展开',
  'chart.empty': '统计 CSV 未加载，或该图表没有数据。',
  'chart.loading': '正在加载图表库 …',
  'chart.error': '图表加载失败：{message}',
  'chart.attX': '仿真天（Day）',
  'chart.attY': '平均运输时间（天）',
  'chart.portsX': '等待 TEU（全程均值）',
  'chart.hintAtt': '悬停曲线定位时间；竖线为当前时钟位置。',
  'chart.hintPorts': '点击柱状图选中港口，三维视图会同步高亮。',
  'chart.hintOd': '点击矩阵单元选中起点港口；颜色为平均在途 TEU。',
  'chart.hintAttHover': 'Day {day} · 平均运输时间 {value} 天',
  'chart.hintValue': '{name}：{value} TEU',
  'chart.hintSelectedPort': '已选港口：{name}',
  'chart.hintSelected': '已选：{name}',
  'chart.hintOdCell': 'OD {pair}：{value} TEU（起讫港已选中）',

  'kind.port': '港口',
  'kind.route': '航线',
  'kind.vessel': '船舶',
  'kind.disruption': '扰动',

  'disruption.portClosed': '{port} 关闭 {days} 天',
  'disruption.segment': '{from} → {to} 航段拥堵 ×{mult}',

  'globe.contextLost': '渲染上下文丢失，正在尝试恢复 …',

  'error.trajectoryMissing':
    '真实轨迹数据不可用（{root}/trajectory）。请先运行 npm run build:data。',
  'error.rawDetail': ' 原始错误：{message}',
  'error.metaIso': 'meta.json 的 measurementStartIso 无法解析：{value}',
  'error.noStates': 'states.csv 中没有可用的状态区间',

  'sheet.label': '详情 · 图层 · 图表',
  'sheet.aria': '展开或收起详情、图层与图表',
} as const;

export type MessageKey = keyof typeof ZH;

type Vars = Record<string, string | number>;

const EN: Record<MessageKey, string> = {
  'app.title': 'Global Container Shipping Network · 3D Sandbox',
  'app.loading': 'Loading network and simulation data …',
  'app.error': 'Failed to start: {message}',

  'status.subtitle': 'Base map: {base} · Motion: {motion}',
  'status.noTiles': '{base} — no tiles',
  'status.motionPlaceholder': 'Synthetic placeholder',
  'status.motionReal': 'Trajectory {start}…{end}',
  'status.placeholder':
    'Vessel motion is placeholder data: constant-speed cruising along the routes, with no queuing, berthing or disruption response. Not a simulation result.',

  'locale.switchTo': 'Switch to Chinese',

  'baseLayer.none': 'No base map (flat globe + drawn coastline)',
  'baseLayer.unknown': 'Unknown base map "{id}", fell back to none',
  'baseLayer.missingKey': '{label} (missing key, fell back to no base map)',

  'layer.coastline': 'Coastline',
  'layer.landwash': 'Land tint',
  'layer.routes': 'Routes',
  'layer.ports': 'Ports',
  'layer.disruptions': 'Disruptions',
  'layer.vessels': 'Vessels',

  'hud.legendPorts': 'Ports · waiting TEU',
  'hud.legendVessels': 'Vessels · state',
  'hud.panelLegend': 'Legend',
  'hud.panelLayers': 'Layers',
  'hud.panelCamera': 'View',
  'hud.panelTimeRange': 'Time range',
  'hud.panelDetails': 'Details',
  'hud.warmUp': 'Include warm-up ({days} days)',
  'hud.detailsEmpty':
    'Click a port, route, vessel or disruption on the globe to see details.',
  'hud.locate': 'Fly here',

  'state.sailing': 'Sailing',
  'state.queuing': 'Waiting at anchorage',
  'state.served': 'Alongside',
  'state.idle': 'Idle',

  'preset.global': 'World',
  'preset.east-asia': 'East Asia',
  'preset.north-europe': 'North Europe',
  'preset.north-america': 'North America',

  'field.berths': 'Berths',
  'field.coords': 'Lon / lat',
  'field.waitingTeu': 'Waiting TEU',
  'field.coordSource': 'Coordinate source',
  'value.sourceVerified': 'Checked against public sources',
  'value.sourceUnverified': 'Unverified',
  'field.seaAccess': 'Sea access',
  'value.channelDredged': 'Channel cut',
  'field.serviceRoute': 'Service route',
  'field.route': 'Service route',
  'field.waypoints': 'Waypoints',
  'value.waypointCount': '{count} waypoints',
  'field.distance': 'Distance',
  'field.vesselCount': 'Vessels',
  'field.capacity': 'Avg capacity',
  'field.utilization': 'Utilisation',
  'field.type': 'Type',
  'value.closedPort': 'Port closure',
  'value.segmentCongestion': 'Leg congestion',
  'field.target': 'Target',
  'field.window': 'Window',
  'field.magnitude': 'Magnitude',
  'value.closed': 'Closed',
  'field.samples': 'Samples',

  'time.play': 'Play',
  'time.pause': 'Pause',
  'time.nextDisruption': 'Next event',
  'time.readout': '{day} · {date} / to Day {end}',
  'speed.hour1': '1 h/s',
  'speed.hour6': '6 h/s',
  'speed.day1': '1 d/s',
  'speed.day3': '3 d/s',

  'chart.title': 'Statistics',
  'chart.tabAtt': 'ATT over time',
  'chart.tabPorts': 'Port activity',
  'chart.tabOd': 'OD matrix',
  'chart.collapse': 'Collapse',
  'chart.expand': 'Expand',
  'chart.empty': 'Statistics CSV not loaded, or this chart has no data.',
  'chart.loading': 'Loading chart library …',
  'chart.error': 'Chart failed to load: {message}',
  'chart.attX': 'Simulation day',
  'chart.attY': 'Average transit time (days)',
  'chart.portsX': 'Waiting TEU (run average)',
  'chart.hintAtt': 'Hover the curve to seek; the line marks the current clock.',
  'chart.hintPorts': 'Click a bar to select the port; the 3D view highlights it.',
  'chart.hintOd': 'Click a cell to select the origin port; colour is average in-transit TEU.',
  'chart.hintAttHover': 'Day {day} · average transit {value} days',
  'chart.hintValue': '{name}: {value} TEU',
  'chart.hintSelectedPort': 'Port selected: {name}',
  'chart.hintSelected': 'Selected: {name}',
  'chart.hintOdCell': 'OD {pair}: {value} TEU (both ports selected)',

  'kind.port': 'Port',
  'kind.route': 'Route',
  'kind.vessel': 'Vessel',
  'kind.disruption': 'Disruption',

  'disruption.portClosed': '{port} closed for {days} days',
  'disruption.segment': '{from} → {to} leg congestion ×{mult}',

  'globe.contextLost': 'Rendering context lost, trying to recover …',

  'error.trajectoryMissing':
    'Trajectory data unavailable ({root}/trajectory). Run npm run build:data first.',
  'error.rawDetail': ' Underlying error: {message}',
  'error.metaIso': 'Cannot parse measurementStartIso in meta.json: {value}',
  'error.noStates': 'states.csv contains no usable state intervals',

  'sheet.label': 'Details · Layers · Charts',
  'sheet.aria': 'Expand or collapse details, layers and charts',
};

const STRINGS: Record<Locale, Record<MessageKey, string>> = { zh: ZH, en: EN };

const HTML_LANG: Record<Locale, string> = { zh: 'zh-CN', en: 'en' };

let locale: Locale = DEFAULT_LOCALE;

const listeners = new Set<(next: Locale) => void>();

export function currentLocale(): Locale {
  return locale;
}

/** Locale of the built-in date/number formatting helpers. */
export function numberLocaleTag(): string {
  return locale === 'zh' ? 'zh-CN' : 'en-US';
}

/**
 * Resolve the initial locale: `?lang=` > stored choice > Chinese.
 *
 * Browser-language sniffing is deliberately not used: the deployment is
 * Chinese-first, and silently switching on an en-US browser would change what
 * existing links show.
 */
export function initLocale(): Locale {
  const fromUrl = normalise(new URLSearchParams(window.location.search).get('lang'));
  const stored = normalise(readStored());
  // A ?lang= link is an explicit choice, so it is remembered like a button
  // click: following an English link and then opening the bare URL keeps
  // English instead of snapping back.
  return applyLocale(fromUrl ?? stored ?? DEFAULT_LOCALE, {
    persist: Boolean(fromUrl),
  });
}

/** Flip between the two locales; returns the new one. */
export function toggleLocale(): Locale {
  return setLocale(locale === 'zh' ? 'en' : 'zh');
}

export function setLocale(next: Locale): Locale {
  return applyLocale(next, { persist: true });
}

/**
 * Text lookup with `{placeholder}` interpolation. Unknown keys fall back to
 * Chinese and then to the key itself, so a missing translation degrades to
 * readable text instead of an empty label.
 */
export function t(key: MessageKey, vars?: Vars): string {
  const template =
    STRINGS[locale][key] ?? (ZH as Record<string, string>)[key] ?? key;
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in vars ? String(vars[name]) : match,
  );
}

/** Subscribe to locale changes; returns an unsubscribe function. */
export function onLocaleChange(fn: (next: Locale) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Rewrite every tagged element under `root`.
 *
 * Only elements that own their text are tagged - never a container whose
 * children are tagged too, since `textContent` would wipe them.
 */
export function translateDom(root: ParentNode = document): void {
  for (const node of root.querySelectorAll<HTMLElement>('[data-i18n]')) {
    const key = node.dataset.i18n as MessageKey | undefined;
    if (key) node.textContent = t(key);
  }
  for (const node of root.querySelectorAll<HTMLElement>('[data-i18n-aria]')) {
    const key = node.dataset.i18nAria as MessageKey | undefined;
    if (key) node.setAttribute('aria-label', t(key));
  }
}

function applyLocale(next: Locale, options: { persist: boolean }): Locale {
  locale = next;
  document.documentElement.lang = HTML_LANG[next];
  document.documentElement.dataset.locale = next;
  if (options.persist) writeStored(next);
  translateDom(document);
  for (const fn of listeners) fn(next);
  return next;
}

function normalise(value: string | null | undefined): Locale | null {
  if (!value) return null;
  const head = value.trim().toLowerCase().split(/[-_]/)[0];
  if (head === 'zh' || head === 'cn') return 'zh';
  if (head === 'en') return 'en';
  return null;
}

function readStored(): string | null {
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    // Private mode / blocked storage: a language preference is not worth an
    // exception, the session just falls back to the default.
    return null;
  }
}

function writeStored(next: Locale): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, next);
  } catch {
    /* ignore */
  }
}
