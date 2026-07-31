import { app, dialog } from 'electron';
import { createMainWindow } from './window';
import { createStore } from './services/store';
import { createConnectionManager } from './services/connections';
import { installCertHandler } from './services/certs';
import { createLogger } from './services/logger';
import { initUpdater } from './services/updater';
import { registerIpc } from './ipc';

app.whenReady().then(() => {
  const { window, dashboard } = createMainWindow();
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

  app.on('activate', () => { /* re-create on macOS dock click */ });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
