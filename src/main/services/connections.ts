import { BaseWindow, WebContentsView, session } from 'electron';
import type { createStore } from './store';
import { attachKeyboard } from './keyboard';
import type { LayoutController } from '../window';
type Store = ReturnType<typeof createStore>;

export interface ConnectionManager {
  connect(id: string): Promise<void>;
  disconnect(id?: string): Promise<void>;
  background(): void;
  activeDeviceId(): string | null;
}

interface Deps {
  window: BaseWindow;
  dashboard: WebContentsView;
  store: Store;
  layout: LayoutController;
  onState: (s: { deviceId: string | null; state: 'loading' | 'ready' | 'error'; message?: string }) => void;
  onConnectedChange?: (ids: string[]) => void;
}

export function createConnectionManager(deps: Deps): ConnectionManager {
  const views = new Map<string, WebContentsView>();
  const watchdogs = new Map<string, ReturnType<typeof setTimeout>>();
  const loaded = new Set<string>();
  let active: string | null = null; // device currently attached/shown (set only on success)
  let target: string | null = null; // device the user currently intends to view (set as soon as connect() is called)
  const naturalSize = new Map<string, { w: number; h: number }>(); // remote content size (device px @ zoom 1)
  let fitTimer: ReturnType<typeof setTimeout> | null = null;

  function clearWatchdog(id: string) {
    const t = watchdogs.get(id);
    if (t) { clearTimeout(t); watchdogs.delete(id); }
  }

  // Measure the remote's natural content size at 1:1 (called right after a fresh load).
  // A cached view reconnecting via Back may still be at its previously-applied zoom, so
  // force zoom back to 1 before measuring — Chromium page-zoom inflates scrollWidth/Height.
  // Uses a double rAF so layout has settled after the zoom reset.
  async function measureNatural(id: string): Promise<void> {
    const v = views.get(id);
    if (!v || v.webContents.isDestroyed()) return;
    try {
      if (v.webContents.getZoomFactor() !== 1) v.webContents.setZoomFactor(1); // measure at true 1:1
      const m = await v.webContents.executeJavaScript(
        'new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(() => {' +
        '  let best = null, area = -1;' +
        '  for (const el of document.querySelectorAll("video, canvas")) {' +
        '    const w = el.videoWidth || el.width || Math.round(el.getBoundingClientRect().width);' +
        '    const h = el.videoHeight || el.height || Math.round(el.getBoundingClientRect().height);' +
        '    if (w > 0 && h > 0 && w * h > area) { area = w * h; best = { w, h }; }' +
        '  }' +
        '  if (!best) best = { w: document.documentElement.scrollWidth, h: document.documentElement.scrollHeight };' +
        '  res(best);' +
        '})))'
      );
      if (m && m.w > 0 && m.h > 0) naturalSize.set(id, { w: m.w, h: m.h });
    } catch { /* page not ready / navigating */ }
  }
  // Scale the active view so the remote fits its current bounds (never enlarge past 1:1).
  function applyFit(id: string): void {
    const v = views.get(id);
    if (!v || v.webContents.isDestroyed()) return;
    const nat = naturalSize.get(id);
    if (!nat || nat.w <= 0 || nat.h <= 0) return;
    const b = v.getBounds(); // device px (== CSS px at zoom 1)
    if (b.width <= 0 || b.height <= 0) return;
    const factor = Math.max(0.3, Math.min(1, b.width / nat.w, b.height / nat.h));
    if (Math.abs(v.webContents.getZoomFactor() - factor) > 0.005) v.webContents.setZoomFactor(factor);
  }
  function scheduleFit(): void {
    if (fitTimer) clearTimeout(fitTimer);
    fitTimer = setTimeout(() => { if (active) applyFit(active); }, 120);
  }
  deps.layout.onAfterRelayout(scheduleFit);

  // "Back" — return to the dashboard but keep the active device's session live in the
  // background (view stays cached in `views`/`loaded`) so its dashboard row can show
  // "Connected" and re-clicking it resumes instantly instead of reloading.
  function background(): void {
    if (target) clearWatchdog(target);
    if (active) {
      clearWatchdog(active);
      if (views.has(active)) deps.window.contentView.removeChildView(views.get(active)!);
    }
    active = null;
    target = null;
    deps.layout.setActiveDeviceView(null);
    deps.layout.relayout();
    deps.onState({ deviceId: null, state: 'ready' });
  }

  // "Disconnect" — end the live session for a device (defaults to the active one): detach +
  // destroy its view/webContents, drop it from `views`/`loaded`, and clear its watchdog.
  async function disconnect(id?: string): Promise<void> {
    const targetId = id ?? active;
    if (!targetId) {
      // Nothing active to end; still clear any in-flight target so a pending connect settles.
      if (target) clearWatchdog(target);
      target = null;
      return;
    }
    clearWatchdog(targetId);
    const view = views.get(targetId);
    if (view) {
      deps.window.contentView.removeChildView(view); // safe no-op if not currently attached
      try { view.webContents.close(); } catch { /* already closed/destroyed */ }
      views.delete(targetId);
    }
    loaded.delete(targetId);
    naturalSize.delete(targetId);
    if (active === targetId) active = null;
    if (target === targetId) target = null;
    deps.layout.setActiveDeviceView(null);
    deps.layout.relayout();
    deps.onState({ deviceId: null, state: 'ready' });
    deps.onConnectedChange?.([...loaded]);
  }

  return {
    activeDeviceId: () => active,
    background,
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
        deps.layout.setActiveDeviceView(null);
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
        attachKeyboard(
          newView.webContents,
          () => deps.store.getSettings(),
          (appAction) => {
            if (appAction === 'back-to-dashboard' || appAction === 'release') background();
            else if (appAction === 'toggle-fullscreen') deps.window.setFullScreen(!deps.window.isFullScreen());
            // next/prev/open-settings handled here or forwarded to renderer
          },
          () => deps.store.getDevices().find((d) => d.id === id)?.os ?? 'generic',
        );
        // Harden the remote KVM page against opening arbitrary windows or navigating away from
        // its own origin (defense-in-depth against a malicious/compromised device page). The
        // allowed origin is fixed to the device's own URL at creation time — using getURL() here
        // would be empty until the first load finishes and would incorrectly block that load.
        const deviceOrigin = (() => { try { return new URL(device.url).origin; } catch { return null; } })();
        newView.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
        newView.webContents.on('will-navigate', (e, navUrl) => {
          try {
            const target = new URL(navUrl);
            if (!deviceOrigin || target.origin !== deviceOrigin) e.preventDefault();
          } catch {
            e.preventDefault();
          }
        });
        newView.webContents.on('did-finish-load', () => {
          if (target !== id) return; // superseded by a later connect()/background() — ignore
          clearWatchdog(id);
          deps.window.contentView.addChildView(newView);
          deps.layout.setActiveDeviceView(newView);
          deps.layout.relayout();
          active = id;
          deps.onState({ deviceId: id, state: 'ready' });
          if (!loaded.has(id)) {
            loaded.add(id);
            deps.onConnectedChange?.([...loaded]);
          }
          void measureNatural(id).then(() => applyFit(id));
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
      // loadURL rejects on did-fail-load (e.g. ERR_CONNECTION_REFUSED); the did-fail-load handler
      // above already owns reporting that error state, so swallow the rejection here to avoid an
      // unhandled promise rejection surfacing to the ipc caller.
      try {
        await view.webContents.loadURL(device.url);
      } catch {
        // handled via did-fail-load
      }
    },
    disconnect,
  };
}
