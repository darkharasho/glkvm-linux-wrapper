import { BaseWindow, WebContentsView, session } from 'electron';
import type { createStore } from './store';
import { attachKeyboard } from './keyboard';
type Store = ReturnType<typeof createStore>;

export interface ConnectionManager {
  connect(id: string): Promise<void>;
  disconnect(): Promise<void>;
  activeDeviceId(): string | null;
}

interface Deps {
  window: BaseWindow;
  dashboard: WebContentsView;
  store: Store;
  onState: (s: { deviceId: string | null; state: 'loading' | 'ready' | 'error'; message?: string }) => void;
}

export function createConnectionManager(deps: Deps): ConnectionManager {
  const views = new Map<string, WebContentsView>();
  let active: string | null = null;

  const bounds = () => { const b = deps.window.getContentBounds(); return { x: 0, y: 0, width: b.width, height: b.height }; };

  deps.window.on('resize', () => {
    if (active && views.has(active)) views.get(active)!.setBounds(bounds());
  });

  function showDashboard() {
    if (active && views.has(active)) deps.window.contentView.removeChildView(views.get(active)!);
    active = null;
    deps.dashboard.setBounds(bounds());
    deps.onState({ deviceId: null, state: 'ready' });
  }

  return {
    activeDeviceId: () => active,
    async connect(id: string) {
      const device = deps.store.getDevices().find(d => d.id === id);
      if (!device) return;
      deps.onState({ deviceId: id, state: 'loading' });
      let view = views.get(id);
      if (!view) {
        view = new WebContentsView({
          webPreferences: {
            partition: `persist:device-${id}`,
            contextIsolation: true, nodeIntegration: false,
          },
        });
        attachKeyboard(view.webContents, () => deps.store.getSettings(), (appAction) => {
          if (appAction === 'back-to-dashboard' || appAction === 'release') showDashboard();
          // next/prev/fullscreen/open-settings handled here or forwarded to renderer
        });
        const watchdog = setTimeout(() => deps.onState({ deviceId: id, state: 'error', message: 'Timed out' }), 10_000);
        view.webContents.on('did-finish-load', () => { clearTimeout(watchdog); deps.onState({ deviceId: id, state: 'ready' }); });
        view.webContents.on('did-fail-load', (_e, code, desc) => {
          clearTimeout(watchdog);
          if (code === -3) return; // aborted, ignore
          deps.onState({ deviceId: id, state: 'error', message: desc });
        });
        views.set(id, view);
      }
      if (active && views.has(active)) deps.window.contentView.removeChildView(views.get(active)!);
      deps.window.contentView.addChildView(view);
      view.setBounds(bounds());
      active = id;
      void session.fromPartition(`persist:device-${id}`); // ensure partition exists
      await view.webContents.loadURL(device.url);
    },
    async disconnect() { showDashboard(); },
  };
}
