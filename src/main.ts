import 'cesium/Build/Cesium/Widgets/widgets.css';
import './styles.css';
import { bootstrap } from './app/bootstrap';

const cesiumContainer = document.getElementById('cesium-container');
const uiRoot = document.getElementById('ui-root');

if (!cesiumContainer || !uiRoot) {
  throw new Error('index.html is missing #cesium-container or #ui-root');
}

bootstrap({ cesium: cesiumContainer, ui: uiRoot }).catch((error: unknown) => {
  console.error('[wsc-3d] bootstrap failed', error);
});
