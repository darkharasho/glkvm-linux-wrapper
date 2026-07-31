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
  const watchdogs = new Map<string, ReturnType<typeof setTimeout>>();
  let active: string | null = null; // device currently attached/shown (set only on success)
  let target: string | null = null; // device the user currently intends to view (set as soon as connect() is called)

  const bounds = () => { const b = deps.window.getContentBounds(); return { x: 0, y: 0, width: b.width, height: b.height }; };

  function clearWatchdog(id: string) {
    const t = watchdogs.get(id);
    if (t) { clearTimeout(t); watchdogs.delete(id); }
  }

  deps.window.on('resize', () => {
    if (active && views.has(active)) views.get(active)!.setBounds(bounds());
  });

  function showDashboard() {
    if (target) clearWatchdog(target);
    if (active) clearWatchdog(active);
    if (active && views.has(active)) deps.window.contentView.removeChildView(views.get(active)!);
    active = null;
    target = null;
    deps.dashboard.setBounds(bounds());
    deps.onState({ deviceId: null, state: 'ready' });
  }

  return {
    activeDeviceId: () => active,
    async connect(id: string) {
      const device = deps.store.getDevices().find(d => d.id === id);
      if (!device) return;

      // A different connection attempt may already be in flight (its did-finish-load/did-fail-load/
      // watchdog haven't fired yet) — that one is now superseded by this call, so stop its watchdog.
      // Its deferred callbacks still guard on `target !== id` below, so this is defense-in-depth.
      if (target && target !== id) clearWatchdog(target);

      // Detach whatever device view is currently frontmost so the dashboard (and its loading/error
      // overlay) stays visible for the duration of this connection attempt. The new device view is
      // only brought to front once it has actually finished loading AND is still the user's intended
      // target (see did-finish-load below) — otherwise it would stack on top of the dashboard and hide
      // the overlay/Retry/Back controls, or hijack the screen after the user moved on.
      if (active) {
        clearWatchdog(active);
        if (views.has(active)) deps.window.contentView.removeChildView(views.get(active)!);
      }
      active = null;
      target = id;

      deps.onState({ deviceId: id, state: 'loading' });

      let view = views.get(id);
      if (!view) {
        const newView = new WebContentsView({
          webPreferences: {
            partition: `persist:device-${id}`,
            contextIsolation: true, nodeIntegration: false,
          },
        });
        attachKeyboard(newView.webContents, () => deps.store.getSettings(), (appAction) => {
          if (appAction === 'back-to-dashboard' || appAction === 'release') showDashboard();
          // next/prev/fullscreen/open-settings handled here or forwarded to renderer
        });
        newView.webContents.on('did-finish-load', () => {
          if (target !== id) return; // superseded by a later connect()/showDashboard() — ignore
          clearWatchdog(id);
          deps.window.contentView.addChildView(newView);
          newView.setBounds(bounds());
          active = id;
          deps.onState({ deviceId: id, state: 'ready' });
        });
        newView.webContents.on('did-fail-load', (_e, code, desc) => {
          if (code === -3) return; // aborted, ignore
          if (target !== id) return; // superseded — ignore, dashboard/current target stays untouched
          clearWatchdog(id);
          // Device view was never (re-)attached above, so the dashboard + error overlay stay frontmost.
          deps.onState({ deviceId: id, state: 'error', message: desc });
        });
        views.set(id, newView);
        view = newView;
      }
      void session.fromPartition(`persist:device-${id}`); // ensure partition exists
      clearWatchdog(id);
      watchdogs.set(id, setTimeout(() => {
        if (target !== id) return; // superseded — this device's timer is now a no-op
        // Timed out before did-finish-load ever fired, so the view was never attached — dashboard stays frontmost.
        deps.onState({ deviceId: id, state: 'error', message: 'Timed out' });
      }, 10_000));
      await view.webContents.loadURL(device.url);
    },
    async disconnect() { showDashboard(); },
  };
}
