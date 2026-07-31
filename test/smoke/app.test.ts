import { test, expect, _electron as electron } from 'playwright/test';

test('boots to dashboard, adds a device, shows a tile', async () => {
  const app = await electron.launch({ args: ['out/main/main.js'] });
  const win = await app.firstWindow();
  await expect(win.locator('h1')).toHaveText('GLKVM');
  await win.click('#add-btn');
  await win.fill('input[name="name"]', 'Test');
  await win.fill('input[name="address"]', 'unreachable.invalid');
  await win.click('#save');
  await expect(win.locator('.tile .name')).toHaveText('Test');
  await win.click('.tile');
  await expect(win.locator('#conn-overlay')).toBeVisible({ timeout: 15000 });
  await app.close();
});
