import { app, session, safeStorage, shell } from 'electron';
import { join } from 'node:path';
import { createMainWindow } from './window';
import { createStore } from './services/store';
import { createConnectionManager } from './services/connections';
import { installCertHandler } from './services/certs';
import { createLogger } from './services/logger';
import { initUpdater } from './services/updater';
import { registerIpc, registerWindowIpc } from './ipc';
import { createModalBridge } from './modal-bridge';
import { createSecretsStore } from './services/secrets';
import { registerSyncIpc } from './syncIpc';
import { createSealedFile } from './services/sealedFile';
import { createGithubAuth, GITHUB_CLIENT_ID } from './services/github/auth';
import { createSyncStateFile } from './services/sync/stateFile';
import { createSyncService } from './services/sync/syncService';
import type { ChangeEvent } from '@shared/sync/format';

app.whenReady().then(() => {
  const { window, dashboard, titlebar, layout } = createMainWindow();
  layout.setRail({ mode: 'idle' });

  // Brings the dashboard (and titlebar) frontmost above the active device view so an in-app
  // modal can render on top of it; returns a restore fn that re-lays-out to bring the device
  // view back to front.
  const presentOverlayUI = (): (() => void) => {
    window.contentView.addChildView(dashboard);
    window.contentView.addChildView(titlebar);
    return () => layout.relayout();
  };

  const bridge = createModalBridge(dashboard, presentOverlayUI);

  // Defense-in-depth CSP for the dashboard UI only (packaged builds only — a strict CSP would
  // break Vite HMR in `npm run dev`). Scoped to the default session, which the dashboard's
  // WebContentsView uses; device WebContentsViews each use their own `persist:device-${id}`
  // partition/session, so this never touches remote KVM content.
  if (app.isPackaged) {
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': [
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'",
          ],
        },
      });
    });
  }
  const store = createStore(app.getPath('userData'));
  const secrets = createSecretsStore(app.getPath('userData'), safeStorage);
  const logger = createLogger(app.getPath('logs'));
  logger.info('app ready');

  try {
    initUpdater(logger, bridge);
  } catch (e) {
    logger.error('updater init failed', e);
  }

  const connections = createConnectionManager({
    window,
    dashboard,
    store,
    secrets,
    onAutofillFailed: (deviceId) => {
      const dev = store.getDevices().find((d) => d.id === deviceId);
      logger.error(`autofill sign-in failed for ${dev?.name ?? deviceId}`);
      void bridge.request({
        kind: 'alert',
        message: `Autofill couldn't sign in to ${dev?.name ?? 'the device'}. Check the saved password in its settings.`,
      });
    },
    layout,
    onState: (s) => {
      if (s.state === 'error') logger.error(`connection error for ${s.deviceId ?? 'unknown'}`, s.message);
      else logger.info(`connection state: ${s.state} (${s.deviceId ?? 'none'})`);
      dashboard.webContents.send('conn:state', s);
      const dev = s.deviceId ? store.getDevices().find(d => d.id === s.deviceId) : null;
      layout.setRail(s.deviceId && s.state === 'ready' && dev
        ? { mode: 'connected', deviceName: dev.name, captureOn: true }
        : { mode: 'idle' });
    },
    onConnectedChange: (ids) => dashboard.webContents.send('devices:connected', ids),
  });

  // The renderer only displays the host/fingerprint and returns 'trust'/'cancel'; main remains
  // the sole trust authority (decideCert + store.trustCert are untouched — see certs.ts).
  const promptTrust = async (host: string, fingerprint: string): Promise<boolean> =>
    (await bridge.request({ kind: 'cert-trust', host, fingerprint })) === 'trust';

  installCertHandler(store, promptTrust, logger);

  registerIpc(store, connections, bridge, secrets);

  const userData = app.getPath('userData');
  const sendToDashboard = (channel: string, ...args: unknown[]) => {
    if (!dashboard.webContents.isDestroyed()) dashboard.webContents.send(channel, ...args);
  };
  const auth = createGithubAuth({
    fetch,
    sealed: createSealedFile(join(userData, 'github-auth.json'), safeStorage),
    clientId: GITHUB_CLIENT_ID,
    openExternal: (url) => { void shell.openExternal(url); },
  });
  const sync = createSyncService({
    fetch,
    auth,
    store,
    secrets,
    keyFile: createSealedFile(join(userData, 'sync-key.json'), safeStorage),
    stateFile: createSyncStateFile(userData),
    logger,
    onOverview: (o) => sendToDashboard('sync:overview', o),
    onApplied: () => sendToDashboard('sync:applied'),
  });
  // Sync bookkeeping must never abort a store mutation (or the IPC handler's follow-up work).
  const noteChange = (e: ChangeEvent) => {
    try { sync.noteChange(e); } catch (err) { logger.error('sync: noteChange failed', (err as Error).message); }
  };
  store.onChange(noteChange);
  secrets.onChange(noteChange);
  auth.onChange((user) => {
    logger.info(user ? 'github: signed in' : 'github: signed out');
    if (user) sync.scheduleSync(); else sync.forgetKey();
    sendToDashboard('sync:overview', sync.overview());
  });
  auth.onError((message) => {
    logger.error('github: sign-in failed', message);
    sendToDashboard('github:auth-error', message);
  });
  window.on('focus', () => sync.onFocus());
  if (dashboard.webContents.isLoading()) dashboard.webContents.once('did-finish-load', () => sync.scheduleSync());
  else sync.scheduleSync();
  registerSyncIpc(auth, sync);

  registerWindowIpc(window, {
    onBack: () => connections.background(),
    onDisconnect: () => connections.disconnect(),
  });

  app.on('activate', () => { /* re-create on macOS dock click */ });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
