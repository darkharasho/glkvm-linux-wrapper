import { defineConfig } from 'playwright/test';

export default defineConfig({
  testDir: 'test/smoke',
  timeout: 30000,
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
});
