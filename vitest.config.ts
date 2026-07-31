import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  test: {
    environment: 'node',
    maxWorkers: 2,
    minWorkers: 1,
    include: ['test/shared/**/*.{test,spec}.ts', 'test/main/**/*.{test,spec}.ts'],
    exclude: ['test/smoke/**', 'node_modules/**'],
  },
  resolve: { alias: { '@shared': resolve(__dirname, 'src/shared') } },
});
