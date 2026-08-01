import { test, expect, _electron as electron, Page } from 'playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The app renders two separate WebContentsViews in one BaseWindow (a titlebar
// rail and the dashboard). Playwright's `firstWindow()` may attach to either
// one, so we explicitly locate the window that hosts the dashboard markup
// (`#add-btn` / `#list`) rather than assuming it's the first window.
async function getDashboardWindow(app: Awaited<ReturnType<typeof electron.launch>>): Promise<Page> {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    for (const win of app.windows()) {
      try {
        if (await win.locator('#add-btn').count()) return win;
      } catch {
        // window may still be loading; keep polling
      }
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('dashboard window (#add-btn) never appeared');
}

test('boots to dashboard, adds a device, shows a row', async () => {
  // Use an isolated, empty userData dir so leftover devices from prior
  // smoke runs never accumulate and make row assertions ambiguous.
  const userDataDir = mkdtempSync(join(tmpdir(), 'glkvm-smoke-'));
  const app = await electron.launch({
    args: [`--user-data-dir=${userDataDir}`, 'out/main/main.js'],
  });
  const win = await getDashboardWindow(app);

  await expect(win.locator('#list')).toBeVisible();
  await win.click('#add-btn');

  const modal = win.locator('.modal');
  await expect(modal).toBeVisible();
  await modal.locator('input[name="name"]').fill('Test');
  await modal.locator('input[name="address"]').fill('unreachable.invalid');
  await modal.locator('.mf button.pri').click();

  await expect(win.locator('.row .nm')).toHaveText('Test');
  await win.click('.row');
  await expect(win.locator('#conn-overlay')).toBeVisible({ timeout: 15000 });

  await app.close();
  rmSync(userDataDir, { recursive: true, force: true });
});
