import { defineConfig } from 'vite';

export default defineConfig({
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
