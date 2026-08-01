import { app, dialog, session } from 'electron';
import { createMainWindow } from './window';
import { createStore } from './services/store';
import { createConnectionManager } from './services/connections';
import { installCertHandler } from './services/certs';
import { createLogger } from './services/logger';
import { initUpdater } from './services/updater';
import { registerIpc, registerWindowIpc } from './ipc';

app.whenReady().then(() => {
  const { window, dashboard, layout } = createMainWindow();
  layout.setRail({ mode: 'idle' });

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
  const logger = createLogger(app.getPath('logs'));
  logger.info('app ready');

  try {
    initUpdater(logger);
  } catch (e) {
    logger.error('updater init failed', e);
  }

  const connections = createConnectionManager({
    window,
    dashboard,
    store,
    onState: (s) => {
      if (s.state === 'error') logger.error(`connection error for ${s.deviceId ?? 'unknown'}`, s.message);
      else logger.info(`connection state: ${s.state} (${s.deviceId ?? 'none'})`);
      dashboard.webContents.send('conn:state', s);
    },
  });

  installCertHandler(store, async (host, fingerprint) => {
    const { response } = await dialog.showMessageBox(window, {
      type: 'warning',
      buttons: ['Trust', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      message: `Untrusted certificate for ${host}`,
      detail: `Fingerprint: ${fingerprint}\n\nOnly trust this if you recognize the device.`,
    });
    return response === 0;
  });

  registerIpc(store, connections);
  registerWindowIpc(window, {
    onBack: () => connections.disconnect(),
    onDisconnect: () => connections.disconnect(),
  });

  app.on('activate', () => { /* re-create on macOS dock click */ });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
