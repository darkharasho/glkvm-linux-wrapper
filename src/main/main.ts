import { app, session, safeStorage } from 'electron';
import { createMainWindow } from './window';
import { createStore } from './services/store';
import { createConnectionManager } from './services/connections';
import { installCertHandler } from './services/certs';
import { createLogger } from './services/logger';
import { initUpdater } from './services/updater';
import { registerIpc, registerWindowIpc } from './ipc';
import { createModalBridge } from './modal-bridge';
import { createSecretsStore } from './services/secrets';

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

  installCertHandler(store, promptTrust);

  registerIpc(store, connections, bridge);
  registerWindowIpc(window, {
    onBack: () => connections.background(),
    onDisconnect: () => connections.disconnect(),
  });

  app.on('activate', () => { /* re-create on macOS dock click */ });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
