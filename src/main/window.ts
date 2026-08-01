import { BaseWindow, WebContentsView } from 'electron';
import { join } from 'node:path';
import { RAIL_H, railArea, contentArea } from './layout';

export interface RailState {
  mode: 'idle' | 'connected';
  deviceName?: string;
  captureOn?: boolean;
}

export interface LayoutController {
  relayout(): void;
  setActiveDeviceView(v: WebContentsView | null): void;
  setRail(state: RailState): void;
}

export function createMainWindow(): {
  window: BaseWindow;
  dashboard: WebContentsView;
  titlebar: WebContentsView;
  layout: LayoutController;
} {
  const win = new BaseWindow({
    width: 1100,
    height: 760,
    title: 'GLKVM',
    frame: false,
    backgroundColor: '#0c0c0d',
  });

  const mk = (preload: string) =>
    new WebContentsView({
      webPreferences: {
        preload: join(__dirname, preload),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });

  const dashboard = mk('../preload/preload.js');
  const titlebar = mk('../preload/titlebar-preload.js');
  win.contentView.addChildView(dashboard);
  win.contentView.addChildView(titlebar);

  let activeDeviceView: WebContentsView | null = null;
  let lastW = 0;
  let lastH = 0;
  const relayout = () => {
    const b = win.getBounds();
    lastW = b.width;
    lastH = b.height;
    dashboard.setBounds(contentArea(win));
    if (activeDeviceView) {
      activeDeviceView.setBounds(contentArea(win));
      win.contentView.addChildView(activeDeviceView); // re-raise above dashboard (e.g. after a modal overlay raised it)
    }
    titlebar.setBounds(railArea(win));
    win.contentView.addChildView(titlebar); // re-raise to top
  };
  const layout: LayoutController = {
    relayout,
    setActiveDeviceView: (v) => {
      activeDeviceView = v;
      relayout();
    },
    setRail: (s) => titlebar.webContents.send('rail:state', s),
  };

  const load = (view: WebContentsView, htmlFile: string, devPath: string) => {
    if (process.env.ELECTRON_RENDERER_URL) view.webContents.loadURL(process.env.ELECTRON_RENDERER_URL + devPath);
    else view.webContents.loadFile(join(__dirname, htmlFile));
  };
  load(dashboard, '../renderer/index.html', '/index.html');
  load(titlebar, '../renderer/titlebar.html', '/titlebar.html');

  // Relayout on the standard window events (responsive when the WM emits them).
  win.on('resize', relayout);
  win.on('maximize', relayout);
  win.on('unmaximize', relayout);
  win.on('enter-full-screen', relayout);
  win.on('leave-full-screen', relayout);
  win.on('restore', relayout);

  // Safety net: several Linux window managers resize/maximize a frameless window
  // (e.g. dragging it to the top edge) WITHOUT emitting any Electron resize/maximize
  // event, which would otherwise leave the child views stuck at the old size. Poll
  // the outer bounds and relayout when they actually change. Cheap (two int compares)
  // and only does work on an actual size change.
  const sizePoll = setInterval(() => {
    if (win.isDestroyed()) return;
    const b = win.getBounds();
    if (b.width !== lastW || b.height !== lastH) relayout();
  }, 250);
  win.on('closed', () => clearInterval(sizePoll));

  relayout();
  return { window: win, dashboard, titlebar, layout };
}

export { RAIL_H };
