import { defineConfig } from 'vite';
import cesium from 'vite-plugin-cesium';

export default defineConfig({
  // Relative base so `dist/` can be served from any sub-path.
  base: './',
  plugins: [cesium()],
  server: { port: 5173, open: false },
  build: {
    outDir: 'dist',
    // Cesium is a single very large chunk; the warning is noise here.
    chunkSizeWarningLimit: 8192,
  },
});
