# 底图层：怎么加你自己的地图

## 现状

默认底图是 `none` —— 不加载任何第三方瓦片，地球用纯色渲染，海岸线由应用自己绘制。
没有 key、没有瓦片授权问题、可以完全离线运行。

底图是一个可插拔适配器，替换它**不需要改动渲染层、图层或 UI 的任何代码**。

## 三步接入

### 1. 新建 provider 文件

在 `src/cesium/baseLayer/` 下新建文件，实现 `BaseLayerProvider`：

```ts
import { UrlTemplateImageryProvider } from 'cesium';
import { KEY_PLACEHOLDER, type BaseLayerProvider } from './baseLayerProvider';
import type { ImageryProvider } from 'cesium';

export class MyBaseLayerProvider implements BaseLayerProvider {
  readonly id = 'my-map';
  readonly label = '我的底图';
  readonly requiresKey = true;             // UI 会据此提示缺 key
  readonly complianceNote = '数据来源：<填写来源与授权情况>';

  async createImageryProvider(): Promise<ImageryProvider | null> {
    const key = window.WSC_MAP_CONFIG?.apiKey;
    if (!key || key === KEY_PLACEHOLDER) {
      console.warn('[baseLayer] 缺少 key，回退到无底图');
      return null;                          // 返回 null 即回退到纯色地球
    }
    return new UrlTemplateImageryProvider({
      url: `https://your-tile-host/{z}/{x}/{y}.png?key=${key}`,
      maximumLevel: 8,
      credit: 'your data source',
    });
  }
}
```

要点：

- **返回 `null` 是合法的**， viewer 会自动回退到纯色地球，不会白屏。
- 用 Cesium 内置的 `UrlTemplateImageryProvider`（XYZ/WMTS 模板）、`WebMapTileServiceImageryProvider`（WMTS）
  或 `ArcGisMapServerImageryProvider` 等，无需自己写瓦片调度。
- WMTS 用 `WebMapTileServiceImageryProvider({ url, layer, style, tileMatrixSetID, format })`。

### 2. 注册

在 `baseLayerProvider.ts` 的 `BASE_LAYER_REGISTRY` 里加一行：

```ts
export const BASE_LAYER_REGISTRY: Record<string, () => BaseLayerProvider> = {
  none: () => new NoneBaseLayerProvider(),
  'my-map': () => new MyBaseLayerProvider(),   // 新增
};
```

### 3. 启用

三种方式，任选：

```ts
// src/app/config.ts
baseLayer: 'my-map',
```

```html
<!-- 运行时注入，不用改代码重新构建 -->
<script>
  window.WSC_MAP_CONFIG = { baseLayer: 'my-map', apiKey: '...' };
</script>
```

```
# 或者 URL 参数临时试一下
http://localhost:5173/?baseLayer=my-map
```

## key 的处理规则

- **源码里只允许出现占位符** `KEY_PLACEHOLDER`，禁止提交真实 key；
- key 走运行时注入（`window.WSC_MAP_CONFIG`）或构建期环境变量；
- 前端明文 key 可被嗅探，**商用场景必须由后端代理做 key 校验**。

## 合规边界（重要）

新增底图前需要确认：数据源的授权条款，以及应用实际发布范围所适用的地图管理要求。
以下几点与本项目的实现约定相关：

- 底图默认必须是合规、可控的来源；
- 国界、台湾、南海诸岛等要素的画法必须符合国家标准，不得错绘、漏绘；
- 众源或境外来源（例如 OpenStreetMap）未做合规确认前，**不要设为默认底图**，
  也不要把它们的瓦片地址写进仓库。

接口对这些来源没有任何限制 —— 限制只在于：本项目不替你做这个判断，也不预置实现。
