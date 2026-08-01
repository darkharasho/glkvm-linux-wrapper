# glkvm-linux-wrapper — UI Overhaul Design (v2)

**Date:** 2026-07-31
**Status:** Approved (brainstorm complete, Direction A)
**Builds on:** the v1 app (`docs/superpowers/specs/2026-07-31-glkvm-linux-wrapper-design.md`)

## Summary

A professional, minimal UI pass on the shipped app: a **frameless window** with a custom always-on-top titlebar rail, an in-app **modal system** replacing the native OS popups, a **fix** for the KVM view not resizing with the window, a new **per-device OS icon** setting, and a restyle of every surface to a single restrained token system ("Direction A" — minimal & neutral, near-monochrome dark). No blue accents. Neutral placeholders only (never `workmac.local`).

## Goals

- Custom titlebar: frameless window, our own min/max/close + drag region, always visible (even when a device fills the window).
- Connected chrome in the rail: back-to-dashboard, device name, a live keyboard-capture indicator, disconnect.
- In-app modals replacing the 4 native `dialog.showMessageBox` popups (cert-trust, invalid-backup, import merge/replace, update-ready).
- Fix: the connected device view must fill the window and track every size change (resize, maximize/unmaximize, enter/leave fullscreen), offset by the rail height.
- Per-device OS icon (`macos` / `windows` / `linux` / `generic`), picked in add/edit, shown on device rows.
- Restyle all surfaces (dashboard, tiles→rows, buttons, settings panel, overlay, dialogs) to the Direction A token system.
- Replace every `workmac.local` occurrence with a neutral placeholder.

## Out of scope (v2)

- Wiring the still-inert hotkey app-actions (`next/prev-device`, `toggle-fullscreen`, `open-settings`, `quit`) — tracked separately as a post-v1 follow-up (though `open-settings`/`toggle-fullscreen`/back/disconnect become reachable via the new rail buttons).
- Light theme / system-following (dark only for v2; tokens are structured so a light theme is a later, additive change).
- Saved-password / keyring autofill; `.deb`/Flatpak (unchanged from v1 out-of-scope).

## Design tokens (Direction A)

- **Palette:** `--bg:#0c0c0d`, `--panel:#141416`, `--panel2:#161618`, `--line:#1c1c1f`, `--line2:#232327`, `--ink:#f2f2f3`, `--mut:#8a8a90`, `--dim:#6a6a70`, `--danger:#e5484d`. Status/connected accent `--ok:#34d399`. Primary button = `--ink` background / `--bg` text (white-on-dark). Per-device accent is user-chosen (swatch), used sparingly (status dot / hover).
- **Type:** `Inter` (400/500/600/700) for UI; `JetBrains Mono` (400/500) for addresses, fingerprints, and small caps labels. Headings tight tracking (`-0.01em`).
- **Shape/space:** radius 8–14px; generous whitespace; hairline `--line` dividers; list-based dashboard (rows, not a card grid).
- **Signature:** restraint — one quiet green status accent, white primary, whitespace and precise type carry it. No decoration that doesn't inform.

## Section 1 — Frameless window + titlebar architecture

The window becomes frameless (`BrowserWindow`/`BaseWindow` with `frame: false`). Because a device `WebContentsView` covers the whole content area when connected, the titlebar cannot live in the dashboard renderer — it needs its own layer that is always on top.

**Views (main process), stacked bottom→top:**
1. **Dashboard view** — the app UI (device list, settings, modals, connection overlay). Shown when idle; also brought frontmost transiently to host a modal/overlay over a connected device.
2. **Device views** — one persistent `WebContentsView` per connected device (unchanged from v1), attached on successful load.
3. **Titlebar view** — a thin (40px) always-on-top `WebContentsView` pinned to the top spanning the full width, its own sandboxed renderer. Holds the rail. Re-asserted to front whenever another view is added so it never gets covered.

