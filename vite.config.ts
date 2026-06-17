import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Deployed to GitHub Pages at https://pizzacatz.github.io/VGCReplayMaker/, so assets
// must be served from the repo sub-path. `dev`/preview stay at root.
export default defineConfig(({ command }) => ({
  base: command === 'build' ? '/VGCReplayMaker/' : '/',
  plugins: [react()],
  server: { port: 5173 },
}));
