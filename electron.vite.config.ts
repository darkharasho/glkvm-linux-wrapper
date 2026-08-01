import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';

const alias = { '@shared': resolve(__dirname, 'src/shared') };

export default defineConfig({
  main: { resolve: { alias }, build: { rollupOptions: { input: 'src/main/main.ts' } } },
  preload: {
    build: {
      rollupOptions: {
        input: { preload: 'src/preload/preload.ts', 'titlebar-preload': 'src/preload/titlebar-preload.ts' },
      },
    },
  },
  renderer: {
    resolve: { alias },
    root: 'src/renderer',
    build: {
      rollupOptions: {
        input: { index: 'src/renderer/index.html', titlebar: 'src/renderer/titlebar.html' },
      },
    },
  },
});
