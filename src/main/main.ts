import { app } from 'electron';
import { createMainWindow } from './window';

app.whenReady().then(() => {
  createMainWindow();
  app.on('activate', () => { /* re-create on macOS dock click */ });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
