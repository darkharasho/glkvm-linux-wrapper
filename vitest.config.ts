import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  test: { environment: 'node', maxWorkers: 2, minWorkers: 1 },
  resolve: { alias: { '@shared': resolve(__dirname, 'src/shared') } },
});
