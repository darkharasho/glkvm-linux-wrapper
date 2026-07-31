import { app, dialog } from 'electron';
import electronUpdater from 'electron-updater';
const { autoUpdater } = electronUpdater;

export function initUpdater(log: { info(m: string): void; error(m: string, e?: unknown): void }): void {
  if (!app.isPackaged) { log.info('updater: skipped (dev)'); return; }
  autoUpdater.autoDownload = true;
  autoUpdater.on('error', (e) => log.error('updater error', e));
  autoUpdater.on('update-available', (i) => log.info(`update available: ${i.version}`));
  autoUpdater.on('update-downloaded', async (i) => {
    log.info(`update downloaded: ${i.version}`);
    const { response } = await dialog.showMessageBox({
      type: 'info', buttons: ['Restart now', 'Later'], defaultId: 0,
      message: 'Update ready', detail: `GLKVM ${i.version} is ready to install.`,
    });
    if (response === 0) autoUpdater.quitAndInstall();
  });
  autoUpdater.checkForUpdates().catch((e) => log.error('updater check failed', e));
}
