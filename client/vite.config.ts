import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:10000', changeOrigin: true },
      '/ws': { target: 'ws://localhost:10000', ws: true },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks: {
          charts: ['lightweight-charts'],
          react: ['react', 'react-dom'],
        },
      },
    },
  },
});