**Layout math:** `RAIL_H = 40`. Dashboard and device views occupy `{ x:0, y:RAIL_H, width, height:height-RAIL_H }`. The titlebar view occupies `{ x:0, y:0, width, height:RAIL_H }`.

**Window controls & drag:** the rail renderer draws min/max/close; clicks call preload IPC (`win:minimize`/`win:toggle-maximize`/`win:close`). The rail's empty regions are CSS `-webkit-app-region: drag` (interactive controls are `no-drag`). Double-click on the drag region toggles maximize.

**Rail states (driven by connection state over IPC):**
- *Idle:* wordmark `GLKVM` left; window controls right.
- *Connected:* `‹ Devices` (back → `disconnect`), device name, a **CAPTURE ON** indicator (green dot + mono label; reflects that keyboard capture is active on the focused device view), `Disconnect` button; window controls right.

**Linux caveat:** frameless means no server-side decorations / native snap; we own controls + drag. Documented in README.

## Section 2 — Resize fix

Introduce a single `applyLayout()` in the window/connection layer that positions the titlebar, dashboard, and active device view from the current content bounds and `RAIL_H`. Call it on **all** size transitions, not just `resize`:
- `win.on('resize')`, `'maximize'`, `'unmaximize'`, `'enter-full-screen'`, `'leave-full-screen'`, and (Linux) `'restore'`.
The active device view's bounds come from the same helper, so the KVM view always fills the area under the rail. This directly fixes the reported bug (view stuck small while the window is large).

## Section 3 — In-app modal system

A reusable renderer modal component (`src/renderer/modal.ts`) renders a centered card + scrim in the Direction A style, returns a `Promise` of the user's choice, traps focus, closes on Escape/scrim, and is the single implementation behind every popup.

**Renderer-native modals (already in-renderer, restyled):** add/edit device, settings panel.

**Main→renderer modals (moved off native `dialog.showMessageBox`) via request/response IPC:**
- **Cert-trust** (`src/main/services/certs.ts` `promptTrust`): main sends `modal:cert-trust {host, fingerprint}` to the dashboard renderer and awaits a boolean. **Security invariant preserved:** the *decision logic stays in main* (`decideCert`); the renderer only displays host+fingerprint and returns yes/no; main persists via `store.trustCert` only on yes, exactly as today. The modal shows the SHA-256 fingerprint in a mono block.
- **Import merge/replace** (`ipc.ts`): `modal:import-choice` → returns `'merge' | 'replace' | 'cancel'`.
- **Invalid backup** (`ipc.ts`): `modal:alert {message}` → informational, returns void.
- **Update-ready** (`updater.ts`): `modal:update-ready {version}` → returns `'restart' | 'later'`.

**Native OS pickers kept:** file save/open for export/import (`dialog.showSaveDialog`/`showOpenDialog`) remain native — they are system file pickers, not app popups.

**Showing a modal over a connected device:** modals live in the dashboard renderer. A helper `presentOverlayUI()` brings the dashboard view frontmost (above the active device view) while a modal/overlay is showing, then restores the device view to front afterward. Cert-trust naturally occurs during `loading` (dashboard already frontmost); update-ready while connected uses this helper. The titlebar view stays on top throughout.

## Section 4 — Per-device OS icon

- **Model:** `Device` gains `os: OsKind` where `type OsKind = 'macos' | 'windows' | 'linux' | 'generic'`. Optional on input; defaults to `'generic'`. Added to `src/shared/types.ts`.
- **Validation/migration:** `validateDevices` (schema.ts) accepts a device missing `os` and fills `'generic'`; an invalid `os` value falls back to `'generic'` (never drops the device). Existing stored devices load fine (back-compat).
- **Store:** `addDevice`/`updateDevice` accept and persist `os`.
- **UI:** add/edit modal gets a **System** segmented picker (Apple / Windows / Linux / Generic monitor) bound to `os`. Each device row shows the matching monochrome SVG glyph in its avatar. Glyphs are inline SVG (no network); the Linux glyph is a clean Tux/penguin.
- **Backup:** `os` rides along in the existing device shape through export/import (round-trips automatically).

