import { BaseWindow, WebContentsView } from 'electron';
import { join } from 'node:path';

export function createMainWindow(): { window: BaseWindow; dashboard: WebContentsView } {
  const win = new BaseWindow({ width: 1100, height: 760, title: 'GLKVM' });
  const dashboard = new WebContentsView({
    webPreferences: {
      preload: join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.contentView.addChildView(dashboard);
  const { width, height } = win.getContentBounds();
  dashboard.setBounds({ x: 0, y: 0, width, height });
  if (process.env.ELECTRON_RENDERER_URL) {
    dashboard.webContents.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    dashboard.webContents.loadFile(join(__dirname, '../renderer/index.html'));
  }
  win.on('resize', () => {
    const b = win.getContentBounds();
    dashboard.setBounds({ x: 0, y: 0, width: b.width, height: b.height });
  });
  return { window: win, dashboard };
}
