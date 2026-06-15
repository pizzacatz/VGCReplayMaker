import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// GitHub Pages serves under /<repo>/, so the production build needs that base.
// Dev stays at root.
export default defineConfig(({ command }) => ({
  plugins: [react()],
  base: command === 'build' ? '/VGCReplayMaker/' : '/',
  server: { port: 5173 },
}));
