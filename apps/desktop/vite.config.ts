import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Voxaura renderer — Tauri v2 dev server on the fixed 1420 port.
// envPrefix VOICE_ exposes VOICE_RUNTIME_IPC_TOKEN to the client bundle;
// without it Vite strips the bearer and the bridge can never connect.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  envPrefix: 'VOICE_',
  server: {
    port: 1420,
    strictPort: true,
  },
  build: {
    target: 'es2022',
  },
});
