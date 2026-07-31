# glkvm-linux-wrapper Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Linux-first Electron desktop app that wraps the GLKVM web UI: a dashboard of saved-device tiles, full-capture per-hotkey keyboard passthrough, persistent per-device sessions with self-signed cert trust, shipped as an auto-updating AppImage.

**Architecture:** Electron main/renderer split. All privileged work (embedded `WebContentsView`s, keybinding interception, cert trust, sessions, storage, auto-update) lives in the main process. The dashboard renderer is sandboxed and reaches main only through a typed `contextBridge` preload. The genuinely hard logic (URL normalization, schema/validation, keybinding resolution, cert decisions, backup merge) is extracted into pure functions in `src/shared/` and unit-tested without an Electron runtime; main-process services are thin adapters over that logic.

**Tech Stack:** Electron, TypeScript, electron-vite (Vite build for main/preload/renderer), vanilla TS renderer (no UI framework), vitest (unit), Playwright `_electron` (smoke), electron-builder (AppImage), electron-updater (GitHub Releases), GitHub Actions.

## Global Constraints

- **Platform target:** Linux-first; package format is **AppImage only** for v1.
- **Node/Electron security:** every renderer uses `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`. No raw Node in any renderer; all privileged calls go through the preload bridge.
- **TLS:** never globally disable certificate verification. Cert exceptions are per-device-host, matched by stored fingerprint.
- **Secrets:** v1 stores **no passwords**. Device/settings JSON and the export bundle contain no secrets.
- **Test runner:** vitest MUST run with `--maxWorkers=2` (machine CLAUDE.md rule). This is baked into the `test` script.
- **Storage location:** all app data under Electron `app.getPath('userData')` → `~/.config/glkvm-linux-wrapper/`. JSON writes are atomic (temp file + rename).
- **App id:** `com.darkharasho.glkvm-linux-wrapper`. Product name: `GLKVM`. License: MIT.
- **Icon:** already generated at `build/icon.png` (512px) and `build/icon.svg`; do not regenerate.

---

## File Structure

```
package.json                     # scripts, deps, electron-builder config block
electron.vite.config.ts          # electron-vite build config (main/preload/renderer)
tsconfig.json                    # TS config, path alias @shared
vitest.config.ts                 # node env, maxWorkers=2
.eslintrc.cjs                    # lint config
LICENSE                          # MIT
README.md                        # install + usage (exists; expand)
build/icon.svg, build/icon.png   # icons (exist)
.github/workflows/ci.yml         # lint + unit tests on push/PR
.github/workflows/release.yml    # build + publish AppImage on v* tag

src/shared/                      # pure logic — no Electron imports, unit-tested
  types.ts                       # Device, HotkeyBinding, Settings, BackupBundle, enums
  url.ts                         # normalizeAddress, toDeviceUrl, isValidAddress
  schema.ts                      # DEFAULT_*, validateDevices, validateSettings
  keybindings.ts                 # toAccelerator, resolveAction
  certs.ts                       # decideCert
  backup.ts                      # buildBackup, parseBackup, applyBackup, mergeDevices

src/main/
  main.ts                        # app lifecycle, creates MainWindow
  window.ts                      # BaseWindow + dashboard WebContentsView layout
  ipc.ts                         # registers all ipcMain handlers
  services/
    store.ts                     # createStore(baseDir): atomic JSON persistence
    connections.ts               # per-device WebContentsView lifecycle + partitions
    keyboard.ts                  # attaches before-input-event, dispatches app actions
    certs.ts                     # certificate-error handler + trusted-certs.json
    updater.ts                   # electron-updater wiring
    logger.ts                    # rotating file log in userData/logs

src/preload/
  preload.ts                     # contextBridge: window.glkvm typed API
  api.ts                         # shared type of the exposed API surface

src/renderer/
  index.html                     # dashboard shell
  main.ts                        # bootstraps dashboard
  dashboard.ts                   # tile grid render + interactions
  deviceDialog.ts                # add/edit device modal
  settingsPanel.ts               # hotkey editor + import/export UI
  overlay.ts                     # connection error/loading overlay
  styles.css

test/
  shared/*.test.ts               # unit tests for each shared module
  main/store.test.ts             # store service against a tmp dir
  smoke/app.test.ts              # Playwright _electron smoke tests
```

**Dependency order of tasks:** scaffolding → shared pure logic (url, schema, keybindings, certs, backup) → store service → preload/IPC → renderer dashboard → connection manager (views + keyboard + certs) → settings panel + import/export → error overlay + logging → auto-updater → packaging → CI → smoke tests → repo/README/LICENSE.

---

## Task 1: Project scaffolding & tooling

**Files:**
- Create: `package.json`, `electron.vite.config.ts`, `tsconfig.json`, `vitest.config.ts`, `.eslintrc.cjs`
- Create: `src/main/main.ts`, `src/main/window.ts`, `src/preload/preload.ts`, `src/renderer/index.html`, `src/renderer/main.ts`, `src/renderer/styles.css`
- Create: `src/shared/sanity.ts`, `test/shared/sanity.test.ts`
- Modify: `.gitignore` (already ignores node_modules/dist)

**Interfaces:**
- Consumes: nothing (first task).
- Produces: a bootable Electron app (`npm run dev`), a passing vitest run (`npm test`), and the `@shared/*` path alias used by all later tasks.

- [ ] **Step 1: Write the failing test**

`test/shared/sanity.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { ping } from '@shared/sanity';

describe('sanity', () => {
  it('proves the toolchain and @shared alias resolve', () => {
    expect(ping()).toBe('pong');
  });
});
```

- [ ] **Step 2: Create config files and run the test to verify it fails**

`package.json` (key fields):
```json
{
  "name": "glkvm-linux-wrapper",
  "version": "0.1.0",
  "description": "Linux-first Electron wrapper for the GL.iNet KVM web UI",
  "license": "MIT",
  "author": "darkharasho",
  "main": "out/main/main.js",
  "scripts": {
    "dev": "electron-vite dev",
    "build": "electron-vite build",
    "start": "electron-vite preview",
    "test": "vitest run --maxWorkers=2",
    "test:watch": "vitest --maxWorkers=2",
    "lint": "eslint . --ext .ts",
    "typecheck": "tsc --noEmit",
    "dist": "electron-vite build && electron-builder"
  },
  "devDependencies": {
    "electron": "^32.0.0",
    "electron-vite": "^2.3.0",
    "electron-builder": "^25.0.0",
    "typescript": "^5.5.0",
    "vite": "^5.4.0",
    "vitest": "^2.0.0",
    "eslint": "^8.57.0",
    "@typescript-eslint/parser": "^7.0.0",
    "@typescript-eslint/eslint-plugin": "^7.0.0",
    "playwright": "^1.47.0"
  },
  "dependencies": {
    "electron-updater": "^6.3.0"
  }
}
```

`tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "baseUrl": ".",
    "paths": { "@shared/*": ["src/shared/*"] }
  },
  "include": ["src", "test"]
}
```

`vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  test: { environment: 'node', maxWorkers: 2, minWorkers: 1 },
  resolve: { alias: { '@shared': resolve(__dirname, 'src/shared') } },
});
```

`electron.vite.config.ts`:
```ts
import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';

const alias = { '@shared': resolve(__dirname, 'src/shared') };

export default defineConfig({
  main: { resolve: { alias }, build: { rollupOptions: { input: 'src/main/main.ts' } } },
  preload: { build: { rollupOptions: { input: 'src/preload/preload.ts' } } },
  renderer: {
    resolve: { alias },
    root: 'src/renderer',
    build: { rollupOptions: { input: 'src/renderer/index.html' } },
  },
});
```

`.eslintrc.cjs`:
```js
module.exports = {
  parser: '@typescript-eslint/parser',
  plugins: ['@typescript-eslint'],
  extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended'],
  parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
  env: { node: true, browser: true, es2022: true },
  ignorePatterns: ['out', 'dist', 'node_modules'],
};
```

Run: `npm install && npm test`
Expected: FAIL — `Cannot find module '@shared/sanity'`.

- [ ] **Step 3: Write minimal implementation**

`src/shared/sanity.ts`:
```ts
export const ping = (): string => 'pong';
```

Minimal app shell so `npm run dev` boots (not yet under test):

`src/main/main.ts`:
```ts
import { app } from 'electron';
import { createMainWindow } from './window';

app.whenReady().then(() => {
  createMainWindow();
  app.on('activate', () => { /* re-create on macOS dock click */ });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
```

`src/main/window.ts`:
```ts
import { BaseWindow, WebContentsView } from 'electron';
import { join } from 'node:path';

export function createMainWindow(): BaseWindow {
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
  return win;
}
```

