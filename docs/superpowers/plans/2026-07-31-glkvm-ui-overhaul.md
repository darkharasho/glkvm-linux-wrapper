# glkvm-linux-wrapper UI Overhaul (v2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the shipped app a professional, minimal UI (Direction A): a frameless window with a custom always-on-top titlebar, in-app modals replacing the native popups, a fix for the KVM view not resizing, and a per-device OS-icon setting — with neutral placeholders throughout.

**Architecture:** Electron main owns three view layers under a frameless window — a thin always-on-top **titlebar** `WebContentsView`, the **dashboard** view, and per-device **device** views — positioned by one shared `layout` helper (`RAIL_H` offset) on every size event. The dashboard renderer hosts a reusable **modal component**; the four popups that currently call native `dialog.showMessageBox` (cert-trust, import choice, invalid-backup, update-ready) move to that component via a request/response IPC bridge, with the cert-trust **decision authority staying in main**. A new `Device.os` field flows through shared validation, the store, the add/edit picker, and device rows.

**Tech Stack:** Electron, TypeScript, electron-vite (add a 2nd renderer entry for the titlebar), vitest (`--maxWorkers=2`), Playwright electron smoke, Inter + JetBrains Mono.

## Global Constraints

- **Direction A tokens (verbatim):** `--bg:#0c0c0d --panel:#141416 --panel2:#161618 --line:#1c1c1f --line2:#232327 --ink:#f2f2f3 --mut:#8a8a90 --dim:#6a6a70 --danger:#e5484d --ok:#34d399`. Primary button = `--ink` bg / `--bg` text. Fonts: `Inter` (UI), `JetBrains Mono` (addresses/fingerprints/caps labels). **No blue anywhere.**
- **Never use `workmac.local`** (or any real personal host) as a placeholder/fixture. Use neutral values: `mypc.local`, `desktop.local`, `192.168.1.42`, `example-host.local`.
- **Security invariant:** the cert-trust decision authority stays in the main process (`decideCert` + `store.trustCert`). The renderer modal only *displays* host+fingerprint and returns a boolean. Never let the renderer bypass the decision, and never add a global TLS bypass.
- **Renderer security:** all renderers (dashboard + titlebar) keep `contextIsolation:true, nodeIntegration:false, sandbox:true`; privileged calls go through the preload bridge only.
- **vitest** runs with `--maxWorkers=2` (unchanged `test` script).
- **RAIL_H = 40** (titlebar height). Dashboard/device views occupy `y:RAIL_H .. height`.
- **Frameless:** `frame:false`; we own min/max/close + drag. Dark theme only for v2.
- Keep the app id `com.darkharasho.glkvm-linux-wrapper`, product `GLKVM`, MIT.

---

## File Structure

```
src/shared/types.ts            # + OsKind, Device.os
src/shared/schema.ts           # validate/migrate os (tolerant), OS_KINDS, coerceOs
src/main/layout.ts             # NEW: RAIL_H, contentArea(win), railArea(win)
src/main/window.ts             # frame:false, titlebar view, LayoutController, size-event wiring
src/main/services/connections.ts # device-view bounds via LayoutController; front/restore for modals
src/main/services/certs.ts     # promptTrust -> requestModal (was showMessageBox)
src/main/services/updater.ts   # update-ready -> requestModal
src/main/ipc.ts                # win:* controls; import-choice + alert via requestModal
src/main/modal-bridge.ts       # NEW: requestModal(view, spec) request/response correlation
src/main/main.ts               # build titlebar view; wire rail state; presentOverlayUI
src/preload/preload.ts, api.ts # win:* + modal + rail channels; os in device inputs
src/preload/titlebar-preload.ts# NEW: minimal bridge for the rail renderer
src/renderer/titlebar.html/.ts # NEW: rail renderer (2nd entry)
src/renderer/modal.ts          # NEW: reusable modal component
src/renderer/osicon.ts         # NEW: OsKind -> inline SVG glyph
src/renderer/dashboard.ts      # list rows + OS glyph + header
src/renderer/deviceDialog.ts   # modal component + System picker + neutral placeholder
src/renderer/settingsPanel.ts  # modal component + restyle
src/renderer/overlay.ts        # restyle
src/renderer/main.ts           # host modal IPC handlers; rail nav
src/renderer/styles.css        # Direction A tokens (rewrite)
electron.vite.config.ts        # + titlebar.html renderer input
test/shared/schema.test.ts     # os tests + placeholder scrub
test/shared/*, test/main/store.test.ts # placeholder scrub + os in store
README.md                      # neutral placeholders; frameless note
package.json                   # version 0.2.0
```

**Task order:** shared os → store os → tokens/css → osicon → modal component → dashboard rows → device dialog → settings → overlay → layout+frameless+titlebar → connections layout → modal IPC bridge (cert/import/alert/update) → placeholder scrub (README) → smoke + version bump.

---

## Task 1: Shared — `Device.os` field + tolerant validation

**Files:**
- Modify: `src/shared/types.ts`, `src/shared/schema.ts`
- Test: `test/shared/schema.test.ts`

**Interfaces:**
- Consumes: existing `Device`, `validateDevices`.
- Produces: `type OsKind = 'macos'|'windows'|'linux'|'generic'`; `Device.os: OsKind`; `OS_KINDS: OsKind[]`; `coerceOs(v: unknown): OsKind` (returns the value if a valid OsKind else `'generic'`). `validateDevices` fills/repairs `os` on every device (missing or invalid → `'generic'`), never dropping a device solely for `os`.

- [ ] **Step 1: Write the failing tests** — append to `test/shared/schema.test.ts`:

```ts
import { coerceOs, OS_KINDS } from '@shared/schema';

describe('os field', () => {
  it('defaults a device with no os to generic (back-compat)', () => {
    const [d] = validateDevices([
      { id: 'a', name: 'A', address: 'mypc.local', url: 'https://mypc.local', createdAt: 1 },
    ]);
    expect(d.os).toBe('generic');
  });
  it('keeps a valid os and repairs an invalid one', () => {
    const out = validateDevices([
      { id: 'a', name: 'A', address: 'mypc.local', url: 'https://mypc.local', createdAt: 1, os: 'macos' },
      { id: 'b', name: 'B', address: 'desktop.local', url: 'https://desktop.local', createdAt: 1, os: 'beos' },
    ]);
    expect(out[0].os).toBe('macos');
    expect(out[1].os).toBe('generic');
  });
  it('coerceOs guards the union', () => {
    expect(coerceOs('linux')).toBe('linux');
    expect(coerceOs(42)).toBe('generic');
    expect(OS_KINDS).toContain('windows');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/shared/schema.test.ts`
