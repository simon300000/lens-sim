import { defineConfig } from 'vite';
import { readFileSync } from 'node:fs';
import { wgslModule } from './scripts/build-wgsl.mjs';

/** Serve X.wgsl.js from its X.wgsl source, so shader edits show up on reload
 * without rerunning scripts/build-wgsl.mjs (which other bundlers and Node use). */
const wgslModules = () => ({
  name: 'lens-sim-wgsl-modules',
  load(id) {
    const file = id.split('?')[0];
    if (!file.endsWith('.wgsl.js')) return null;
    const source = file.slice(0, -3);
    this.addWatchFile(source);
    return wgslModule(readFileSync(source, 'utf8'));
  },
});

export default defineConfig({
  plugins: [wgslModules()],
  // Avoid recreating expensive WebGPU pipelines in the middle of a rendered frame.
  server: { hmr: false },
  build: {
    rollupOptions: {
      output: {
        manualChunks: { 'three-webgpu': ['three/webgpu', 'three/tsl'] },
      },
    },
    chunkSizeWarningLimit: 1000,
  },
});
