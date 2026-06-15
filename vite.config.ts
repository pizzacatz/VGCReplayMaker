import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Served at the root (Netlify), so no base path needed.
export default defineConfig({
  plugins: [react()],
  server: { port: 5173 },
});