Expected: FAIL — `coerceOs`/`OS_KINDS` not exported; `d.os` undefined.

- [ ] **Step 3: Implement**

`src/shared/types.ts` — add above `Device`:
```ts
export type OsKind = 'macos' | 'windows' | 'linux' | 'generic';
```
and add `os: OsKind;` to the `Device` interface (place after `color?`).

`src/shared/schema.ts` — add and wire in:
```ts
import type { OsKind } from './types';

export const OS_KINDS: OsKind[] = ['macos', 'windows', 'linux', 'generic'];

export function coerceOs(v: unknown): OsKind {
  return (OS_KINDS as string[]).includes(v as string) ? (v as OsKind) : 'generic';
}
```
In `validateDevices`, map the filtered devices to fill `os`:
```ts
export function validateDevices(raw: unknown): Device[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(isDevice)
    .map((d) => ({ ...(d as Device), os: coerceOs((d as { os?: unknown }).os) }));
}
```
(Leave `isDevice` unchanged — `os` is intentionally NOT a required field so old stored devices still pass.)

- [ ] **Step 4: Run to verify pass** — `npx vitest run test/shared/schema.test.ts` → PASS; then `npm test` → all green.

- [ ] **Step 5: Commit**
```bash
git add src/shared/types.ts src/shared/schema.ts test/shared/schema.test.ts
git commit -m "feat: add per-device os field with tolerant validation"
```

---

## Task 2: Store — persist `os` on add/update; scrub fixtures

**Files:**
- Modify: `src/main/services/store.ts`
- Test: `test/main/store.test.ts` (add os coverage; replace `workmac.local` fixtures with neutral hosts)

**Interfaces:**
- Consumes: Task 1 (`OsKind`, `coerceOs`).
- Produces: `addDevice(input: { name; address; color?; os?: OsKind })` persists `os` (default `'generic'`); `updateDevice(id, patch)` accepts `os?: OsKind`.

- [ ] **Step 1: Write failing tests** — in `test/main/store.test.ts`, first replace every `workmac.local` with `mypc.local` (and adjust expected URLs to `https://mypc.local`), then add:

```ts
it('persists os, defaulting to generic', () => {
  const s = createStore(dir);
  const a = s.addDevice({ name: 'A', address: 'mypc.local' });
  expect(a.os).toBe('generic');
  const b = s.addDevice({ name: 'B', address: 'desktop.local', os: 'linux' });
  expect(b.os).toBe('linux');
  expect(createStore(dir).getDevices().find(d => d.id === b.id)!.os).toBe('linux');
});
it('updates os', () => {
  const s = createStore(dir);
  const a = s.addDevice({ name: 'A', address: 'mypc.local' });
  s.updateDevice(a.id, { os: 'windows' });
  expect(s.getDevices()[0].os).toBe('windows');
});
```

- [ ] **Step 2: Run to verify it fails** — `npx vitest run test/main/store.test.ts` → FAIL (`os` undefined / type error).

- [ ] **Step 3: Implement** — in `src/main/services/store.ts`:
- import `coerceOs` from `@shared/schema`.
- `addDevice` input type → `{ name: string; address: string; color?: string; os?: OsKind }`; when building the device add `os: coerceOs(input.os)`.
- `updateDevice` patch type → add `os?: OsKind`; when merging, `os: coerceOs(patch.os ?? devices[i].os)`.

- [ ] **Step 4: Run to verify pass** — `npx vitest run test/main/store.test.ts` → PASS; `npm test` → green.

- [ ] **Step 5: Commit**
```bash
git add src/main/services/store.ts test/main/store.test.ts
git commit -m "feat: persist device os in the store; scrub placeholder host"
```

---

## Task 3: Direction A tokens — rewrite `styles.css`

**Files:** Modify `src/renderer/styles.css`, `src/renderer/index.html` (font links).

**Interfaces:** Produces the CSS custom properties + base element styles every later renderer task depends on. Gate: `npm run build` + visual (later smoke).

- [ ] **Step 1: Add fonts** in `src/renderer/index.html` `<head>`:
```html
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
```

