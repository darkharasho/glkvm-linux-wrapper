import { ipcMain } from 'electron';
import type { GithubAuth } from './services/github/auth';
import type { SyncService } from './services/sync/syncService';
import type { SyncResult } from '@shared/sync/format';

const BAD_INPUT: SyncResult = { ok: false, error: 'Invalid input' };
const str = (v: unknown): v is string => typeof v === 'string';

export function registerSyncIpc(auth: GithubAuth, sync: SyncService): void {
  ipcMain.handle('sync:overview', () => sync.overview());
  ipcMain.handle('github:start-auth', async () => {
    try { return { ok: true, ...(await auth.start()) }; }
    catch (e) { return { ok: false, error: (e as Error).message }; }
  });
  ipcMain.handle('github:open-verification', () => auth.openVerification());
  ipcMain.handle('github:cancel-auth', () => auth.cancel());
  ipcMain.handle('github:sign-out', () => auth.signOut());
  ipcMain.handle('sync:now', () => sync.syncNow());
  ipcMain.handle('sync:set-passphrase', (_e, p: unknown) => (str(p) ? sync.setPassphrase(p) : BAD_INPUT));
  ipcMain.handle('sync:enter-passphrase', (_e, p: unknown) => (str(p) ? sync.enterPassphrase(p) : BAD_INPUT));
  ipcMain.handle('sync:change-passphrase', (_e, current: unknown, next: unknown) =>
    (str(current) && str(next) ? sync.changePassphrase(current, next) : BAD_INPUT));
  ipcMain.handle('sync:reset-passphrase', (_e, next: unknown) => (str(next) ? sync.resetPassphrase(next) : BAD_INPUT));
}
