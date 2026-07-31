import { ipcMain, dialog, BrowserWindow } from 'electron';
import { writeFileSync, readFileSync } from 'node:fs';
import type { createStore } from './services/store';
import type { ConnectionManager } from './services/connections';
import { parseBackup } from '@shared/backup';

type Store = ReturnType<typeof createStore>;

export function registerIpc(store: Store, connections: ConnectionManager): void {
  ipcMain.handle('devices:list', () => store.getDevices());
  ipcMain.handle('devices:add', (_e, input) => store.addDevice(input));
  ipcMain.handle('devices:update', (_e, id, patch) => store.updateDevice(id, patch));
  ipcMain.handle('devices:remove', (_e, id) => store.removeDevice(id));
  ipcMain.handle('settings:get', () => store.getSettings());
  ipcMain.handle('settings:set', (_e, next) => store.setSettings(next));
  ipcMain.handle('conn:connect', (_e, id) => connections.connect(id));
  ipcMain.handle('conn:disconnect', () => connections.disconnect());

  ipcMain.handle('backup:export', async () => {
    const { canceled, filePath } = await dialog.showSaveDialog({
      defaultPath: `glkvm-backup-${new Date().toISOString().slice(0, 10)}.json`,
    });
    if (canceled || !filePath) return;
    writeFileSync(filePath, JSON.stringify(store.exportBundle(), null, 2), 'utf8');
  });

  ipcMain.handle('backup:import', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog({ properties: ['openFile'] });
    if (canceled || !filePaths[0]) return;
    let bundle;
    try { bundle = parseBackup(readFileSync(filePaths[0], 'utf8')); }
    catch { await dialog.showMessageBox({ type: 'error', message: 'Invalid backup file' }); return; }
    const { response } = await dialog.showMessageBox({
      type: 'question', buttons: ['Merge', 'Replace', 'Cancel'], defaultId: 0, cancelId: 2,
      message: 'Import devices & settings', detail: 'Merge with current, or replace everything?',
    });
    if (response === 2) return;
    store.applyImport(bundle, response === 1 ? 'replace' : 'merge');
    BrowserWindow.getAllWindows(); // views notified via connections/dashboard refresh
  });
}