- [ ] **Step 2: Rewrite `styles.css`** with the token block and base styles. Full contents:
```css
:root{
  --bg:#0c0c0d; --panel:#141416; --panel2:#161618; --line:#1c1c1f; --line2:#232327;
  --ink:#f2f2f3; --mut:#8a8a90; --dim:#6a6a70; --danger:#e5484d; --ok:#34d399;
  color-scheme: dark;
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);
  font-family:Inter,system-ui,sans-serif;-webkit-font-smoothing:antialiased}
.mono{font-family:'JetBrains Mono',monospace}
#app{min-height:100vh;display:flex;flex-direction:column}

button{font-family:inherit;font-size:12.5px;font-weight:500;color:var(--ink);
  background:transparent;border:1px solid var(--line2);border-radius:8px;padding:9px 14px;cursor:pointer}
button:hover{background:var(--panel2)}
button.pri{background:var(--ink);color:var(--bg);border:none;font-weight:600}
button.pri:hover{filter:brightness(.92)}
button.danger:hover{color:#ff6b6b;border-color:#3a2626;background:transparent}

/* dashboard */
.topbar{display:flex;align-items:flex-end;justify-content:space-between;padding:30px 34px 22px}
.topbar h1{font-size:24px;font-weight:600;letter-spacing:-.02em;margin:0}
.topbar .sub{color:var(--mut);font-size:13px;margin-top:5px}
.topbar .actions{display:flex;gap:10px}
.list{margin:0 34px;border:1px solid var(--line);border-radius:12px;overflow:hidden}
.row{display:flex;align-items:center;gap:15px;padding:15px 18px;border-bottom:1px solid var(--line);
  width:100%;text-align:left;background:transparent;border-radius:0;cursor:pointer}
.row:last-child{border-bottom:none}
.row:hover{background:#101012}
.row .av{width:34px;height:34px;border-radius:9px;background:var(--panel2);border:1px solid var(--line2);
  display:grid;place-items:center;color:var(--ink);flex:none}
.row .av svg{width:19px;height:19px}
.row .meta{display:flex;flex-direction:column;gap:2px}
.row .nm{font-size:15px;font-weight:500}
.row .addr{font-size:12.5px;color:var(--mut)}
.row .st{margin-left:auto;display:flex;align-items:center;gap:8px;font-size:12px;color:var(--mut)}
.row .st .dot{width:8px;height:8px;border-radius:50%;background:#3a3a3f}
.row .st.on .dot{background:var(--ok)}
.row .st.on{color:var(--ok)}
.row .chev{color:#4b4b52;font-size:15px}
.empty{color:var(--mut);padding:40px;text-align:center}

/* modal component */
.scrim{position:fixed;inset:0;background:rgba(0,0,0,.55);backdrop-filter:blur(2px);
  display:grid;place-items:center;z-index:100}
.modal{width:380px;max-width:calc(100vw - 40px);background:var(--panel);border:1px solid var(--line2);
  border-radius:14px;overflow:hidden;box-shadow:0 24px 60px rgba(0,0,0,.6)}
.modal .mh{padding:20px 20px 0}
.modal h3{margin:0;font-size:16px;font-weight:600;letter-spacing:-.01em}
.modal .mh .s{font-size:12.5px;color:var(--mut);margin-top:5px;line-height:1.5}
.modal .mb{padding:16px 20px 4px;display:flex;flex-direction:column;gap:13px}
.modal .mf{display:flex;justify-content:flex-end;gap:9px;padding:18px 20px}
.fld label{font-size:11px;color:var(--mut);display:block;margin-bottom:6px}
.fld input{width:100%;font-family:inherit;font-size:13px;color:var(--ink);background:var(--bg);
  border:1px solid var(--line2);border-radius:8px;padding:9px 11px}
.fld input:focus{outline:none;border-color:#3a3a40}
.fld input::placeholder{color:var(--dim)}
.seg{display:flex;gap:8px}
.seg .os{flex:1;max-width:56px;aspect-ratio:1;display:grid;place-items:center;background:var(--bg);
  border:1px solid var(--line2);border-radius:9px;color:var(--mut);cursor:pointer}
.seg .os svg{width:20px;height:20px}
.seg .os.sel{border-color:var(--ink);color:var(--ink);background:var(--panel2)}
.swatches{display:flex;gap:8px}
.swatches .sw{width:22px;height:22px;border-radius:6px;cursor:pointer;border:2px solid transparent}
.swatches .sw.sel{border-color:var(--ink)}
.fp{font-family:'JetBrains Mono',monospace;font-size:11.5px;color:var(--mut);background:var(--bg);
  border:1px solid var(--line2);border-radius:8px;padding:11px 12px;word-break:break-all;line-height:1.5}
.fp .k{color:var(--dim)}

/* settings + hotkeys (restyled) */
.settings .io{display:flex;gap:8px;margin-bottom:8px}
.hotkey-row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:9px 11px;
  border:1px solid var(--line2);border-radius:8px;background:var(--bg)}
.hotkey-row .label{font-size:13px}
.hotkey-row .accel{font-family:'JetBrains Mono',monospace;font-size:12px;color:var(--ink);background:var(--panel2);
  border:1px solid var(--line2);border-radius:6px;padding:4px 8px;cursor:pointer;min-width:84px;text-align:center}
.hotkey-row .accel:focus{outline:2px solid var(--ink);outline-offset:1px}
.hotkey-row .action{font-family:inherit;font-size:12px;color:var(--ink);background:var(--bg);
  border:1px solid var(--line2);border-radius:6px;padding:4px 6px}
.hotkey-row .action:disabled{opacity:.5;cursor:not-allowed}

/* connection overlay */
.overlay{position:fixed;inset:0;display:grid;place-items:center;background:var(--bg);z-index:50}
.overlay .box{text-align:center;max-width:360px}
.overlay .err{font-size:15px;font-weight:600}
.overlay .detail{font-size:12.5px;color:var(--mut);margin-top:6px}
.overlay .spinner{width:22px;height:22px;border:2px solid var(--line2);border-top-color:var(--ink);
  border-radius:50%;margin:0 auto 12px;animation:spin 1s linear infinite}
.overlay menu{display:flex;gap:9px;justify-content:center;margin:16px 0 0;padding:0}
@keyframes spin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion: reduce){.overlay .spinner{animation:none}}
```

- [ ] **Step 3: Verify** — `npm run build` succeeds; `npm run typecheck` passes.

- [ ] **Step 4: Commit**
```bash
git add src/renderer/styles.css src/renderer/index.html
git commit -m "feat: Direction A design tokens and base styles"
```

---

## Task 4: `osicon.ts` — OsKind → inline SVG glyph

**Files:** Create `src/renderer/osicon.ts`.

**Interfaces:** Produces `osIcon(os: OsKind): string` returning an inline `<svg>…</svg>` string (monochrome, `currentColor`, no network). Used by the dashboard rows and the device dialog picker.

- [ ] **Step 1: Implement**
```ts
import type { OsKind } from '@shared/types';

const P: Record<OsKind, string> = {
  macos: '<path d="M16.4 12.9c0-2 1.6-3 1.7-3-.9-1.4-2.4-1.5-2.9-1.6-1.2-.1-2.4.7-3 .7-.6 0-1.6-.7-2.6-.7-1.3 0-2.6.8-3.2 2-1.4 2.4-.4 6 1 8 .7 1 1.4 2 2.4 2 1 0 1.3-.6 2.5-.6 1.1 0 1.5.6 2.5.6s1.7-.9 2.3-1.9c.7-1.1 1-2.1 1-2.2 0 0-2-.8-2.2-3.6zM14.6 6.3c.5-.7.9-1.6.8-2.6-.8 0-1.8.6-2.4 1.2-.5.6-1 1.5-.8 2.4.9.1 1.8-.4 2.4-1z" fill="currentColor"/>',
  windows: '<path d="M3 5.5 10.5 4.4v7.1H3zM11.6 4.2 21 3v8.5h-9.4zM3 12.5h7.5v7.1L3 18.5zM11.6 12.5H21V21l-9.4-1.3z" fill="currentColor"/>',
  linux: '<path d="M12 2c-1.9 0-3.2 1.7-3.2 4 0 1 .1 1.8-.5 2.8-.7 1-2.3 2.6-2.9 4.6-.5 1.6-.2 2.6-.5 3.4-.3.7-1 1.2-1 1.9 0 .6.5.9 1.2 1 .8.1 1.9.5 2.8 1 .7.4 1.4.2 1.7-.2.5.1 1.1.2 1.9.2s1.4-.1 1.9-.2c.3.4 1 .6 1.7.2.9-.5 2-.9 2.8-1 .7-.1 1.2-.4 1.2-1 0-.7-.7-1.2-1-1.9-.3-.8 0-1.8-.5-3.4-.6-2-2.2-3.6-2.9-4.6-.6-1-.5-1.8-.5-2.8 0-2.3-1.3-4-3.2-4zm-1.6 5.1c.3 0 .6.4.6.9s-.3.9-.6.9-.6-.4-.6-.9.3-.9.6-.9zm3.2 0c.3 0 .6.4.6.9s-.3.9-.6.9-.6-.4-.6-.9.3-.9.6-.9zM12 10c.9 0 1.9.5 2 1 .1.4-.9 1-2 1s-2.1-.6-2-1c.1-.5 1.1-1 2-1z" fill="currentColor"/>',
  generic: '<rect x="2" y="4" width="20" height="14" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M8 21h8" fill="none" stroke="currentColor" stroke-width="2"/>',
};

export function osIcon(os: OsKind): string {
  return `<svg viewBox="0 0 24 24" aria-hidden="true">${P[os] ?? P.generic}</svg>`;
}
```

