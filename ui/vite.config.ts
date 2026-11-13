import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const root = fileURLToPath(new URL('.', import.meta.url));
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };

export default defineConfig({
  root,
  base: './',
  plugins: [react()],
  // SKILLHANGAR_BRAND=neutral builds with an original mark instead of the Claude symbol.
  define: { __APP_VERSION__: JSON.stringify(pkg.version), __BRAND__: JSON.stringify(process.env.SKILLHANGAR_BRAND === 'neutral' ? 'neutral' : 'claude') },
  resolve: { alias: { '@shared': fileURLToPath(new URL('../src/shared', import.meta.url)) } },
  build: {
    outDir: fileURLToPath(new URL('../dist/ui', import.meta.url)),
    emptyOutDir: true,
    target: 'es2022',
    cssCodeSplit: false,
    sourcemap: false,
    // Every byte ships inside the npm package and loads from localhost; keep chunks lean and cacheable.
    chunkSizeWarningLimit: 400,
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: { '/api': { target: 'http://127.0.0.1:4517', changeOrigin: false } },
  },
});
