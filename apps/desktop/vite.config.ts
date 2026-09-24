import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Voxaura renderer — Tauri v2 dev server on the fixed 1420 port.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
  },
  build: {
    target: 'es2022',
  },
});