- [ ] **Step 2: Verify** — `npm run typecheck` passes.

- [ ] **Step 3: Commit**
```bash
git add src/renderer/osicon.ts
git commit -m "feat: add os icon glyphs"
```

---

## Task 5: Reusable modal component (`modal.ts`)

**Files:** Create `src/renderer/modal.ts`.

**Interfaces:** Produces:
```ts
export interface ModalButton { label: string; value: string; primary?: boolean; danger?: boolean; }
export interface ModalOpts { title: string; subtitle?: string; bodyHtml?: string; buttons: ModalButton[]; render?: (body: HTMLElement) => void; }
export function openModal(opts: ModalOpts): Promise<string>;  // resolves to the clicked button's value, or 'cancel' on Esc/scrim
```
Focus-trapped, Escape/scrim → `'cancel'`, first primary button gets initial focus. This is the single popup implementation used by device dialog, settings sub-prompts, and the main→renderer modal bridge (Task 12).

- [ ] **Step 1: Implement**
```ts
export interface ModalButton { label: string; value: string; primary?: boolean; danger?: boolean; }
export interface ModalOpts {
  title: string; subtitle?: string; bodyHtml?: string;
  buttons: ModalButton[]; render?: (body: HTMLElement) => void;
}

export function openModal(opts: ModalOpts): Promise<string> {
  return new Promise((resolve) => {
    const scrim = document.createElement('div');
    scrim.className = 'scrim';
    const modal = document.createElement('div');
    modal.className = 'modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.innerHTML = `
      <div class="mh"><h3></h3>${opts.subtitle ? '<div class="s"></div>' : ''}</div>
      <div class="mb"></div>
      <div class="mf"></div>`;
    (modal.querySelector('h3') as HTMLElement).textContent = opts.title;
    if (opts.subtitle) (modal.querySelector('.s') as HTMLElement).textContent = opts.subtitle;
    const body = modal.querySelector('.mb') as HTMLElement;
    if (opts.bodyHtml) body.innerHTML = opts.bodyHtml;   // caller-escaped / trusted markup only
    opts.render?.(body);

    const foot = modal.querySelector('.mf') as HTMLElement;
    let primaryBtn: HTMLButtonElement | null = null;
    for (const b of opts.buttons) {
      const el = document.createElement('button');
      el.textContent = b.label;
      if (b.primary) { el.className = 'pri'; primaryBtn = el; }
      if (b.danger) el.className = 'danger';
      el.addEventListener('click', () => finish(b.value));
      foot.appendChild(el);
    }

    function finish(v: string) { document.removeEventListener('keydown', onKey); scrim.remove(); resolve(v); }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') finish('cancel');
      if (e.key === 'Tab') { /* trap */
        const f = modal.querySelectorAll<HTMLElement>('button, input, [tabindex]');
        if (!f.length) return;
        const first = f[0], last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) { last.focus(); e.preventDefault(); }
        else if (!e.shiftKey && document.activeElement === last) { first.focus(); e.preventDefault(); }
      }
    }
    scrim.addEventListener('mousedown', (e) => { if (e.target === scrim) finish('cancel'); });
    document.addEventListener('keydown', onKey);
    scrim.appendChild(modal);
    document.body.appendChild(scrim);
    (primaryBtn ?? modal.querySelector('button, input') as HTMLElement)?.focus();
  });
}
```

- [ ] **Step 2: Verify** — `npm run typecheck` passes.

- [ ] **Step 3: Commit**
```bash
git add src/renderer/modal.ts
git commit -m "feat: add reusable modal component"
```

---

## Task 6: Dashboard — list rows with OS glyphs

**Files:** Modify `src/renderer/dashboard.ts`.

**Interfaces:** Consumes `osIcon` (Task 4), `window.glkvm`. Keeps the smoke hooks: `#add-btn`, tiles as `.row` with a `.nm`. Renders header (title + count + Settings + Add device) and a `.list` of `.row`s.

