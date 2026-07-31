import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';

const alias = { '@shared': resolve(__dirname, 'src/shared') };

export default defineConfig({
  main: { resolve: { alias }, build: { rollupOptions: { input: 'src/main/main.ts' } } },
  preload: { build: { rollupOptions: { input: 'src/preload/preload.ts' } } },
  renderer: {
    resolve: { alias },
    root: 'src/renderer',
    build: { rollupOptions: { input: 'src/renderer/index.html' } },
  },
});
