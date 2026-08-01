import { app } from 'electron';
import electronUpdater from 'electron-updater';
import type { createModalBridge } from '../modal-bridge';
const { autoUpdater } = electronUpdater;

export function initUpdater(
  log: { info(m: string): void; error(m: string, e?: unknown): void },
  bridge: ReturnType<typeof createModalBridge>,
): void {
  if (!app.isPackaged) { log.info('updater: skipped (dev)'); return; }
  autoUpdater.autoDownload = true;
  autoUpdater.on('error', (e) => log.error('updater error', e));
  autoUpdater.on('update-available', (i) => log.info(`update available: ${i.version}`));
  autoUpdater.on('update-downloaded', async (i) => {
    log.info(`update downloaded: ${i.version}`);
    const v = await bridge.request({ kind: 'update-ready', version: i.version });
    if (v === 'restart') autoUpdater.quitAndInstall();
  });
  autoUpdater.checkForUpdates().catch((e) => log.error('updater check failed', e));
}