- [ ] **Step 1: Rewrite `renderDashboard`** to the row layout:
```ts
import type { Device } from '@shared/types';
import { openDeviceDialog } from './deviceDialog';
import { osIcon } from './osicon';

export async function renderDashboard(root: HTMLElement): Promise<void> {
  const devices = await window.glkvm.listDevices();
  const activeId = (await window.glkvm.activeDeviceId?.()) ?? null;
  root.innerHTML = `
    <header class="topbar">
      <div><h1>Devices</h1><div class="sub"></div></div>
      <div class="actions"><button id="settings-btn">Settings</button><button id="add-btn" class="pri">Add device</button></div>
    </header>
    <main class="list" id="list"></main>`;
  (root.querySelector('.sub') as HTMLElement).textContent =
    devices.length ? `${devices.length} saved · select one to connect` : '';
  const list = root.querySelector('#list') as HTMLElement;
  if (!devices.length) { list.className = ''; list.innerHTML = `<p class="empty">No devices yet. Add your first one.</p>`; }
  for (const d of devices) list.appendChild(rowFor(root, d, d.id === activeId));

  (root.querySelector('#add-btn') as HTMLElement).onclick = () =>
    openDeviceDialog({ onSave: async (i) => { await window.glkvm.addDevice(i); await renderDashboard(root); } });
  (root.querySelector('#settings-btn') as HTMLElement).onclick = () =>
    window.dispatchEvent(new CustomEvent('open-settings'));
}

function rowFor(root: HTMLElement, d: Device, on: boolean): HTMLElement {
  const el = document.createElement('button');
  el.className = 'row'; el.dataset.id = d.id;
  el.innerHTML = `
    <span class="av">${osIcon(d.os)}</span>
    <span class="meta"><span class="nm"></span><span class="addr mono"></span></span>
    <span class="st ${on ? 'on' : ''}"><span class="dot"></span><span class="lbl"></span></span>
    <span class="chev">›</span>`;
  (el.querySelector('.nm') as HTMLElement).textContent = d.name;
  (el.querySelector('.addr') as HTMLElement).textContent = d.address;
  (el.querySelector('.lbl') as HTMLElement).textContent = on ? 'Connected' : 'Idle';
  el.addEventListener('click', () => window.glkvm.connect(d.id));
  el.addEventListener('contextmenu', (e) => { e.preventDefault();
    openDeviceDialog({ device: d, onSave: async (i) => { await window.glkvm.updateDevice(d.id, i); await renderDashboard(root); } }); });
  return el;
}
```
(Note: `textContent` is used for all user strings — no `innerHTML` interpolation of device data. `activeDeviceId?.()` is optional; if the preload doesn't expose it, treat as `null`.)

- [ ] **Step 2: Verify** — `npm run typecheck` + `npm run build` pass.

- [ ] **Step 3: Commit**
```bash
git add src/renderer/dashboard.ts
git commit -m "feat: dashboard list rows with os glyphs"
```

---

## Task 7: Device dialog — modal component, System picker, neutral placeholder

**Files:** Modify `src/renderer/deviceDialog.ts`.

**Interfaces:** Consumes `openModal` (Task 5), `osIcon` (Task 4), `OS_KINDS`. `onSave` input gains `os: OsKind`. Placeholder text uses a neutral host.

- [ ] **Step 1: Reimplement `openDeviceDialog`** on the modal component:
```ts
import type { Device, OsKind } from '@shared/types';
import { OS_KINDS } from '@shared/schema';
import { openModal } from './modal';
import { osIcon } from './osicon';

interface Opts { device?: Device; onSave: (i: { name: string; address: string; color?: string; os: OsKind }) => Promise<void>; }
const SWATCHES = ['#34d399', '#e5e7eb', '#f4a13a', '#a78bfa', '#f472b6'];

export function openDeviceDialog(opts: Opts): void {
  let os: OsKind = opts.device?.os ?? 'generic';
  let color = opts.device?.color ?? '#34d399';
  openModal({
    title: opts.device ? 'Edit device' : 'Add device',
    subtitle: "Point it at the device's local address.",
    buttons: [{ label: 'Cancel', value: 'cancel' }, { label: opts.device ? 'Save' : 'Add device', value: 'save', primary: true }],
    render: (body) => {
      body.innerHTML = `
        <div class="fld"><label>Name</label><input name="name" placeholder="Design Mac"></div>
        <div class="fld"><label>Address</label><input name="address" class="mono" placeholder="mypc.local"></div>
        <div class="fld"><label>System</label><div class="seg" id="os"></div></div>
        <div class="fld"><label>Accent</label><div class="swatches" id="sw"></div></div>`;
      (body.querySelector('[name=name]') as HTMLInputElement).value = opts.device?.name ?? '';
      (body.querySelector('[name=address]') as HTMLInputElement).value = opts.device?.address ?? '';
      const seg = body.querySelector('#os') as HTMLElement;
      OS_KINDS.forEach((k) => { const b = document.createElement('span'); b.className = 'os' + (k === os ? ' sel' : ''); b.innerHTML = osIcon(k);
        b.onclick = () => { os = k; seg.querySelectorAll('.os').forEach((n, i) => n.classList.toggle('sel', OS_KINDS[i] === k)); }; seg.appendChild(b); });
      const sw = body.querySelector('#sw') as HTMLElement;
      SWATCHES.forEach((c) => { const s = document.createElement('span'); s.className = 'sw' + (c === color ? ' sel' : ''); s.style.background = c;
        s.onclick = () => { color = c; sw.querySelectorAll('.sw').forEach((n, i) => n.classList.toggle('sel', SWATCHES[i] === c)); }; sw.appendChild(s); });
    },
  }).then(async (v) => {
    if (v !== 'save') return;
    const root = document.querySelector('.scrim'); // already removed; read values before resolve? -> capture below
    void root;
  });
}
```
> Implementation note: capture the input values **inside** the modal before it closes. Simplest robust approach — read the field values in a `submit`-style handler by wiring the primary button through `render` state instead of after `openModal` resolves. Concretely: store references to the inputs in outer `let` variables during `render`, and in the `.then(v => …)` read `nameInput.value`/`addressInput.value` (the DOM nodes still hold their values until GC; capture the strings synchronously at click by reading them in `render` via an `input` listener into `let name/address`). Use the `let name/address/os/color` capture pattern (mirrors settingsPanel's draft pattern) so `onSave({ name, address, color, os })` is called with the final values. Verify by manual run: adding a device with a chosen OS persists that OS on the tile.

- [ ] **Step 2: Verify** — `npm run typecheck` + `npm run build`; manual: OS picker + accent select, Save persists (row shows the chosen glyph). Placeholder shows `mypc.local`, never `workmac.local`.

- [ ] **Step 3: Commit**
```bash
git add src/renderer/deviceDialog.ts
git commit -m "feat: device dialog on modal component with os picker"
```

---

## Task 8: Settings panel — modal component + restyle

**Files:** Modify `src/renderer/settingsPanel.ts`.

**Interfaces:** Keep `openSettings(root, onClose)` signature. Rehost on `openModal` (a larger modal variant) OR keep its own `<dialog>` but restyle to tokens; hotkey rows + action selector keep their behavior (accelerator capture already reuses `@shared/keybindings` `toAccelerator`). Export/Import buttons keep calling `window.glkvm.exportBackup/importBackup`. Escape/scrim closes and saves via `setSettings`.

- [ ] **Step 1: Restyle** — replace the native `<dialog>` shell with the modal component (title "Settings", a body containing the Export/Import row and the hotkey list, a single "Done" primary button that calls `setSettings(draft)` then closes). Keep the existing hotkey-row rendering + `captureAccelerator` (which already delegates to shared `toAccelerator`) and the action `<select>`, restyled via the `.hotkey-row` classes from Task 3. Continue escaping `hk.label`/`hk.accelerator` (retain the existing `escapeHtml`).

- [ ] **Step 2: Verify** — `npm run typecheck` + `npm run build`; manual: rebinding + action selector still work; Export/Import open native pickers.

- [ ] **Step 3: Commit**
```bash
git add src/renderer/settingsPanel.ts
git commit -m "feat: settings panel restyled on modal component"
```

---

## Task 9: Overlay restyle

**Files:** Modify `src/renderer/overlay.ts`.

**Interfaces:** Unchanged `showOverlay`/`hideOverlay` signatures; restyle markup to the `.overlay` classes from Task 3 (spinner for loading; err + detail + Retry/Back for error). Keep `#conn-overlay` id (smoke test depends on it) and `textContent` for the message (no unescaped innerHTML).

- [ ] **Step 1: Restyle** the two branches to the new classes; keep `id="conn-overlay"`, keep the message set via `textContent`.
- [ ] **Step 2: Verify** — `npm run typecheck` + `npm run build`.
- [ ] **Step 3: Commit**
```bash
git add src/renderer/overlay.ts
git commit -m "feat: restyle connection overlay"
```

---

## Task 10: Frameless window + titlebar view + layout helper + window IPC

**Files:** Create `src/main/layout.ts`, `src/renderer/titlebar.html`, `src/renderer/titlebar.ts`, `src/preload/titlebar-preload.ts`; modify `src/main/window.ts`, `src/main/ipc.ts`, `src/preload/preload.ts`, `src/preload/api.ts`, `electron.vite.config.ts`.

**Interfaces:**
- `src/main/layout.ts`: `export const RAIL_H = 40; export function railArea(win): Rect; export function contentArea(win): Rect;` (`Rect = {x,y,width,height}`; content is `y:RAIL_H, height:max(0,h-RAIL_H)`).
- `window.ts` returns `{ window, dashboard, titlebar, layout }` where `layout: LayoutController = { relayout(): void; setActiveDeviceView(v: WebContentsView|null): void; setRail(state): void }`. `relayout()` positions titlebar (railArea) + dashboard + active device view (contentArea) and re-raises the titlebar to top. `setRail(state)` sends `rail:state` to the titlebar renderer.
- Window control IPC (main): `win:minimize`, `win:toggle-maximize`, `win:close`. Rail nav IPC: `rail:back` / `rail:disconnect` (main calls `connections.disconnect()`), forwarded via a callback set in `main.ts`.

- [ ] **Step 1: `src/main/layout.ts`**
```ts
import type { BaseWindow } from 'electron';
export const RAIL_H = 40;
export interface Rect { x: number; y: number; width: number; height: number; }
export function railArea(win: BaseWindow): Rect { const b = win.getContentBounds(); return { x: 0, y: 0, width: b.width, height: RAIL_H }; }
export function contentArea(win: BaseWindow): Rect { const b = win.getContentBounds(); return { x: 0, y: RAIL_H, width: b.width, height: Math.max(0, b.height - RAIL_H) }; }
```

- [ ] **Step 2: `window.ts`** — frameless + titlebar view + LayoutController:
```ts
import { BaseWindow, WebContentsView } from 'electron';
import { join } from 'node:path';
import { RAIL_H, railArea, contentArea } from './layout';

export interface LayoutController {
  relayout(): void;
  setActiveDeviceView(v: WebContentsView | null): void;
  setRail(state: { mode: 'idle' | 'connected'; deviceName?: string; captureOn?: boolean }): void;
}

export function createMainWindow() {
  const win = new BaseWindow({ width: 1100, height: 760, title: 'GLKVM', frame: false, backgroundColor: '#0c0c0d' });
  const mk = (preload: string, sandbox = true) => new WebContentsView({ webPreferences: {
    preload: join(__dirname, preload), contextIsolation: true, nodeIntegration: false, sandbox } });

  const dashboard = mk('../preload/preload.js');
  const titlebar = mk('../preload/titlebar-preload.js');
  win.contentView.addChildView(dashboard);
  win.contentView.addChildView(titlebar);

  let activeDeviceView: WebContentsView | null = null;
  const relayout = () => {
    dashboard.setBounds(contentArea(win));
    if (activeDeviceView) activeDeviceView.setBounds(contentArea(win));
    titlebar.setBounds(railArea(win));
    win.contentView.addChildView(titlebar); // re-raise to top
  };
  const layout: LayoutController = {
    relayout,
    setActiveDeviceView: (v) => { activeDeviceView = v; },
    setRail: (s) => titlebar.webContents.send('rail:state', s),
  };

  const load = (view: WebContentsView, htmlFile: string, devPath: string) => {
    if (process.env.ELECTRON_RENDERER_URL) view.webContents.loadURL(process.env.ELECTRON_RENDERER_URL + devPath);
    else view.webContents.loadFile(join(__dirname, htmlFile));
  };
  load(dashboard, '../renderer/index.html', '/index.html');
  load(titlebar, '../renderer/titlebar.html', '/titlebar.html');

  for (const ev of ['resize', 'maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen', 'restore'] as const) {
    win.on(ev as 'resize', relayout);
  }
  relayout();
  return { window: win, dashboard, titlebar, layout };
}
```

- [ ] **Step 3: Titlebar renderer** — `src/renderer/titlebar.html` (loads its own inline styles using the same tokens + `-webkit-app-region`), and `src/renderer/titlebar.ts`:
```ts
// titlebar.ts — draws rail, reacts to rail:state, calls window controls
const bar = document.querySelector('#rail') as HTMLElement;
function render(s: { mode: 'idle'|'connected'; deviceName?: string; captureOn?: boolean }) {
  bar.innerHTML = s.mode === 'connected'
    ? `<div class="l no-drag">
         <button id="back" class="ghost">‹ Devices</button><span class="sep"></span>
         <span class="dev"></span>
         <span class="cap ${s.captureOn ? 'on' : ''}"><span class="dot"></span><span class="mono">CAPTURE ${s.captureOn ? 'ON' : 'OFF'}</span></span>
       </div>
       <div class="r no-drag"><button id="disc" class="ghost danger">Disconnect</button>${controls()}</div>`
    : `<div class="l"><span class="wm">GLKVM</span></div><div class="r no-drag">${controls()}</div>`;
  const dev = bar.querySelector('.dev'); if (dev) dev.textContent = s.deviceName ?? '';
  wire();
}
function controls(){ return `<div class="ctrls">
  <button class="c" data-a="min">–</button><button class="c" data-a="max">▢</button><button class="c x" data-a="close">✕</button></div>`; }
function wire(){
  bar.querySelector('#back')?.addEventListener('click', () => window.rail.back());
  bar.querySelector('#disc')?.addEventListener('click', () => window.rail.disconnect());
  bar.querySelectorAll<HTMLElement>('.c').forEach(b => b.addEventListener('click', () => window.rail.control(b.dataset.a!)));
}
window.rail.onState(render);
render({ mode: 'idle' });
```
`src/preload/titlebar-preload.ts` exposes `window.rail = { onState(cb), back(), disconnect(), control(action) }` over IPC channels `rail:state`, `rail:back`, `rail:disconnect`, `win:<action>`. Add matching `contextBridge` + typed global. The rail's background/drag: give the bar `-webkit-app-region: drag`, and `.no-drag` on interactive clusters; double-click the drag area → `window.rail.control('max')`.

- [ ] **Step 4: Main-process IPC** — in `ipc.ts` (or a small `win-ipc.ts`) register:
```ts
ipcMain.on('win:min', () => win.minimize());
ipcMain.on('win:max', () => (win.isMaximized() ? win.unmaximize() : win.maximize()));
ipcMain.on('win:close', () => win.close());
```
and rail nav (`rail:back`, `rail:disconnect`) forwarded to a handler `main.ts` supplies (calls `connections.disconnect()`). Add `win:*`/`rail:*` to the preload `api.ts` types as needed. Add `electron.vite.config.ts` renderer input for `titlebar.html`:
```ts
renderer: { /* … */ build: { rollupOptions: { input: { index: 'src/renderer/index.html', titlebar: 'src/renderer/titlebar.html' } } } }
```

- [ ] **Step 5: Verify** — `npm run typecheck` + `npm run build`; manual (with display): window is frameless, rail shows GLKVM + working min/max/close + drag; resizing/maximizing repositions dashboard + rail (device-view resize verified in Task 11).

- [ ] **Step 6: Commit**
```bash
git add src/main/layout.ts src/main/window.ts src/main/ipc.ts src/preload/ src/renderer/titlebar.* electron.vite.config.ts
git commit -m "feat: frameless window with custom titlebar rail and layout helper"
```

---

## Task 11: Connection manager — layout-driven bounds + rail state + resize fix

**Files:** Modify `src/main/services/connections.ts`, `src/main/main.ts`.

**Interfaces:** `Deps` gains `layout: LayoutController`. Replace the local `bounds()` + `window.on('resize')` handler with `layout` calls: on successful `did-finish-load`, `deps.layout.setActiveDeviceView(view); deps.layout.relayout();` and set the rail to connected; on `showDashboard()`/error, `deps.layout.setActiveDeviceView(null); deps.layout.relayout();` and rail idle. `main.ts` passes `layout`, and its `onState` also drives `layout.setRail(...)` (deviceName from the store; `captureOn:true` when a device is active).

- [ ] **Step 1: Rewrite bounds handling** — remove `const bounds = …` and the `deps.window.on('resize', …)` block (the window now owns all size events via `layout.relayout`). In `connect()` success handler:
```ts
deps.window.contentView.addChildView(newView);
deps.layout.setActiveDeviceView(newView);
deps.layout.relayout();
active = id;
deps.onState({ deviceId: id, state: 'ready' });
```
In `showDashboard()`:
```ts
if (active && views.has(active)) deps.window.contentView.removeChildView(views.get(active)!);
active = null; target = null;
deps.layout.setActiveDeviceView(null);
deps.layout.relayout();
deps.onState({ deviceId: null, state: 'ready' });
```
When detaching a superseded active view at the top of `connect()`, also `deps.layout.setActiveDeviceView(null)` before loading the new one.

- [ ] **Step 2: Rail state in `main.ts`** — in the `onState` callback, in addition to sending `conn:state` to the dashboard:
```ts
const dev = s.deviceId ? store.getDevices().find(d => d.id === s.deviceId) : null;
layout.setRail(s.deviceId && s.state === 'ready' && dev
  ? { mode: 'connected', deviceName: dev.name, captureOn: true }
  : { mode: 'idle' });
```
Wire `rail:back`/`rail:disconnect` IPC → `connections.disconnect()`.

- [ ] **Step 3: Verify** — `npm run typecheck` + `npm run build`; manual (display): connect a reachable host, then resize/maximize the window → the KVM view fills the area under the rail at every size (the reported bug is fixed); rail switches to connected with device name + CAPTURE ON + Disconnect; Disconnect/Back return to the dashboard.

- [ ] **Step 4: Commit**
```bash
git add src/main/services/connections.ts src/main/main.ts
git commit -m "fix: KVM view fills window on all resize events; drive rail state"
```

---

## Task 12: In-app modals over IPC (cert-trust, import, alert, update)

**Files:** Create `src/main/modal-bridge.ts`; modify `src/main/services/certs.ts`, `src/main/services/updater.ts`, `src/main/ipc.ts`, `src/main/main.ts`, `src/preload/preload.ts`, `src/preload/api.ts`, `src/renderer/main.ts`.

**Interfaces:**
- `modal-bridge.ts`: `export function createModalBridge(dashboard: WebContentsView, presentUI: () => () => void) { return { request(spec): Promise<string> } }`. `request` assigns an `id`, calls `presentUI()` (brings the dashboard frontmost, returns a `restore` fn), `dashboard.webContents.send('modal:show', { id, ...spec })`, awaits the renderer's `ipcMain.on('modal:done', {id,value})` correlated by id, calls `restore()`, resolves `value`.
- Renderer (`main.ts`): `window.glkvm.onModalShow((spec) => …)` → builds the right `openModal(...)` per `spec.kind` and replies `window.glkvm.modalDone(id, value)`.
- `presentUI` = `main.ts`'s `presentOverlayUI`: re-raise `dashboard` above the active device view (then re-raise titlebar), returning a `restore` that calls `layout.relayout()`.
- **Security:** `certs.ts` `promptTrust(host, fingerprint)` now `= (await bridge.request({ kind:'cert-trust', host, fingerprint })) === 'trust'`. `decideCert` and `store.trustCert` stay exactly as they are — the renderer only returns the boolean.

- [ ] **Step 1: `modal-bridge.ts`**
```ts
import type { WebContentsView } from 'electron';
import { ipcMain } from 'electron';

export interface ModalSpec { kind: 'cert-trust' | 'import-choice' | 'alert' | 'update-ready'; [k: string]: unknown; }

export function createModalBridge(dashboard: WebContentsView, presentUI: () => () => void) {
  const pending = new Map<number, (v: string) => void>();
  let seq = 0;
  ipcMain.on('modal:done', (_e, { id, value }: { id: number; value: string }) => {
    const r = pending.get(id); if (r) { pending.delete(id); r(value); }
  });
  return {
    request(spec: ModalSpec): Promise<string> {
      const id = ++seq;
      const restore = presentUI();
      return new Promise<string>((resolve) => {
        pending.set(id, resolve);
        dashboard.webContents.send('modal:show', { id, ...spec });
      }).finally(restore);
    },
  };
}
```

- [ ] **Step 2: Wire main callers**
- `certs.ts`: `installCertHandler(store, promptTrust)` unchanged; in `main.ts` build `promptTrust = async (host, fp) => (await bridge.request({ kind: 'cert-trust', host, fingerprint: fp })) === 'trust'`.
- `updater.ts`: replace the `dialog.showMessageBox` with `const v = await bridge.request({ kind: 'update-ready', version: i.version }); if (v === 'restart') autoUpdater.quitAndInstall();` (pass the bridge into `initUpdater`).
- `ipc.ts` import handler: replace `dialog.showMessageBox` merge/replace with `const v = await bridge.request({ kind: 'import-choice' });` mapping `'merge'|'replace'|'cancel'`; replace the invalid-backup `showMessageBox` with `await bridge.request({ kind: 'alert', message: 'That file isn't a valid GLKVM backup.' })`. Keep the native file pickers.

- [ ] **Step 3: Renderer host** — in `src/renderer/main.ts`:
```ts
window.glkvm.onModalShow(async (spec) => {
  let value = 'cancel';
  if (spec.kind === 'cert-trust') {
    value = await openModal({ title: 'Trust this device?',
      subtitle: `${spec.host} is using a self-signed certificate. Trust it only if you recognize this device.`,
      bodyHtml: `<div class="fp"><span class="k">SHA-256</span><br>${escapeHtml(String(spec.fingerprint))}</div>`,
      buttons: [{ label: 'Cancel', value: 'cancel' }, { label: 'Trust device', value: 'trust', primary: true }] });
  } else if (spec.kind === 'import-choice') {
    value = await openModal({ title: 'Import devices & settings', subtitle: 'Merge with your current setup, or replace everything?',
      buttons: [{ label: 'Cancel', value: 'cancel' }, { label: 'Merge', value: 'merge' }, { label: 'Replace', value: 'replace', primary: true }] });
  } else if (spec.kind === 'alert') {
    value = await openModal({ title: 'Import failed', subtitle: String(spec.message),
      buttons: [{ label: 'OK', value: 'ok', primary: true }] });
  } else if (spec.kind === 'update-ready') {
    value = await openModal({ title: 'Update ready', subtitle: `GLKVM ${spec.version} is ready to install.`,
      buttons: [{ label: 'Later', value: 'later' }, { label: 'Restart now', value: 'restart', primary: true }] });
  }
  window.glkvm.modalDone(spec.id, value);
});
```
Add `onModalShow`/`modalDone` to preload `api.ts` + `preload.ts` (channels `modal:show`, `modal:done`). Add a local `escapeHtml` (or import the shared one) for the fingerprint.

- [ ] **Step 4: Verify** — `npm run typecheck` + `npm run build`; manual (display): trigger an invalid import (alert modal), a valid import (merge/replace modal), and — against a real self-signed device or a stub — the cert-trust modal; confirm main still persists trust only on `'trust'`.

- [ ] **Step 5: Commit**
```bash
git add src/main/modal-bridge.ts src/main/services/certs.ts src/main/services/updater.ts src/main/ipc.ts src/main/main.ts src/preload/ src/renderer/main.ts
git commit -m "feat: move native popups to in-app modals over ipc (cert/import/alert/update)"
```

---

## Task 13: Placeholder scrub (README) + version bump + smoke update

**Files:** Modify `README.md`, `package.json`, `test/smoke/app.test.ts`, and any remaining `test/shared/*.test.ts` still using `workmac.local`.

**Interfaces:** No `workmac.local` anywhere; version `0.2.0`; smoke test matches the new markup.

- [ ] **Step 1: Scrub** — replace every `workmac.local` in `README.md`, `test/shared/url.test.ts`, `test/shared/certs.test.ts` (and any missed in Tasks 1–2) with neutral hosts (`mypc.local` / `desktop.local` / `192.168.1.42`), updating assertions accordingly. Add a one-line note to README that the window is frameless (custom titlebar; app-provided window controls).

- [ ] **Step 2: Version bump** — set `package.json` version to `0.2.0`.

- [ ] **Step 3: Update smoke** — in `test/smoke/app.test.ts`: keep the flow (boot → add device → click → `#conn-overlay` visible); update the add-device interaction for the modal component (the inputs are now inside `.modal`; selectors `input[name="name"]`, `input[name="address"]`, and the primary button — click the button whose text is "Add device"), and change the address fixture to `unreachable.invalid` (already neutral). Assert the custom rail exists (a `#rail` element / the `GLKVM` wordmark in the titlebar view is harder to reach cross-view in Playwright — assert on the dashboard window; if the titlebar is a separate view, target the dashboard window and just keep the existing overlay assertion). Run under a display / `xvfb-run` per the environment.

- [ ] **Step 4: Verify** — `npm test` (unit) green; `npm run test:smoke` passes on a display (or note UNRUN-headless per environment); `npm run build` succeeds.

- [ ] **Step 5: Commit**
```bash
git add README.md package.json test/
git commit -m "chore: scrub placeholders, bump to 0.2.0, update smoke for new UI"
```

---

## Self-Review

**Spec coverage:**
- Frameless window + titlebar architecture (spec §1) → Task 10. ✓
- Resize fix (§2) → Task 10 (size events) + Task 11 (device-view via layout). ✓
- In-app modal system (§3) → Task 5 (component) + Task 12 (IPC bridge + 4 popups); cert security invariant explicit in Task 12. ✓
- Per-device OS icon (§4) → Task 1 (schema) + Task 2 (store) + Task 4 (glyphs) + Task 6 (rows) + Task 7 (picker). ✓
- Restyle surfaces (§5) → Task 3 (tokens) + Tasks 6/7/8/9. ✓
- Placeholder scrub (§6) → Tasks 1, 2, 13. ✓
- Testing (§7) → unit in Tasks 1/2; typecheck/build gates throughout; smoke in Task 13. ✓

**Placeholder scan:** No TBDs. The one soft spot — capturing the device-dialog field values at modal close (Task 7) — is called out with a concrete `let`-capture pattern mirroring `settingsPanel`'s existing draft approach; the reviewer should confirm the final `onSave` receives the entered values.

**Type consistency:** `OsKind` defined once (Task 1), consumed by store (2), osicon (4), dialog (7). `LayoutController` defined in Task 10, consumed in Task 11. `openModal`/`ModalOpts` defined in Task 5, consumed in 7/8/12. `createModalBridge.request` returns the button `value` string used by all four callers. `RAIL_H`/`contentArea`/`railArea` defined in Task 10's `layout.ts`.

**Security:** cert-trust stays main-authoritative (Task 12 restates it; `decideCert`/`store.trustCert` untouched). Renderers stay sandboxed; titlebar view uses its own minimal preload. Fingerprint rendered via `escapeHtml`.

---

## Deferred / follow-ups
- Wire the still-inert hotkey app-actions (`next/prev-device`, `quit`; `toggle-fullscreen`/`open-settings` now also reachable via rail). `launchToLastDevice` still unimplemented.
- Light theme (tokens ready).
- Device search/filter (header slot reserved), per-OS default accent.
