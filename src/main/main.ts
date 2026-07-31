import { app, dialog } from 'electron';
import { createMainWindow } from './window';
import { createStore } from './services/store';
import { createConnectionManager } from './services/connections';
import { installCertHandler } from './services/certs';
import { registerIpc } from './ipc';

app.whenReady().then(() => {
  const { window, dashboard } = createMainWindow();
  const store = createStore(app.getPath('userData'));

  const connections = createConnectionManager({
    window,
    dashboard,
    store,
    onState: (s) => {
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
