import { ipcMain, dialog, BaseWindow } from 'electron';
import { writeFileSync, readFileSync } from 'node:fs';
import type { createStore } from './services/store';
import type { ConnectionManager } from './services/connections';
import type { createModalBridge } from './modal-bridge';
import type { SecretsStore } from './services/secrets';
import { parseBackup } from '@shared/backup';

type Store = ReturnType<typeof createStore>;

export function registerIpc(store: Store, connections: ConnectionManager, bridge: ReturnType<typeof createModalBridge>, secrets: SecretsStore): void {
  ipcMain.handle('devices:list', () => store.getDevices());
  ipcMain.handle('devices:add', (_e, input) => store.addDevice(input));
  ipcMain.handle('devices:update', (_e, id, patch) => store.updateDevice(id, patch));
  ipcMain.handle('devices:remove', (_e, id) => { store.removeDevice(id); secrets.clear(id); });
  ipcMain.handle('settings:get', () => store.getSettings());
  ipcMain.handle('settings:set', (_e, next) => store.setSettings(next));
  ipcMain.handle('conn:connect', (_e, id) => connections.connect(id));
  ipcMain.handle('conn:disconnect', () => connections.disconnect());

  ipcMain.handle('secrets:set', (_e, id, password) => {
    const ok = secrets.set(id, password);
    if (ok) connections.resetAutofill(id);
    return ok;
  });
  ipcMain.handle('secrets:has', (_e, id) => secrets.has(id));
  ipcMain.handle('secrets:clear', (_e, id) => secrets.clear(id));
  ipcMain.handle('secrets:available', () => secrets.isAvailable());
  ipcMain.handle('secrets:list', () => secrets.ids());

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
    catch {
      await bridge.request({ kind: 'alert', message: "That file isn't a valid GLKVM backup." });
      return;
    }
    const v = await bridge.request({ kind: 'import-choice' });
    if (v === 'cancel') return;
    store.applyImport(bundle, v === 'replace' ? 'replace' : 'merge');
  });
}

export interface RailHandlers {
  onBack?: () => void;
  onDisconnect?: () => void;
}

/** Window-control + rail-nav IPC. `handlers` lets main.ts wire rail nav: Back → background() (keep session live), Disconnect → disconnect() (end session). */
export function registerWindowIpc(win: BaseWindow, handlers: RailHandlers = {}): void {
  ipcMain.on('win:min', () => win.minimize());
  ipcMain.on('win:max', () => (win.isMaximized() ? win.unmaximize() : win.maximize()));
  ipcMain.on('win:close', () => win.close());
  ipcMain.on('rail:back', () => handlers.onBack?.());
  ipcMain.on('rail:disconnect', () => handlers.onDisconnect?.());
}