## Section 5 — Restyle surfaces

Rewrite `src/renderer/styles.css` to the Direction A tokens and adjust the renderer modules:
- **Dashboard** (`dashboard.ts`): list layout — a bordered container of device **rows** (OS glyph avatar, name, mono address, status dot + label, chevron), a header (title + count + search-ready slot + Settings + primary Add device). Empty state: a quiet invitation to add the first device.
- **Buttons:** primary (white), secondary (ghost/outline), danger (disconnect hover red).
- **Settings panel & device dialog:** restyled to the modal component and tokens; hotkey rows and the action selector keep their function, restyled.
- **Connection overlay** (`overlay.ts`): restyled loading/error states in the same language; still shows over the dashboard (Retry/Back).

## Section 6 — Placeholder scrub

Replace every `workmac.local` with a neutral value (`mypc.local`, `desktop.local`, `192.168.1.42`, `example-host.local`, etc.):
- `src/renderer/deviceDialog.ts` (placeholder attr)
- `README.md` (usage examples)
- `test/shared/url.test.ts`, `test/shared/schema.test.ts`, `test/shared/certs.test.ts`, `test/main/store.test.ts` (fixtures)
Update assertions to match the new fixture strings. (Rule recorded in memory: never use `workmac.local` as an example/fixture.)

## Section 7 — Testing

- **Unit (vitest, `--maxWorkers=2`):** extend `schema.test.ts` for the `os` field (default fill, invalid→generic, valid pass-through, back-compat for a device with no `os`); update fixtures for the placeholder scrub. Existing suites stay green.
- **Typecheck + build gates** for all main/renderer wiring (frameless, titlebar view, modal IPC, layout helper).
- **Smoke (Playwright electron):** keep the existing boot→add→failed-connect→overlay test (update selectors if markup changed); add a check that the custom rail renders window controls and the Add-device flow still works with the new modal component. Manual checklist: real resize/maximize while connected fills the view; cert-trust modal appears in-app; update-ready modal.
- **Security re-check in review:** cert-trust IPC path must not let the renderer bypass `decideCert`; main remains the sole trust authority.

## Proposed file changes

```
src/main/window.ts            # frame:false, RAIL_H, titlebar view, applyLayout(), size-event wiring
src/main/services/connections.ts # use applyLayout() for device-view bounds; front/restore helper
src/main/services/certs.ts    # promptTrust -> modal:cert-trust IPC (was showMessageBox)
src/main/services/updater.ts  # update-ready -> modal:update-ready IPC
src/main/ipc.ts               # win:* controls; modal:* request/response; import/alert modals
src/main/main.ts              # create titlebar view; wire rail state; presentOverlayUI helper
src/preload/preload.ts,api.ts # win:* + modal:* + rail-state channels; typed API
src/renderer/titlebar.html/.ts/.css  # NEW rail renderer (its own entry)
src/renderer/modal.ts         # NEW reusable modal component
src/renderer/dashboard.ts     # list rows + OS glyphs + header
src/renderer/deviceDialog.ts  # modal component + System picker + neutral placeholder
src/renderer/settingsPanel.ts # modal component + restyle
src/renderer/overlay.ts       # restyle
src/renderer/styles.css       # Direction A tokens, full rewrite
src/shared/types.ts           # OsKind + Device.os
src/shared/schema.ts          # validate/migrate os; isDevice tolerant of missing os
electron.vite.config.ts       # add titlebar.html as a second renderer entry
test/shared/*.test.ts, test/main/store.test.ts # os tests + placeholder scrub
```

## Deferred / follow-ups (unchanged + new)

- Wire the inert hotkey app-actions; `captureIndicator` is now delivered in the rail, `launchToLastDevice` still unimplemented.
- Light theme (tokens are ready for it).
- Optional: per-OS default accent, device search/filter (header slot is reserved).