`src/preload/preload.ts`:
```ts
import { contextBridge } from 'electron';
// Expanded in Task 7. Placeholder bridge proves the wiring.
contextBridge.exposeInMainWorld('glkvm', { version: '0.1.0' });
```

`src/renderer/index.html`:
```html
<!doctype html>
<html>
  <head><meta charset="utf-8" /><title>GLKVM</title>
    <link rel="stylesheet" href="./styles.css" /></head>
  <body><div id="app">Loading…</div><script type="module" src="./main.ts"></script></body>
</html>
```

`src/renderer/main.ts`:
```ts
document.querySelector('#app')!.textContent = 'GLKVM dashboard (scaffold)';
```

`src/renderer/styles.css`:
```css
:root { color-scheme: dark; }
body { margin: 0; font-family: system-ui, sans-serif; background: #0d1117; color: #e6edf3; }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS (1 test). Also verify `npm run dev` opens a window showing "GLKVM dashboard (scaffold)".

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore: scaffold electron-vite + typescript + vitest toolchain"
```

---

## Task 2: Shared — URL normalization

**Files:**
- Create: `src/shared/url.ts`
- Test: `test/shared/url.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `normalizeAddress(input: string): string` — trims, strips scheme + trailing slash + path, lowercases host. Throws `Error` on empty/invalid.
  - `isValidAddress(input: string): boolean` — true when `normalizeAddress` would succeed.
  - `toDeviceUrl(address: string): string` — returns `https://<normalized-host>`.

- [ ] **Step 1: Write the failing test**

`test/shared/url.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { normalizeAddress, isValidAddress, toDeviceUrl } from '@shared/url';

describe('normalizeAddress', () => {
  it('strips scheme, path, and trailing slash', () => {
    expect(normalizeAddress('https://workmac.local/')).toBe('workmac.local');
    expect(normalizeAddress('http://WorkMac.local/ui')).toBe('workmac.local');
    expect(normalizeAddress('  workmac.local  ')).toBe('workmac.local');
  });
  it('keeps an explicit port', () => {
    expect(normalizeAddress('workmac.local:8443')).toBe('workmac.local:8443');
  });
  it('rejects empty or whitespace input', () => {
    expect(() => normalizeAddress('   ')).toThrow();
  });
});

describe('isValidAddress', () => {
  it('is false for empty, true for a host', () => {
    expect(isValidAddress('')).toBe(false);
    expect(isValidAddress('workmac.local')).toBe(true);
  });
});

describe('toDeviceUrl', () => {
  it('always produces an https url', () => {
    expect(toDeviceUrl('workmac.local')).toBe('https://workmac.local');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/shared/url.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

`src/shared/url.ts`:
```ts
export function normalizeAddress(input: string): string {
  let s = input.trim();
  if (!s) throw new Error('Address is empty');
  s = s.replace(/^[a-z]+:\/\//i, '');   // strip scheme
  s = s.split('/')[0];                   // strip path
  s = s.replace(/\/+$/, '');             // strip trailing slash
  s = s.toLowerCase();
  if (!s) throw new Error('Address is empty after normalization');
  if (/\s/.test(s)) throw new Error('Address contains whitespace');
  return s;
}

export function isValidAddress(input: string): boolean {
  try { normalizeAddress(input); return true; } catch { return false; }
}

export function toDeviceUrl(address: string): string {
  return `https://${normalizeAddress(address)}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/shared/url.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/shared/url.ts test/shared/url.test.ts
git commit -m "feat: add device address normalization"
```

---

## Task 3: Shared — types, schema defaults & validation

**Files:**
- Create: `src/shared/types.ts`, `src/shared/schema.ts`
- Test: `test/shared/schema.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces (in `types.ts`):
  ```ts
  export type AppAction = 'back-to-dashboard' | 'next-device' | 'prev-device'
    | 'toggle-fullscreen' | 'open-settings' | 'quit';
  export type HotkeyAction = 'remote' | 'release' | `local:${AppAction}`;
  export interface HotkeyBinding { id: string; label: string; accelerator: string; action: HotkeyAction; editable: boolean; }
  export interface Device { id: string; name: string; address: string; url: string; color?: string; createdAt: number; }
  export interface Settings { version: number; general: { launchToLastDevice: boolean; captureIndicator: boolean; }; hotkeys: HotkeyBinding[]; }
  export interface BackupBundle { version: number; devices: Device[]; settings: Settings; }
  ```
- Produces (in `schema.ts`):
  - `SCHEMA_VERSION: number` (= 1)
  - `DEFAULT_HOTKEYS: HotkeyBinding[]`
  - `DEFAULT_SETTINGS: Settings`
  - `validateDevices(raw: unknown): Device[]` — drops malformed entries, never throws.
  - `validateSettings(raw: unknown): Settings` — fills missing fields from defaults, merges hotkeys by `id`, never throws.

- [ ] **Step 1: Write the failing test**

`test/shared/schema.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { DEFAULT_HOTKEYS, DEFAULT_SETTINGS, validateDevices, validateSettings } from '@shared/schema';

describe('defaults', () => {
  it('ship a release hotkey and a back-to-dashboard local action', () => {
    expect(DEFAULT_HOTKEYS.some(h => h.action === 'release')).toBe(true);
    expect(DEFAULT_HOTKEYS.some(h => h.action === 'local:back-to-dashboard')).toBe(true);
  });
});

describe('validateDevices', () => {
  it('keeps well-formed devices and drops malformed ones', () => {
    const out = validateDevices([
      { id: 'a', name: 'Work', address: 'workmac.local', url: 'https://workmac.local', createdAt: 1 },
      { id: 'b' }, // missing fields -> dropped
      'garbage',
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe('a');
  });
  it('returns [] for non-array input', () => {
    expect(validateDevices(null)).toEqual([]);
  });
});

describe('validateSettings', () => {
  it('fills defaults for missing fields', () => {
    const s = validateSettings({});
    expect(s.version).toBe(DEFAULT_SETTINGS.version);
    expect(s.hotkeys.length).toBe(DEFAULT_HOTKEYS.length);
  });
  it('merges a user hotkey override by id', () => {
    const custom = { ...DEFAULT_HOTKEYS[0], accelerator: 'Ctrl+Alt+Q' };
    const s = validateSettings({ hotkeys: [custom] });
    const merged = s.hotkeys.find(h => h.id === custom.id)!;
    expect(merged.accelerator).toBe('Ctrl+Alt+Q');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/shared/schema.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

`src/shared/types.ts` — exactly the interface block above.

`src/shared/schema.ts`:
```ts
import type { Device, HotkeyBinding, Settings } from './types';

export const SCHEMA_VERSION = 1;

export const DEFAULT_HOTKEYS: HotkeyBinding[] = [
  { id: 'release',     label: 'Release keyboard capture', accelerator: 'Ctrl+Alt+Escape', action: 'release', editable: true },
  { id: 'dashboard',   label: 'Back to dashboard',        accelerator: 'Ctrl+Alt+D',      action: 'local:back-to-dashboard', editable: true },
  { id: 'next',        label: 'Next device',              accelerator: 'Ctrl+Alt+Right',  action: 'local:next-device', editable: true },
  { id: 'prev',        label: 'Previous device',          accelerator: 'Ctrl+Alt+Left',   action: 'local:prev-device', editable: true },
  { id: 'fullscreen',  label: 'Toggle fullscreen',        accelerator: 'F11',             action: 'local:toggle-fullscreen', editable: true },
  { id: 'settings',    label: 'Open settings',            accelerator: 'Ctrl+Alt+S',      action: 'local:open-settings', editable: true },
  { id: 'copy',        label: 'Copy (to remote)',         accelerator: 'Ctrl+C',          action: 'remote', editable: true },
  { id: 'paste',       label: 'Paste (to remote)',        accelerator: 'Ctrl+V',          action: 'remote', editable: true },
  { id: 'cut',         label: 'Cut (to remote)',          accelerator: 'Ctrl+X',          action: 'remote', editable: true },
];

export const DEFAULT_SETTINGS: Settings = {
  version: SCHEMA_VERSION,
  general: { launchToLastDevice: false, captureIndicator: true },
  hotkeys: DEFAULT_HOTKEYS,
};

function isDevice(v: unknown): v is Device {
  if (typeof v !== 'object' || v === null) return false;
  const d = v as Record<string, unknown>;
  return ['id', 'name', 'address', 'url'].every(k => typeof d[k] === 'string')
    && typeof d.createdAt === 'number';
}

export function validateDevices(raw: unknown): Device[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(isDevice) as Device[];
}

function isHotkey(v: unknown): v is HotkeyBinding {
  if (typeof v !== 'object' || v === null) return false;
  const h = v as Record<string, unknown>;
  return typeof h.id === 'string' && typeof h.accelerator === 'string'
    && typeof h.action === 'string' && typeof h.label === 'string';
}

export function validateSettings(raw: unknown): Settings {
  const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const overrides = Array.isArray(r.hotkeys) ? r.hotkeys.filter(isHotkey) as HotkeyBinding[] : [];
  const byId = new Map(overrides.map(h => [h.id, h]));
  const hotkeys = DEFAULT_HOTKEYS.map(def => byId.get(def.id) ?? def);
  const general = (typeof r.general === 'object' && r.general !== null ? r.general : {}) as Record<string, unknown>;
  return {
    version: typeof r.version === 'number' ? r.version : SCHEMA_VERSION,
    general: {
      launchToLastDevice: general.launchToLastDevice === true,
      captureIndicator: general.captureIndicator !== false,
    },
    hotkeys,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/shared/schema.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/shared/types.ts src/shared/schema.ts test/shared/schema.test.ts
git commit -m "feat: add types, default hotkeys, and schema validation"
```

---

## Task 4: Shared — keybinding resolution

**Files:**
- Create: `src/shared/keybindings.ts`
- Test: `test/shared/keybindings.test.ts`

**Interfaces:**
- Consumes: `HotkeyBinding`, `HotkeyAction` from `@shared/types`.
- Produces:
  - `interface KeyInput { key: string; control: boolean; alt: boolean; shift: boolean; meta: boolean; }` (a subset of Electron's `Input`).
  - `toAccelerator(input: KeyInput): string` — canonical form, modifier order `Ctrl+Alt+Shift+Meta+<Key>`, key names title-cased (`Escape`, `Right`, `F11`, single letters uppercased).
  - `resolveAction(input: KeyInput, bindings: HotkeyBinding[]): HotkeyAction` — matches the accelerator against bindings; **defaults to `'remote'`** when no binding matches (nothing is silently swallowed).

- [ ] **Step 1: Write the failing test**

`test/shared/keybindings.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { toAccelerator, resolveAction, type KeyInput } from '@shared/keybindings';
import { DEFAULT_HOTKEYS } from '@shared/schema';

const key = (p: Partial<KeyInput>): KeyInput =>
  ({ key: 'a', control: false, alt: false, shift: false, meta: false, ...p });

describe('toAccelerator', () => {
  it('orders modifiers and title-cases the key', () => {
    expect(toAccelerator(key({ key: 'c', control: true }))).toBe('Ctrl+C');
    expect(toAccelerator(key({ key: 'Escape', control: true, alt: true }))).toBe('Ctrl+Alt+Escape');
    expect(toAccelerator(key({ key: 'ArrowRight', control: true, alt: true }))).toBe('Ctrl+Alt+Right');
  });
});

describe('resolveAction', () => {
  it('resolves configured combos to their action', () => {
    expect(resolveAction(key({ key: 'c', control: true }), DEFAULT_HOTKEYS)).toBe('remote');
    expect(resolveAction(key({ key: 'Escape', control: true, alt: true }), DEFAULT_HOTKEYS)).toBe('release');
    expect(resolveAction(key({ key: 'd', control: true, alt: true }), DEFAULT_HOTKEYS)).toBe('local:back-to-dashboard');
  });
  it('defaults unmatched keys to remote (never swallowed)', () => {
    expect(resolveAction(key({ key: 'q', control: true }), DEFAULT_HOTKEYS)).toBe('remote');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/shared/keybindings.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

`src/shared/keybindings.ts`:
```ts
import type { HotkeyBinding, HotkeyAction } from './types';

export interface KeyInput { key: string; control: boolean; alt: boolean; shift: boolean; meta: boolean; }

const KEY_ALIASES: Record<string, string> = {
  ArrowRight: 'Right', ArrowLeft: 'Left', ArrowUp: 'Up', ArrowDown: 'Down',
  Esc: 'Escape', ' ': 'Space',
};

function canonicalKey(key: string): string {
  if (KEY_ALIASES[key]) return KEY_ALIASES[key];
  if (key.length === 1) return key.toUpperCase();
  return key.charAt(0).toUpperCase() + key.slice(1);
}

export function toAccelerator(input: KeyInput): string {
  const parts: string[] = [];
  if (input.control) parts.push('Ctrl');
  if (input.alt) parts.push('Alt');
  if (input.shift) parts.push('Shift');
  if (input.meta) parts.push('Meta');
  parts.push(canonicalKey(input.key));
  return parts.join('+');
}

export function resolveAction(input: KeyInput, bindings: HotkeyBinding[]): HotkeyAction {
  const accel = toAccelerator(input);
  const match = bindings.find(b => b.accelerator === accel);
  return match ? match.action : 'remote';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/shared/keybindings.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/shared/keybindings.ts test/shared/keybindings.test.ts
git commit -m "feat: add keybinding accelerator resolution"
```

---

## Task 5: Shared — cert trust decision

**Files:**
- Create: `src/shared/certs.ts`
- Test: `test/shared/certs.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type TrustStore = Record<string, string>` — host → trusted SHA-256 fingerprint.
  - `type CertDecision = 'allow' | 'prompt' | 'deny'`.
  - `decideCert(host: string, fingerprint: string, store: TrustStore, knownHosts: string[]): CertDecision`
    - host not in `knownHosts` → `'deny'` (only trust hosts that are saved devices).
    - host in `knownHosts`, no stored fingerprint → `'prompt'`.
    - stored fingerprint matches → `'allow'`.
    - stored fingerprint differs → `'prompt'` (re-approve changed cert).

- [ ] **Step 1: Write the failing test**

`test/shared/certs.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { decideCert, type TrustStore } from '@shared/certs';

const known = ['workmac.local'];

describe('decideCert', () => {
  it('denies hosts that are not saved devices', () => {
    expect(decideCert('evil.example', 'AA', {}, known)).toBe('deny');
  });
  it('prompts on first sight of a known host', () => {
    expect(decideCert('workmac.local', 'AA', {}, known)).toBe('prompt');
  });
  it('allows when the fingerprint matches the stored one', () => {
    const store: TrustStore = { 'workmac.local': 'AA' };
    expect(decideCert('workmac.local', 'AA', store, known)).toBe('allow');
  });
  it('re-prompts when the fingerprint changed', () => {
    const store: TrustStore = { 'workmac.local': 'AA' };
    expect(decideCert('workmac.local', 'BB', store, known)).toBe('prompt');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/shared/certs.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

`src/shared/certs.ts`:
```ts
export type TrustStore = Record<string, string>;
export type CertDecision = 'allow' | 'prompt' | 'deny';

export function decideCert(
  host: string,
  fingerprint: string,
  store: TrustStore,
  knownHosts: string[],
): CertDecision {
  if (!knownHosts.includes(host)) return 'deny';
  const trusted = store[host];
  if (!trusted) return 'prompt';
  return trusted === fingerprint ? 'allow' : 'prompt';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/shared/certs.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/shared/certs.ts test/shared/certs.test.ts
git commit -m "feat: add per-host certificate trust decision"
```

---

## Task 6: Shared — backup build/parse/merge

**Files:**
- Create: `src/shared/backup.ts`
- Test: `test/shared/backup.test.ts`

**Interfaces:**
- Consumes: `Device`, `Settings`, `BackupBundle` from `@shared/types`; `SCHEMA_VERSION`, `validateDevices`, `validateSettings` from `@shared/schema`.
- Produces:
  - `buildBackup(devices: Device[], settings: Settings): BackupBundle`
  - `parseBackup(json: string): BackupBundle` — throws `Error('Invalid backup file')` on malformed JSON or missing shape.
  - `mergeDevices(current: Device[], incoming: Device[]): Device[]` — dedupe by `id` then by `address`; incoming wins on conflict.
  - `applyBackup(current: { devices: Device[]; settings: Settings }, bundle: BackupBundle, mode: 'merge' | 'replace'): { devices: Device[]; settings: Settings }` — merge dedupes devices and replaces settings; replace overwrites both.

- [ ] **Step 1: Write the failing test**

`test/shared/backup.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { buildBackup, parseBackup, mergeDevices, applyBackup } from '@shared/backup';
import { DEFAULT_SETTINGS } from '@shared/schema';
import type { Device } from '@shared/types';

const dev = (id: string, address: string): Device =>
  ({ id, name: id, address, url: `https://${address}`, createdAt: 1 });

describe('backup round-trip', () => {
  it('parses what it builds', () => {
    const bundle = buildBackup([dev('a', 'a.local')], DEFAULT_SETTINGS);
    const parsed = parseBackup(JSON.stringify(bundle));
    expect(parsed.devices[0].id).toBe('a');
  });
  it('rejects malformed json', () => {
    expect(() => parseBackup('not json')).toThrow('Invalid backup file');
    expect(() => parseBackup('{}')).toThrow('Invalid backup file');
  });
});

describe('mergeDevices', () => {
  it('dedupes by id and by address', () => {
    const merged = mergeDevices([dev('a', 'a.local')], [dev('a', 'a.local'), dev('b', 'a.local'), dev('c', 'c.local')]);
    // 'a' (same id) replaced, 'b' collides on address with 'a', 'c' is new
    expect(merged.map(d => d.address).sort()).toEqual(['a.local', 'c.local']);
  });
});

describe('applyBackup', () => {
  it('merge keeps existing devices and replaces settings', () => {
    const current = { devices: [dev('a', 'a.local')], settings: DEFAULT_SETTINGS };
    const bundle = buildBackup([dev('b', 'b.local')], DEFAULT_SETTINGS);
    const out = applyBackup(current, bundle, 'merge');
    expect(out.devices).toHaveLength(2);
  });
  it('replace overwrites devices', () => {
    const current = { devices: [dev('a', 'a.local')], settings: DEFAULT_SETTINGS };
    const bundle = buildBackup([dev('b', 'b.local')], DEFAULT_SETTINGS);
    const out = applyBackup(current, bundle, 'replace');
    expect(out.devices).toHaveLength(1);
    expect(out.devices[0].id).toBe('b');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/shared/backup.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

`src/shared/backup.ts`:
```ts
import type { Device, Settings, BackupBundle } from './types';
import { SCHEMA_VERSION, validateDevices, validateSettings } from './schema';

export function buildBackup(devices: Device[], settings: Settings): BackupBundle {
  return { version: SCHEMA_VERSION, devices, settings };
}

export function parseBackup(json: string): BackupBundle {
  let raw: unknown;
  try { raw = JSON.parse(json); } catch { throw new Error('Invalid backup file'); }
  if (typeof raw !== 'object' || raw === null) throw new Error('Invalid backup file');
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.devices) || typeof r.settings !== 'object' || r.settings === null) {
    throw new Error('Invalid backup file');
  }
  return {
    version: typeof r.version === 'number' ? r.version : SCHEMA_VERSION,
    devices: validateDevices(r.devices),
    settings: validateSettings(r.settings),
  };
}

export function mergeDevices(current: Device[], incoming: Device[]): Device[] {
  const byId = new Map(current.map(d => [d.id, d]));
  for (const d of incoming) byId.set(d.id, d);
  // collapse address collisions, keeping the last writer
  const byAddress = new Map<string, Device>();
  for (const d of byId.values()) byAddress.set(d.address, d);
  return [...byAddress.values()];
}

export function applyBackup(
  current: { devices: Device[]; settings: Settings },
  bundle: BackupBundle,
  mode: 'merge' | 'replace',
): { devices: Device[]; settings: Settings } {
  if (mode === 'replace') return { devices: bundle.devices, settings: bundle.settings };
  return { devices: mergeDevices(current.devices, bundle.devices), settings: bundle.settings };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/shared/backup.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/shared/backup.ts test/shared/backup.test.ts
git commit -m "feat: add backup build/parse/merge logic"
```

---

## Task 7: Store service (atomic JSON persistence)

**Files:**
- Create: `src/main/services/store.ts`
- Test: `test/main/store.test.ts`

**Interfaces:**
- Consumes: `@shared/types`, `@shared/schema` (validate + defaults). Uses Node `fs`/`path` only — **no `electron` import**, so it is unit-testable with a tmp dir.
- Produces `createStore(baseDir: string)` returning:
  ```ts
  interface Store {
    getDevices(): Device[];
    addDevice(input: { name: string; address: string; color?: string }): Device;
    updateDevice(id: string, patch: Partial<Pick<Device, 'name' | 'address' | 'color'>>): Device | null;
    removeDevice(id: string): void;
    getSettings(): Settings;
    setSettings(next: Settings): void;
    getTrustStore(): TrustStore;
    trustCert(host: string, fingerprint: string): void;
    applyImport(bundle: BackupBundle, mode: 'merge' | 'replace'): void;
    exportBundle(): BackupBundle;
  }
  ```
  `addDevice` generates `id` (`crypto.randomUUID()`), sets `createdAt`, and derives `url` via `toDeviceUrl`. All mutations persist atomically. Corrupt files fall back to defaults and the bad file is preserved as `<name>.bak`.

- [ ] **Step 1: Write the failing test**

`test/main/store.test.ts`:
```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../../src/main/services/store';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'glkvm-')); });

describe('store', () => {
  it('adds a device with generated id/url and persists it', () => {
    const s = createStore(dir);
    const d = s.addDevice({ name: 'Work', address: 'https://workmac.local/' });
    expect(d.url).toBe('https://workmac.local');
    expect(d.id).toBeTruthy();
    const reloaded = createStore(dir);
    expect(reloaded.getDevices()).toHaveLength(1);
  });

  it('removes a device', () => {
    const s = createStore(dir);
    const d = s.addDevice({ name: 'Work', address: 'workmac.local' });
    s.removeDevice(d.id);
    expect(s.getDevices()).toHaveLength(0);
  });

  it('falls back to defaults and backs up a corrupt devices file', () => {
    writeFileSync(join(dir, 'devices.json'), '{ this is not valid');
    const s = createStore(dir);
    expect(s.getDevices()).toEqual([]);
    expect(existsSync(join(dir, 'devices.json.bak'))).toBe(true);
  });

  it('stores a trusted cert fingerprint', () => {
    const s = createStore(dir);
    s.trustCert('workmac.local', 'AA:BB');
    expect(createStore(dir).getTrustStore()['workmac.local']).toBe('AA:BB');
  });

  it('writes atomically (no leftover temp file)', () => {
    const s = createStore(dir);
    s.addDevice({ name: 'Work', address: 'workmac.local' });
    const leftovers = readFileSync(join(dir, 'devices.json'), 'utf8');
    expect(existsSync(join(dir, 'devices.json.tmp'))).toBe(false);
    expect(JSON.parse(leftovers)).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/main/store.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

`src/main/services/store.ts`:
```ts
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Device, Settings, BackupBundle } from '@shared/types';
import { DEFAULT_SETTINGS, validateDevices, validateSettings } from '@shared/schema';
import { toDeviceUrl, normalizeAddress } from '@shared/url';
import { applyBackup, buildBackup } from '@shared/backup';
import type { TrustStore } from '@shared/certs';

function readJson<T>(file: string, fallback: T, validate: (raw: unknown) => T): T {
  if (!existsSync(file)) return fallback;
  try {
    return validate(JSON.parse(readFileSync(file, 'utf8')));
  } catch {
    try { renameSync(file, `${file}.bak`); } catch { /* ignore */ }
    return fallback;
  }
}

function writeJsonAtomic(file: string, data: unknown): void {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  renameSync(tmp, file);
}

export function createStore(baseDir: string) {
  const devicesFile = join(baseDir, 'devices.json');
  const settingsFile = join(baseDir, 'settings.json');
  const certsFile = join(baseDir, 'trusted-certs.json');

  let devices = readJson<Device[]>(devicesFile, [], validateDevices);
  let settings = readJson<Settings>(settingsFile, DEFAULT_SETTINGS, validateSettings);
  let trust = readJson<TrustStore>(certsFile, {}, (r) => (typeof r === 'object' && r ? r as TrustStore : {}));

  const saveDevices = () => writeJsonAtomic(devicesFile, devices);
  const saveSettings = () => writeJsonAtomic(settingsFile, settings);
  const saveTrust = () => writeJsonAtomic(certsFile, trust);

  return {
    getDevices: () => devices,
    addDevice(input: { name: string; address: string; color?: string }): Device {
      const address = normalizeAddress(input.address);
      const d: Device = {
        id: randomUUID(), name: input.name, address, url: toDeviceUrl(address),
        color: input.color, createdAt: Date.now(),
      };
      devices = [...devices, d];
      saveDevices();
      return d;
    },
    updateDevice(id: string, patch: Partial<Pick<Device, 'name' | 'address' | 'color'>>): Device | null {
      const i = devices.findIndex(d => d.id === id);
      if (i === -1) return null;
      const address = patch.address ? normalizeAddress(patch.address) : devices[i].address;
      const updated: Device = { ...devices[i], ...patch, address, url: toDeviceUrl(address) };
      devices = devices.map(d => d.id === id ? updated : d);
      saveDevices();
      return updated;
    },
    removeDevice(id: string) { devices = devices.filter(d => d.id !== id); saveDevices(); },
    getSettings: () => settings,
    setSettings(next: Settings) { settings = validateSettings(next); saveSettings(); },
    getTrustStore: () => trust,
    trustCert(host: string, fingerprint: string) { trust = { ...trust, [host]: fingerprint }; saveTrust(); },
    applyImport(bundle: BackupBundle, mode: 'merge' | 'replace') {
      const out = applyBackup({ devices, settings }, bundle, mode);
      devices = out.devices; settings = out.settings;
      saveDevices(); saveSettings();
    },
    exportBundle: (): BackupBundle => buildBackup(devices, settings),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/main/store.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/main/services/store.ts test/main/store.test.ts
git commit -m "feat: add atomic JSON store service"
```

---

## Task 8: Preload bridge + IPC handlers

**Files:**
- Create: `src/preload/api.ts`, `src/preload/preload.ts`
- Create: `src/main/ipc.ts`
- Modify: `src/main/main.ts` (register IPC + build the store on ready), `src/main/window.ts` (export the window/store so IPC can reach views — see Task 9/10)
- Test: extend `test/smoke/app.test.ts` in Task 15 (IPC is exercised via smoke; the pure logic it calls is already unit-tested).

**Interfaces:**
- Consumes: the `Store` from Task 7, all `@shared` types.
- Produces: the renderer-facing API contract in `api.ts`:
  ```ts
  export interface GlkvmApi {
    listDevices(): Promise<Device[]>;
    addDevice(input: { name: string; address: string; color?: string }): Promise<Device>;
    updateDevice(id: string, patch: Partial<Pick<Device, 'name' | 'address' | 'color'>>): Promise<Device | null>;
    removeDevice(id: string): Promise<void>;
    getSettings(): Promise<Settings>;
    setSettings(next: Settings): Promise<void>;
    connect(id: string): Promise<void>;
    disconnect(): Promise<void>;
    exportBackup(): Promise<void>;   // opens save dialog in main
    importBackup(): Promise<void>;   // opens open dialog + merge/replace prompt in main
    onConnectionState(cb: (s: { deviceId: string | null; state: 'loading' | 'ready' | 'error'; message?: string }) => void): void;
    onNavigate(cb: (view: 'dashboard' | 'device' | 'settings') => void): void;
  }
  declare global { interface Window { glkvm: GlkvmApi; } }
  ```
  Channel names are namespaced `devices:*`, `settings:*`, `conn:*`, `backup:*`, `nav:*`.

- [ ] **Step 1: Write the IPC + preload implementation (wiring, verified by typecheck + smoke)**

> This task has no isolated unit test (it is Electron glue over already-tested logic). Its gate is `npm run typecheck` passing and the Task 15 smoke test. Write the code, then typecheck.

`src/preload/api.ts` — exactly the `GlkvmApi` interface block above (import `Device`, `Settings` from `@shared/types`).

`src/preload/preload.ts`:
```ts
import { contextBridge, ipcRenderer } from 'electron';
import type { GlkvmApi } from './api';

const api: GlkvmApi = {
  listDevices: () => ipcRenderer.invoke('devices:list'),
  addDevice: (input) => ipcRenderer.invoke('devices:add', input),
  updateDevice: (id, patch) => ipcRenderer.invoke('devices:update', id, patch),
  removeDevice: (id) => ipcRenderer.invoke('devices:remove', id),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (next) => ipcRenderer.invoke('settings:set', next),
  connect: (id) => ipcRenderer.invoke('conn:connect', id),
  disconnect: () => ipcRenderer.invoke('conn:disconnect'),
  exportBackup: () => ipcRenderer.invoke('backup:export'),
  importBackup: () => ipcRenderer.invoke('backup:import'),
  onConnectionState: (cb) => { ipcRenderer.on('conn:state', (_e, s) => cb(s)); },
  onNavigate: (cb) => { ipcRenderer.on('nav:view', (_e, v) => cb(v)); },
};
contextBridge.exposeInMainWorld('glkvm', api);
```

`src/main/ipc.ts`:
```ts
import { ipcMain, dialog, BrowserWindow } from 'electron';
import { writeFileSync, readFileSync } from 'node:fs';
import type { createStore } from './services/store';
import type { ConnectionManager } from './services/connections';
import { parseBackup } from '@shared/backup';

type Store = ReturnType<typeof createStore>;

export function registerIpc(store: Store, connections: ConnectionManager): void {
  ipcMain.handle('devices:list', () => store.getDevices());
  ipcMain.handle('devices:add', (_e, input) => store.addDevice(input));
  ipcMain.handle('devices:update', (_e, id, patch) => store.updateDevice(id, patch));
  ipcMain.handle('devices:remove', (_e, id) => store.removeDevice(id));
  ipcMain.handle('settings:get', () => store.getSettings());
  ipcMain.handle('settings:set', (_e, next) => store.setSettings(next));
  ipcMain.handle('conn:connect', (_e, id) => connections.connect(id));
  ipcMain.handle('conn:disconnect', () => connections.disconnect());

  ipcMain.handle('backup:export', async () => {
    const { canceled, filePath } = await dialog.showSaveDialog({
      defaultPath: `glkvm-backup-${new Date().toISOString().slice(0, 10)}.json`,
    });
    if (canceled || !filePath) return;
    writeFileSync(filePath, JSON.stringify(store.exportBundle(), null, 2), 'utf8');
  });

  ipcMain.handle('backup:import', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog({ properties: ['openFile'] });
    if (canceled || !filePaths[0]) return;
    let bundle;
    try { bundle = parseBackup(readFileSync(filePaths[0], 'utf8')); }
    catch { await dialog.showMessageBox({ type: 'error', message: 'Invalid backup file' }); return; }
    const { response } = await dialog.showMessageBox({
      type: 'question', buttons: ['Merge', 'Replace', 'Cancel'], defaultId: 0, cancelId: 2,
      message: 'Import devices & settings', detail: 'Merge with current, or replace everything?',
    });
    if (response === 2) return;
    store.applyImport(bundle, response === 1 ? 'replace' : 'merge');
    BrowserWindow.getAllWindows(); // views notified via connections/dashboard refresh
  });
}
```

- [ ] **Step 2: Run the typecheck to verify wiring compiles**

Run: `npm run typecheck`
Expected: PASS (no type errors). `ConnectionManager` is defined in Task 10; until then, stub its type in `src/main/services/connections.ts` with `export interface ConnectionManager { connect(id: string): Promise<void>; disconnect(): Promise<void>; }` so this task compiles independently.

- [ ] **Step 3: Commit**

```bash
git add src/preload src/main/ipc.ts src/main/services/connections.ts
git commit -m "feat: add preload bridge and ipc handlers"
```

---

## Task 9: Renderer — dashboard tile grid + add/edit dialog

**Files:**
- Create: `src/renderer/dashboard.ts`, `src/renderer/deviceDialog.ts`
- Modify: `src/renderer/main.ts`, `src/renderer/index.html`, `src/renderer/styles.css`

**Interfaces:**
- Consumes: `window.glkvm` (`GlkvmApi`).
- Produces: `renderDashboard(root: HTMLElement): Promise<void>` and `openDeviceDialog(opts: { device?: Device; onSave: (input) => Promise<void> }): void`. Clicking a tile calls `window.glkvm.connect(device.id)`.

- [ ] **Step 1: Write the dashboard render (verified via smoke test in Task 15)**

> Renderer DOM code is gated by the Task 15 Playwright smoke test ("add a device → tile appears"). Build it now.

`src/renderer/dashboard.ts`:
```ts
import type { Device } from '@shared/types';
import { openDeviceDialog } from './deviceDialog';

export async function renderDashboard(root: HTMLElement): Promise<void> {
  const devices = await window.glkvm.listDevices();
  root.innerHTML = `
    <header class="topbar">
      <h1>GLKVM</h1>
      <div><button id="settings-btn">Settings</button><button id="add-btn">+ Add device</button></div>
    </header>
    <main class="grid" id="grid"></main>`;
  const grid = root.querySelector('#grid') as HTMLElement;
  if (devices.length === 0) {
    grid.innerHTML = `<p class="empty">No devices yet. Click “Add device”.</p>`;
  }
  for (const d of devices) {
    const tile = document.createElement('button');
    tile.className = 'tile';
    tile.dataset.id = d.id;
    tile.style.setProperty('--tile', d.color ?? '#1f6feb');
    tile.innerHTML = `<span class="dot"></span><span class="name">${escapeHtml(d.name)}</span><span class="addr">${escapeHtml(d.address)}</span>`;
    tile.addEventListener('click', () => window.glkvm.connect(d.id));
    tile.addEventListener('contextmenu', (e) => { e.preventDefault(); editDevice(root, d); });
    grid.appendChild(tile);
  }
  (root.querySelector('#add-btn') as HTMLElement).onclick = () =>
    openDeviceDialog({ onSave: async (input) => { await window.glkvm.addDevice(input); await renderDashboard(root); } });
  (root.querySelector('#settings-btn') as HTMLElement).onclick = () =>
    window.dispatchEvent(new CustomEvent('open-settings'));
}

function editDevice(root: HTMLElement, d: Device) {
  openDeviceDialog({ device: d, onSave: async (input) => { await window.glkvm.updateDevice(d.id, input); await renderDashboard(root); } });
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}
```

`src/renderer/deviceDialog.ts`:
```ts
import type { Device } from '@shared/types';

interface DialogOpts { device?: Device; onSave: (input: { name: string; address: string; color?: string }) => Promise<void>; }

export function openDeviceDialog(opts: DialogOpts): void {
  const dlg = document.createElement('dialog');
  dlg.className = 'device-dialog';
  dlg.innerHTML = `
    <form method="dialog">
      <h2>${opts.device ? 'Edit device' : 'Add device'}</h2>
      <label>Name<input name="name" required value="${opts.device?.name ?? ''}"></label>
      <label>Address<input name="address" required placeholder="workmac.local" value="${opts.device?.address ?? ''}"></label>
      <label>Color<input name="color" type="color" value="${opts.device?.color ?? '#1f6feb'}"></label>
      <menu><button value="cancel">Cancel</button><button id="save" value="save">Save</button></menu>
    </form>`;
  document.body.appendChild(dlg);
  dlg.showModal();
  dlg.addEventListener('close', async () => {
    if (dlg.returnValue === 'save') {
      const f = dlg.querySelector('form') as HTMLFormElement;
      const data = new FormData(f);
      await opts.onSave({ name: String(data.get('name')), address: String(data.get('address')), color: String(data.get('color')) });
    }
    dlg.remove();
  });
}
```

`src/renderer/main.ts`:
```ts
import { renderDashboard } from './dashboard';
import { openSettings } from './settingsPanel';

const root = document.querySelector('#app') as HTMLElement;
renderDashboard(root);
window.addEventListener('open-settings', () => openSettings(root, () => renderDashboard(root)));
window.glkvm.onNavigate((view) => { if (view === 'dashboard') renderDashboard(root); });
```

Add tile/topbar/grid styles to `styles.css` (grid: `display:grid; grid-template-columns:repeat(auto-fill,minmax(180px,1fr)); gap:16px; padding:24px`; `.tile` a rounded card using `--tile` for its accent; `.dot` a small status circle).

- [ ] **Step 2: Verify it builds and renders**

Run: `npm run typecheck && npm run dev`
Expected: typecheck PASS; dev window shows the empty-state dashboard with an “Add device” button. (Settings import comes from Task 11 — add a temporary `export function openSettings(){}` stub in `settingsPanel.ts` if building this task before Task 11.)

- [ ] **Step 3: Commit**

```bash
git add src/renderer
git commit -m "feat: add dashboard tile grid and device dialog"
```

---

## Task 10: Connection manager — WebContentsView, sessions, keyboard, certs

**Files:**
- Create: `src/main/services/connections.ts`, `src/main/services/keyboard.ts`, `src/main/services/certs.ts`
- Modify: `src/main/window.ts` (expose the `BaseWindow` + dashboard view so the manager can add/remove device views), `src/main/main.ts` (construct manager, wire cert handler)

**Interfaces:**
- Consumes: `createStore` (Task 7), `resolveAction` + `KeyInput` (Task 4), `decideCert` (Task 5), `@shared/url`.
- Produces:
  ```ts
  export interface ConnectionManager {
    connect(id: string): Promise<void>;
    disconnect(): Promise<void>;
    activeDeviceId(): string | null;
  }
  export function createConnectionManager(deps: {
    window: BaseWindow; dashboard: WebContentsView; store: Store;
    onState: (s: { deviceId: string | null; state: 'loading' | 'ready' | 'error'; message?: string }) => void;
  }): ConnectionManager;
  export function installCertHandler(store: Store, promptTrust: (host: string, fingerprint: string) => Promise<boolean>): void;
  ```
- `connect` mounts a `WebContentsView` for the device on `session.fromPartition('persist:device-<id>')`, attaches the keyboard handler, brings it to front, and reports `loading`→`ready`/`error` via `onState`. A per-connect watchdog (10s) with no `did-finish-load` reports `error`.

- [ ] **Step 1: Write the keyboard adapter (thin, over tested logic)**

`src/main/services/keyboard.ts`:
```ts
import type { WebContents, Input } from 'electron';
import { resolveAction, type KeyInput } from '@shared/keybindings';
import type { Settings } from '@shared/types';

export type AppActionHandler = (action: string) => void;

export function attachKeyboard(wc: WebContents, getSettings: () => Settings, onAppAction: AppActionHandler): void {
  wc.on('before-input-event', (event, input: Input) => {
    if (input.type !== 'keyDown') return;
    const ki: KeyInput = {
      key: input.key, control: input.control, alt: input.alt, shift: input.shift, meta: input.meta,
    };
    const action = resolveAction(ki, getSettings().hotkeys);
    if (action === 'remote') return;               // let it reach the KVM page
    event.preventDefault();                          // stop Chromium + the page
    if (action === 'release') { onAppAction('release'); return; }
    onAppAction(action.slice('local:'.length));      // e.g. 'back-to-dashboard'
  });
}
```

- [ ] **Step 2: Write the cert handler + connection manager**

`src/main/services/certs.ts`:
```ts
import { app } from 'electron';
import { decideCert } from '@shared/certs';
import type { createStore } from './store';
type Store = ReturnType<typeof createStore>;

export function installCertHandler(store: Store, promptTrust: (host: string, fingerprint: string) => Promise<boolean>): void {
  app.on('certificate-error', (event, _wc, url, _error, certificate, callback) => {
    const host = new URL(url).host;
    const knownHosts = store.getDevices().map(d => d.address);
    const decision = decideCert(host, certificate.fingerprint, store.getTrustStore(), knownHosts);
    if (decision === 'allow') { event.preventDefault(); callback(true); return; }
    if (decision === 'deny') { callback(false); return; }
    // prompt
    event.preventDefault();
    promptTrust(host, certificate.fingerprint).then((trusted) => {
      if (trusted) store.trustCert(host, certificate.fingerprint);
      callback(trusted);
    });
  });
}
```

`src/main/services/connections.ts`:
```ts
import { BaseWindow, WebContentsView, session } from 'electron';
import { join } from 'node:path';
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
```

Update `src/main/window.ts` to return `{ window, dashboard }`, and `src/main/main.ts` to: create the store, build the connection manager with an `onState` that pushes `conn:state` to the dashboard `webContents`, install the cert handler with a `promptTrust` that shows a modal dialog (buttons Trust/Cancel, showing the fingerprint), and call `registerIpc(store, connections)`.

- [ ] **Step 3: Verify build + typecheck**

Run: `npm run typecheck`
Expected: PASS. Manual: `npm run dev`, add a device pointing at a reachable https host, click the tile → view loads; the unreachable case is covered by Task 12's overlay + Task 15 smoke.

- [ ] **Step 4: Commit**

```bash
git add src/main
git commit -m "feat: add connection manager with per-device views, sessions, keyboard, certs"
```

---

## Task 11: Settings panel + import/export UI

**Files:**
- Create: `src/renderer/settingsPanel.ts`
- Modify: `src/renderer/styles.css`

**Interfaces:**
- Consumes: `window.glkvm` (`getSettings`, `setSettings`, `exportBackup`, `importBackup`).
- Produces: `openSettings(root: HTMLElement, onClose: () => void): void`. Renders the hotkey list (each row: label + editable accelerator capture + action selector), plus Export/Import buttons. Saving calls `setSettings`.

- [ ] **Step 1: Write the settings panel (gated by typecheck + manual)**

`src/renderer/settingsPanel.ts`:
```ts
import type { Settings, HotkeyBinding } from '@shared/types';

export async function openSettings(root: HTMLElement, onClose: () => void): Promise<void> {
  const settings = await window.glkvm.getSettings();
  const dlg = document.createElement('dialog');
  dlg.className = 'settings-panel';
  dlg.innerHTML = `
    <header><h2>Settings</h2><button id="close">Done</button></header>
    <section class="io"><button id="export">Export backup…</button><button id="import">Import backup…</button></section>
    <h3>Hotkeys</h3>
    <ul id="hotkeys"></ul>`;
  document.body.appendChild(dlg);
  dlg.showModal();

  const list = dlg.querySelector('#hotkeys') as HTMLElement;
  const draft: Settings = structuredClone(settings);
  for (const hk of draft.hotkeys) list.appendChild(renderRow(hk, draft));

  (dlg.querySelector('#export') as HTMLElement).onclick = () => window.glkvm.exportBackup();
  (dlg.querySelector('#import') as HTMLElement).onclick = async () => { await window.glkvm.importBackup(); dlg.close(); };
  (dlg.querySelector('#close') as HTMLElement).onclick = async () => {
    await window.glkvm.setSettings(draft);
    dlg.close();
  };
  dlg.addEventListener('close', () => { dlg.remove(); onClose(); });
}

function renderRow(hk: HotkeyBinding, draft: Settings): HTMLElement {
  const li = document.createElement('li');
  li.className = 'hotkey-row';
  li.innerHTML = `<span class="label">${hk.label}</span>
    <kbd class="accel" tabindex="0">${hk.accelerator}</kbd>`;
  const kbd = li.querySelector('.accel') as HTMLElement;
  kbd.addEventListener('keydown', (e) => {
    e.preventDefault();
    const accel = captureAccelerator(e);
    if (!accel) return;
    hk.accelerator = accel;                 // mutate draft in place
    kbd.textContent = accel;
    draft.hotkeys = draft.hotkeys.map(h => h.id === hk.id ? hk : h);
  });
  return li;
}

function captureAccelerator(e: KeyboardEvent): string | null {
  const parts: string[] = [];
  if (e.ctrlKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  if (e.metaKey) parts.push('Meta');
  const k = e.key;
  if (['Control', 'Alt', 'Shift', 'Meta'].includes(k)) return null; // modifier-only, wait for real key
  const alias: Record<string, string> = { ArrowRight: 'Right', ArrowLeft: 'Left', ArrowUp: 'Up', ArrowDown: 'Down' };
  parts.push(alias[k] ?? (k.length === 1 ? k.toUpperCase() : k));
  return parts.join('+');
}
```

- [ ] **Step 2: Verify build**

Run: `npm run typecheck && npm run dev`
Expected: typecheck PASS; Settings opens, hotkey rows render, focusing an accelerator and pressing a combo updates it, Export/Import buttons invoke native dialogs.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/settingsPanel.ts src/renderer/styles.css
git commit -m "feat: add settings panel with hotkey editor and import/export"
```

---

## Task 12: Connection error/loading overlay + logging

**Files:**
- Create: `src/renderer/overlay.ts`, `src/main/services/logger.ts`
- Modify: `src/renderer/main.ts` (subscribe to `onConnectionState`), `src/main/main.ts` (init logger, route errors)

**Interfaces:**
- Consumes: `window.glkvm.onConnectionState`.
- Produces:
  - `showOverlay(root, opts: { state: 'loading' | 'error'; message?: string; onRetry: () => void; onBack: () => void }): void` and `hideOverlay(root): void`.
  - `createLogger(logDir: string)` → `{ info(msg): void; error(msg, err?): void }` writing to a size-capped `app.log` (rotate to `app.log.1` past ~1 MB).

- [ ] **Step 1: Write a unit test for log rotation**

`test/main/logger.test.ts`:
```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger } from '../../src/main/services/logger';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'glkvm-log-')); });

describe('logger', () => {
  it('writes and rotates past the size cap', () => {
    const log = createLogger(dir, 1024); // tiny cap for the test
    for (let i = 0; i < 200; i++) log.info('x'.repeat(50));
    expect(existsSync(join(dir, 'app.log'))).toBe(true);
    expect(existsSync(join(dir, 'app.log.1'))).toBe(true);
    expect(statSync(join(dir, 'app.log')).size).toBeLessThan(2048);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/main/logger.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the logger and overlay**

`src/main/services/logger.ts`:
```ts
import { appendFileSync, existsSync, statSync, renameSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export function createLogger(logDir: string, maxBytes = 1_000_000) {
  mkdirSync(logDir, { recursive: true });
  const file = join(logDir, 'app.log');
  const write = (level: string, msg: string) => {
    if (existsSync(file) && statSync(file).size > maxBytes) renameSync(file, `${file}.1`);
    appendFileSync(file, `${new Date().toISOString()} [${level}] ${msg}\n`);
  };
  return {
    info: (msg: string) => write('INFO', msg),
    error: (msg: string, err?: unknown) => write('ERROR', err ? `${msg}: ${String(err)}` : msg),
  };
}
```

`src/renderer/overlay.ts`:
```ts
interface OverlayOpts { state: 'loading' | 'error'; message?: string; onRetry: () => void; onBack: () => void; }

export function showOverlay(root: HTMLElement, opts: OverlayOpts): void {
  hideOverlay(root);
  const el = document.createElement('div');
  el.id = 'conn-overlay';
  el.className = `overlay ${opts.state}`;
  el.innerHTML = opts.state === 'loading'
    ? `<div class="spinner"></div><p>Connecting…</p>`
    : `<p class="err">Can’t reach device</p><p class="detail">${opts.message ?? ''}</p>
       <menu><button id="retry">Retry</button><button id="back">Back to dashboard</button></menu>`;
  root.appendChild(el);
  el.querySelector('#retry')?.addEventListener('click', opts.onRetry);
  el.querySelector('#back')?.addEventListener('click', opts.onBack);
}

export function hideOverlay(root: HTMLElement): void {
  root.querySelector('#conn-overlay')?.remove();
}
```

Wire in `src/renderer/main.ts`:
```ts
import { showOverlay, hideOverlay } from './overlay';
// after renderDashboard(root):
let lastDeviceId: string | null = null;
window.glkvm.onConnectionState((s) => {
  lastDeviceId = s.deviceId;
  if (s.state === 'loading') showOverlay(root, { state: 'loading', onRetry: () => {}, onBack: () => window.glkvm.disconnect() });
  else if (s.state === 'error') showOverlay(root, {
    state: 'error', message: s.message,
    onRetry: () => lastDeviceId && window.glkvm.connect(lastDeviceId),
    onBack: () => window.glkvm.disconnect(),
  });
  else hideOverlay(root);
});
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/main/logger.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/overlay.ts src/main/services/logger.ts src/renderer/main.ts src/main/main.ts
git commit -m "feat: add connection overlay and rotating logger"
```

---

## Task 13: Auto-updater service

**Files:**
- Create: `src/main/services/updater.ts`
- Modify: `src/main/main.ts` (call `initUpdater` after window creation)

**Interfaces:**
- Consumes: `electron-updater`, the logger from Task 12.
- Produces: `initUpdater(log: { info(m: string): void; error(m: string, e?: unknown): void }): void` — checks for updates on launch, downloads in background, notifies via a dialog offering “Restart now”. All failures are caught and logged (non-fatal). Skips entirely when `!app.isPackaged`.

- [ ] **Step 1: Write the updater wiring (gated by typecheck; update path is manual-tested per spec)**

`src/main/services/updater.ts`:
```ts
import { app, dialog } from 'electron';
import electronUpdater from 'electron-updater';
const { autoUpdater } = electronUpdater;

export function initUpdater(log: { info(m: string): void; error(m: string, e?: unknown): void }): void {
  if (!app.isPackaged) { log.info('updater: skipped (dev)'); return; }
  autoUpdater.autoDownload = true;
  autoUpdater.on('error', (e) => log.error('updater error', e));
  autoUpdater.on('update-available', (i) => log.info(`update available: ${i.version}`));
  autoUpdater.on('update-downloaded', async (i) => {
    log.info(`update downloaded: ${i.version}`);
    const { response } = await dialog.showMessageBox({
      type: 'info', buttons: ['Restart now', 'Later'], defaultId: 0,
      message: 'Update ready', detail: `GLKVM ${i.version} is ready to install.`,
    });
    if (response === 0) autoUpdater.quitAndInstall();
  });
  autoUpdater.checkForUpdates().catch((e) => log.error('updater check failed', e));
}
```

- [ ] **Step 2: Verify typecheck**

Run: `npm run typecheck`
Expected: PASS. (Real update download is on the manual checklist — it needs a published release.)

- [ ] **Step 3: Commit**

```bash
git add src/main/services/updater.ts src/main/main.ts
git commit -m "feat: add electron-updater auto-update wiring"
```

---

## Task 14: Packaging — electron-builder + AppImage config

**Files:**
- Modify: `package.json` (add the `build` config block)
- Create: `electron-builder.yml` (or inline under `package.json > build`; use the file for clarity)

**Interfaces:**
- Consumes: `build/icon.png` (exists), the `out/` build output from `electron-vite build`.
- Produces: `npm run dist` yielding an AppImage in `dist/`, plus `latest-linux.yml` for the updater feed.

- [ ] **Step 1: Write the electron-builder config**

`electron-builder.yml`:
```yaml
appId: com.darkharasho.glkvm-linux-wrapper
productName: GLKVM
directories:
  output: dist
  buildResources: build
files:
  - out/**/*
  - package.json
linux:
  target: [AppImage]
  category: Utility
  icon: build/icon.png
  maintainer: darkharasho
publish:
  provider: github
  owner: darkharasho
  repo: glkvm-linux-wrapper
```

Ensure `package.json` has `"build": { "extends": null }` removed if present and that `main` points to `out/main/main.js`.

- [ ] **Step 2: Build the AppImage**

Run: `npm run dist`
Expected: `dist/GLKVM-0.1.0.AppImage` and `dist/latest-linux.yml` are produced. Verify: `chmod +x dist/GLKVM-*.AppImage && ./dist/GLKVM-*.AppImage` launches the app to the dashboard.

- [ ] **Step 3: Commit**

```bash
git add electron-builder.yml package.json
git commit -m "build: add electron-builder AppImage packaging"
```

---

## Task 15: Electron smoke tests (Playwright)

**Files:**
- Create: `test/smoke/app.test.ts`
- Modify: `vitest.config.ts` (a second project/config so smoke runs separately from unit), `package.json` (`test:smoke` script)

**Interfaces:**
- Consumes: the built app (`electron-vite build` output) and `playwright`'s `_electron`.
- Produces: a `test:smoke` script and a smoke suite covering boot → add device → tile appears → unreachable connect shows the error overlay.

- [ ] **Step 1: Write the smoke test**

`test/smoke/app.test.ts`:
```ts
import { test, expect, _electron as electron } from 'playwright/test';

test('boots to dashboard, adds a device, shows a tile', async () => {
  const app = await electron.launch({ args: ['out/main/main.js'] });
  const win = await app.firstWindow();
  await expect(win.locator('h1')).toHaveText('GLKVM');
  await win.click('#add-btn');
  await win.fill('input[name="name"]', 'Test');
  await win.fill('input[name="address"]', 'unreachable.invalid');
  await win.click('#save');
  await expect(win.locator('.tile .name')).toHaveText('Test');
  await win.click('.tile');
  await expect(win.locator('#conn-overlay')).toBeVisible({ timeout: 15000 });
  await app.close();
});
```

Add to `package.json` scripts: `"test:smoke": "electron-vite build && playwright test test/smoke"` and a minimal `playwright.config.ts` (`testDir: 'test/smoke'`).

- [ ] **Step 2: Run the smoke test to verify it passes**

Run: `npm run test:smoke`
Expected: PASS — window boots, tile appears, overlay shows for the unreachable host.

- [ ] **Step 3: Commit**

```bash
git add test/smoke playwright.config.ts package.json
git commit -m "test: add electron smoke tests"
```

---

## Task 16: GitHub Actions — CI + Release

**Files:**
- Create: `.github/workflows/ci.yml`, `.github/workflows/release.yml`

**Interfaces:**
- Consumes: npm scripts (`lint`, `typecheck`, `test`, `dist`).
- Produces: green CI on push/PR, and an AppImage published to a GitHub Release when a `v*` tag is pushed.

- [ ] **Step 1: Write the CI workflow**

`.github/workflows/ci.yml`:
```yaml
name: CI
on:
  push: { branches: [main] }
  pull_request:
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: npm }
      - run: npm ci
      - run: npm run lint
      - run: npm run typecheck
      - run: npm test
```

- [ ] **Step 2: Write the release workflow**

`.github/workflows/release.yml`:
```yaml
name: Release
on:
  push:
    tags: ['v*']
permissions:
  contents: write
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: npm }
      - run: npm ci
      - run: npm run dist
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

(`electron-builder` auto-publishes to the Release matching the tag because `publish.provider: github` is set and `GH_TOKEN` is present.)

- [ ] **Step 3: Commit**

```bash
git add .github/workflows
git commit -m "ci: add CI and release workflows"
```

---

## Task 17: Repo creation, README, LICENSE

**Files:**
- Create: `LICENSE` (MIT), expand `README.md`
- Action: create the public GitHub repo and push.

**Interfaces:**
- Consumes: everything above.
- Produces: a public repo `darkharasho/glkvm-linux-wrapper` with all history pushed and CI running.

- [ ] **Step 1: Add LICENSE and expand README**

`LICENSE`: standard MIT text, `Copyright (c) 2026 darkharasho`.

`README.md` add sections: what it is, install (Download the AppImage from Releases, `chmod +x GLKVM-*.AppImage`, run), first-run (add a device with its `.local` address, click to connect, trust the cert prompt once), keyboard capture + release hotkey, import/export, and a **Development** section (`npm install`, `npm run dev`, `npm test`, `npm run dist`).

- [ ] **Step 2: Commit**

```bash
git add LICENSE README.md
git commit -m "docs: add MIT license and README"
```

- [ ] **Step 3: Create the public repo and push (CONFIRM NAME/OWNER FIRST)**

> **Outward-facing, hard-to-undo. Confirm `darkharasho/glkvm-linux-wrapper` (public) with the user before running.**

```bash
gh repo create darkharasho/glkvm-linux-wrapper --public --source=. --remote=origin --push
```

Expected: repo exists publicly, `main` pushed, CI workflow runs green.

- [ ] **Step 4: Verify CI + tag a first release (optional)**

Run: watch the Actions run; optionally `git tag v0.1.0 && git push origin v0.1.0` to produce the first AppImage release, then confirm the AppImage attaches to the GitHub Release and `latest-linux.yml` is present.

---

## Self-Review

**Spec coverage:**
- Architecture / process model → Task 1 (scaffold), Task 8 (preload/IPC), Task 10 (main services). ✓
- Keybinding engine (full capture, per-hotkey, release) → Task 4 (logic) + Task 10 (`before-input-event` adapter) + Task 11 (editor). ✓
- Storage + import/export → Task 3 (schema), Task 6 (backup logic), Task 7 (store), Task 8 (dialogs). ✓
- Cert trust (per-host fingerprint) → Task 5 (logic) + Task 10 (`certificate-error` handler + prompt). ✓
- Persistent per-device sessions → Task 10 (`persist:device-<id>` partitions). ✓
- Error handling (overlay, watchdog, corrupt-file fallback, logging) → Task 7 (fallback), Task 10 (watchdog/did-fail-load), Task 12 (overlay + logger). ✓
- Testing (pure unit + Electron smoke, `--maxWorkers=2`) → Tasks 2–7, 12 (unit) + Task 15 (smoke); constraint in header + Task 1 script. ✓
- Packaging / CI / auto-update (AppImage, GitHub Releases, electron-updater) → Task 13 (updater), Task 14 (builder), Task 16 (workflows). ✓
- Public repo + MIT + README → Task 17. ✓

**Placeholder scan:** No "TBD"/"add error handling"-style gaps; each code step carries real code. The only intentionally deferred action is repo creation (Task 17 Step 3), explicitly gated on user confirmation. UI-heavy tasks (9, 11) are gated by typecheck + the Task 15 smoke test rather than isolated unit tests, which is called out in-task.

**Type consistency:** `Device`, `Settings`, `HotkeyBinding`, `HotkeyAction`, `BackupBundle` are defined once in Task 3 and reused verbatim. `createStore` return type (Task 7) is consumed as `Store` in Tasks 8/10. `ConnectionManager` interface is declared in Task 8's stub and fulfilled in Task 10. `KeyInput` is defined in Task 4 and consumed in Task 10's keyboard adapter. `resolveAction` / `decideCert` / `parseBackup` / `applyBackup` signatures match across producer and consumer tasks.

---

## Deferred / follow-ups (post-v1, from the spec)

- Optional saved password + keyring-backed autofill.
- `.deb` / Flatpak targets.
- Live reachability status on tiles.
- `next-device` / `prev-device` / `toggle-fullscreen` / `open-settings` app actions are wired in the keyboard handler stub (Task 10); full behavior can be fleshed out alongside multi-device UX polish.
