# Secure Password Storage & Autofill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Store a per-device GLKVM web-login password encrypted at rest, and auto-fill + auto-submit it when a device's login page is detected, with a safety valve that never resubmits a failed password.

**Architecture:** A main-process `SecretsStore` (Electron `safeStorage`, injected for testability) persists ciphertext to `secrets.json`. A main-process `autofill` module holds self-contained DOM functions (serialized via `Function.prototype.toString()` and injected into each device's `WebContentsView`) plus a pure orchestration function with injected timing/JS-eval deps. The connection manager calls the orchestrator on `did-finish-load`. Plaintext never reaches the renderer, disk (unencrypted), backups, or logs.

**Tech Stack:** Electron 32, TypeScript (strict), electron-vite, vitest (`--maxWorkers=2`), jsdom (new dev dep, for DOM unit tests), Playwright (smoke).

## Global Constraints

- Test runner: always `vitest run --maxWorkers=2` (existing `package.json` script already sets this — use `npm test`).
- Plaintext passwords: NEVER written to `devices.json`, the backup bundle, the renderer, or logs. Only ciphertext on disk; plaintext only transiently in the main process.
- If `safeStorage.isEncryptionAvailable()` is false, saving is refused — NEVER fall back to plaintext.
- Path alias: `@shared` → `src/shared` (configured in `vitest.config.ts` and `electron.vite.config.ts`).
- New unit tests live under `test/main/` (vitest `include` covers `test/main/**` and `test/shared/**` only).
- Follow the existing atomic-write pattern from `src/main/services/store.ts` (`tmp` file + `renameSync`).
- The GLKVM login form is password-only: one visible `input[type="password"]` + a submit/sign-in button. No username.

---

### Task 1: Secrets store (`secrets.ts`)

**Files:**
- Create: `src/main/services/secrets.ts`
- Test: `test/main/secrets.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces:
  - `interface SafeStorageLike { isEncryptionAvailable(): boolean; encryptString(plain: string): Buffer; decryptString(cipher: Buffer): string; }`
  - `interface SecretsStore { isAvailable(): boolean; set(deviceId: string, password: string): boolean; get(deviceId: string): string | null; has(deviceId: string): boolean; clear(deviceId: string): void; }`
  - `function createSecretsStore(baseDir: string, safe: SafeStorageLike): SecretsStore`
  - `set` returns `false` (and writes nothing) when encryption is unavailable; `true` on success.
  - `get` returns `null` when there is no entry OR decryption throws.

- [ ] **Step 1: Write the failing test**

Create `test/main/secrets.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSecretsStore, type SafeStorageLike } from '../../src/main/services/secrets';

// Fake safeStorage: "encrypts" by prefixing a tag so we can assert ciphertext != plaintext.
function fakeSafe(available = true): SafeStorageLike {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (p) => Buffer.from('ENC:' + p, 'utf8'),
    decryptString: (c) => {
      const s = c.toString('utf8');
      if (!s.startsWith('ENC:')) throw new Error('bad cipher');
      return s.slice(4);
    },
  };
}

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'glkvm-sec-')); });

describe('secrets store', () => {
  it('round-trips a password across reloads and stores only ciphertext', () => {
    const s = createSecretsStore(dir, fakeSafe());
    expect(s.set('dev1', 'hunter2')).toBe(true);
    expect(s.has('dev1')).toBe(true);
    expect(createSecretsStore(dir, fakeSafe()).get('dev1')).toBe('hunter2');
    const onDisk = readFileSync(join(dir, 'secrets.json'), 'utf8');
    expect(onDisk).not.toContain('hunter2'); // never plaintext
  });

  it('refuses to save and writes nothing when encryption is unavailable', () => {
    const s = createSecretsStore(dir, fakeSafe(false));
    expect(s.isAvailable()).toBe(false);
    expect(s.set('dev1', 'hunter2')).toBe(false);
    expect(existsSync(join(dir, 'secrets.json'))).toBe(false);
  });

  it('returns null on missing entry and on decryption failure', () => {
    const s = createSecretsStore(dir, fakeSafe());
    expect(s.get('nope')).toBeNull();
    // Corrupt cipher: decryptString throws -> get returns null, not crash.
    const bad = createSecretsStore(dir, {
      isEncryptionAvailable: () => true,
      encryptString: () => Buffer.from('not-tagged', 'utf8'),
      decryptString: fakeSafe().decryptString,
    });
    bad.set('dev1', 'x');
    expect(bad.get('dev1')).toBeNull();
  });

  it('clears a stored password', () => {
    const s = createSecretsStore(dir, fakeSafe());
    s.set('dev1', 'hunter2');
    s.clear('dev1');
    expect(s.has('dev1')).toBe(false);
    expect(createSecretsStore(dir, fakeSafe()).get('dev1')).toBeNull();
  });

  it('writes atomically (no leftover temp file)', () => {
    const s = createSecretsStore(dir, fakeSafe());
    s.set('dev1', 'hunter2');
    expect(existsSync(join(dir, 'secrets.json.tmp'))).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/main/secrets.test.ts`
Expected: FAIL — cannot resolve `../../src/main/services/secrets`.

- [ ] **Step 3: Write minimal implementation**

Create `src/main/services/secrets.ts`:

```ts
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plain: string): Buffer;
  decryptString(cipher: Buffer): string;
}

export interface SecretsStore {
  isAvailable(): boolean;
  /** Encrypt + persist. Returns false (writing nothing) if encryption is unavailable. */
  set(deviceId: string, password: string): boolean;
  /** Decrypt. Returns null if absent or on decryption failure. Main-process only — never crosses IPC. */
  get(deviceId: string): string | null;
  has(deviceId: string): boolean;
  clear(deviceId: string): void;
}

// secrets.json maps deviceId -> base64(ciphertext). Only ciphertext is ever written.
type SecretsFile = Record<string, string>;

function writeJsonAtomic(file: string, data: unknown): void {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  renameSync(tmp, file);
}

export function createSecretsStore(baseDir: string, safe: SafeStorageLike): SecretsStore {
  const file = join(baseDir, 'secrets.json');

  let data: SecretsFile = {};
  if (existsSync(file)) {
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8'));
      if (raw && typeof raw === 'object') {
        for (const [k, v] of Object.entries(raw)) if (typeof v === 'string') data[k] = v;
      }
    } catch {
      try { renameSync(file, `${file}.bak`); } catch { /* ignore */ }
      data = {};
    }
  }

  const save = () => writeJsonAtomic(file, data);

  return {
    isAvailable: () => safe.isEncryptionAvailable(),
    set(deviceId, password) {
      if (!safe.isEncryptionAvailable()) return false;
      data = { ...data, [deviceId]: safe.encryptString(password).toString('base64') };
      save();
      return true;
    },
    get(deviceId) {
      const b64 = data[deviceId];
      if (!b64) return null;
      try { return safe.decryptString(Buffer.from(b64, 'base64')); }
      catch { return null; }
    },
    has: (deviceId) => typeof data[deviceId] === 'string' && data[deviceId].length > 0,
    clear(deviceId) {
      if (!(deviceId in data)) return;
      const next = { ...data };
      delete next[deviceId];
      data = next;
      save();
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- test/main/secrets.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/main/services/secrets.ts test/main/secrets.test.ts
git commit -m "feat: encrypted per-device secrets store via safeStorage"
```

---

### Task 2: Autofill DOM functions (`autofill.ts` — probe + fill)

**Files:**
- Create: `src/main/services/autofill.ts`
- Test: `test/main/autofill-dom.test.ts`
- Modify: `package.json` (add `jsdom` dev dependency)

**Interfaces:**
- Consumes: nothing.
- Produces (all exported from `src/main/services/autofill.ts`):
  - `function hasVisiblePasswordField(): boolean` — self-contained; runs inside the device page.
  - `function fillLogin(password: string, submit: boolean): boolean` — self-contained; fills the password input, dispatches `input`/`change`, and (if `submit`) clicks the submit control. Returns whether a password input was found.
  - `function probeCode(): string` — returns injectable JS source evaluating to a boolean.
  - `function fillCode(password: string, submit: boolean): string` — returns injectable JS source evaluating to a boolean.

**IMPORTANT:** `hasVisiblePasswordField` and `fillLogin` must reference NO module-scope symbols (they are serialized with `.toString()` and injected into a different JS context). Keep every helper inline.

- [ ] **Step 1: Add jsdom dev dependency**

Run: `npm install -D jsdom`
Expected: `jsdom` added to `devDependencies` in `package.json`.

- [ ] **Step 2: Write the failing test**

Create `test/main/autofill-dom.test.ts`:

```ts
// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { hasVisiblePasswordField, fillLogin, probeCode, fillCode } from '../../src/main/services/autofill';

// jsdom has no layout engine, so getBoundingClientRect returns zeros. Stub it to a
// visible box for elements we consider "shown".
function makeVisible(el: Element): void {
  (el as HTMLElement).getBoundingClientRect = () =>
    ({ width: 200, height: 24, top: 0, left: 0, right: 200, bottom: 24, x: 0, y: 0, toJSON() {} }) as DOMRect;
}

beforeEach(() => { document.body.innerHTML = ''; });

describe('autofill DOM probe', () => {
  it('detects a visible password field', () => {
    document.body.innerHTML = `<form><input type="password"><button type="submit">Sign in</button></form>`;
    makeVisible(document.querySelector('input')!);
    expect(hasVisiblePasswordField()).toBe(true);
  });

  it('ignores a display:none password field', () => {
    document.body.innerHTML = `<input type="password" style="display:none">`;
    // rect stays zero-size (hidden) -> not visible
    expect(hasVisiblePasswordField()).toBe(false);
  });

  it('returns false when there is no password field', () => {
    document.body.innerHTML = `<input type="text">`;
    expect(hasVisiblePasswordField()).toBe(false);
  });
});

describe('autofill fill', () => {
  it('fills the value, dispatches input+change, and clicks submit when submit=true', () => {
    document.body.innerHTML = `<form><input type="password"><button type="submit">Sign in</button></form>`;
    const input = document.querySelector('input') as HTMLInputElement;
    makeVisible(input);
    let inputFired = false, changeFired = false, clicked = false;
    input.addEventListener('input', () => { inputFired = true; });
    input.addEventListener('change', () => { changeFired = true; });
    document.querySelector('button')!.addEventListener('click', (e) => { e.preventDefault(); clicked = true; });

    expect(fillLogin('s3cret', true)).toBe(true);
    expect(input.value).toBe('s3cret');
    expect(inputFired).toBe(true);
    expect(changeFired).toBe(true);
    expect(clicked).toBe(true);
  });

  it('fills without clicking submit when submit=false', () => {
    document.body.innerHTML = `<form><input type="password"><button type="submit">Sign in</button></form>`;
    let clicked = false;
    document.querySelector('button')!.addEventListener('click', (e) => { e.preventDefault(); clicked = true; });
    expect(fillLogin('s3cret', false)).toBe(true);
    expect((document.querySelector('input') as HTMLInputElement).value).toBe('s3cret');
    expect(clicked).toBe(false);
  });

  it('returns false when there is no password field to fill', () => {
    document.body.innerHTML = `<input type="text">`;
    expect(fillLogin('s3cret', true)).toBe(false);
  });
});

describe('injectable code builders', () => {
  it('probeCode is a self-invoking expression', () => {
    expect(probeCode()).toContain('hasVisiblePasswordField');
    expect(probeCode().trim().startsWith('(')).toBe(true);
  });
  it('fillCode embeds the password as a JSON-escaped string and the submit flag', () => {
    const code = fillCode('a"b', true);
    expect(code).toContain(JSON.stringify('a"b')); // safely escaped
    expect(code).toContain(', true)');
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test -- test/main/autofill-dom.test.ts`
Expected: FAIL — cannot resolve `autofill`.

- [ ] **Step 4: Write minimal implementation**

Create `src/main/services/autofill.ts`:

```ts
// DOM functions injected into a device's WebContentsView. They are serialized with
// Function.prototype.toString(), so they MUST be self-contained (no module-scope refs).

/** True if the page currently shows a visible password input (i.e. we're on a login screen). */
export function hasVisiblePasswordField(): boolean {
  const inputs = Array.from(document.querySelectorAll('input[type="password"]'));
  return inputs.some((el) => {
    const style = getComputedStyle(el as Element);
    if (style.visibility === 'hidden' || style.display === 'none') return false;
    const r = (el as HTMLElement).getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  });
}

/**
 * Fill the login password field and optionally submit. Returns whether a password
 * input was found. Uses the native value setter so framework-controlled inputs
 * (React/Vue) register the change.
 */
export function fillLogin(password: string, submit: boolean): boolean {
  const input = document.querySelector('input[type="password"]') as HTMLInputElement | null;
  if (!input) return false;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  if (setter) setter.call(input, password); else input.value = password;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  if (!submit) return true;
  const form = input.form;
  const btn = (
    form?.querySelector('button[type="submit"], input[type="submit"]') ||
    document.querySelector('button[type="submit"], input[type="submit"]') ||
    form?.querySelector('button') ||
    document.querySelector('button')
  ) as HTMLElement | null;
  if (btn) { btn.click(); return true; }
  if (form) { form.requestSubmit ? form.requestSubmit() : form.submit(); }
  return true;
}

/** Injectable source: evaluates to a boolean (login form present?). */
export function probeCode(): string {
  return `(${hasVisiblePasswordField.toString()})()`;
}

/** Injectable source: evaluates to a boolean (password input found?). */
export function fillCode(password: string, submit: boolean): string {
  return `(${fillLogin.toString()})(${JSON.stringify(password)}, ${submit})`;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- test/main/autofill-dom.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 6: Commit**

```bash
git add src/main/services/autofill.ts test/main/autofill-dom.test.ts package.json package-lock.json
git commit -m "feat: injectable DOM probe + fill for GLKVM login autofill"
```

---

### Task 3: Autofill orchestration + safety valve (`autofill.ts`)

**Files:**
- Modify: `src/main/services/autofill.ts` (append orchestration; do not change Task 2 exports)
- Test: `test/main/autofill-run.test.ts`

**Interfaces:**
- Consumes: `probeCode`, `fillCode` from Task 2.
- Produces (exported from `src/main/services/autofill.ts`):
  - `interface AutofillState { submittedThisSession: boolean; }`
  - `type AutofillAction = 'skip' | 'fill-and-submit' | 'fill-only';`
  - `function autofillDecision(state: AutofillState, formPresent: boolean): AutofillAction`
  - `interface AutofillDeps { runJs(code: string): Promise<unknown>; getPassword(): string | null; notifyFailure(): void; delay(ms: number): Promise<void>; }`
  - `function runAutofill(deps: AutofillDeps, state: AutofillState): Promise<void>`
  - Constants: `PROBE_ATTEMPTS = 8`, `PROBE_INTERVAL_MS = 250` (~2s total), `FAIL_WINDOW_MS = 3000`.

Decision semantics:
- `formPresent === false` → `skip` (already authenticated / not a login page).
- form present, not yet submitted this session → `fill-and-submit`.
- form present, already submitted this session → `fill-only` (safety valve: previous submit failed; fill but do NOT resubmit, then notify).

`runAutofill` flow: no password → return. Probe with bounded retry. Compute decision. `skip` → return. `fill-only` → `fillCode(pw,false)`, `notifyFailure()`, return. `fill-and-submit` → `fillCode(pw,true)`, set `submittedThisSession=true`, wait `FAIL_WINDOW_MS`, re-probe; if still present → `notifyFailure()` (do NOT resubmit).

- [ ] **Step 1: Write the failing test**

Create `test/main/autofill-run.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { autofillDecision, runAutofill, type AutofillState, type AutofillDeps } from '../../src/main/services/autofill';

describe('autofillDecision', () => {
  it('skips when no form present', () => {
    expect(autofillDecision({ submittedThisSession: false }, false)).toBe('skip');
  });
  it('fills and submits on first login form', () => {
    expect(autofillDecision({ submittedThisSession: false }, true)).toBe('fill-and-submit');
  });
  it('fills only (no resubmit) after a prior submit — safety valve', () => {
    expect(autofillDecision({ submittedThisSession: true }, true)).toBe('fill-only');
  });
});

// A scripted runJs: returns queued probe results; records fill calls.
function harness(probeResults: boolean[], password: string | null) {
  const calls: string[] = [];
  let probeIdx = 0;
  let failures = 0;
  const deps: AutofillDeps = {
    runJs: async (code) => {
      calls.push(code);
      if (code.includes('hasVisiblePasswordField')) {
        const r = probeResults[Math.min(probeIdx, probeResults.length - 1)];
        probeIdx++;
        return r;
      }
      return true; // fillCode
    },
    getPassword: () => password,
    notifyFailure: () => { failures++; },
    delay: async () => {},
  };
  return { deps, calls, failures: () => failures };
}

describe('runAutofill', () => {
  it('does nothing when there is no saved password', async () => {
    const h = harness([true], null);
    await runAutofill(h.deps, { submittedThisSession: false });
    expect(h.calls.length).toBe(0);
  });

  it('skips (never fills) when no login form appears', async () => {
    const h = harness([false], 'pw');
    await runAutofill(h.deps, { submittedThisSession: false });
    expect(h.calls.some((c) => c.includes('fillLogin'))).toBe(false);
  });

  it('fills+submits then reports success (form gone after submit)', async () => {
    // probes: first probe true (login present), post-submit probe false (logged in)
    const h = harness([true, false], 'pw');
    const state: AutofillState = { submittedThisSession: false };
    await runAutofill(h.deps, state);
    expect(h.calls.some((c) => c.includes('fillLogin') && c.includes(', true'))).toBe(true);
    expect(state.submittedThisSession).toBe(true);
    expect(h.failures()).toBe(0);
  });

  it('notifies failure when the login form persists after submit', async () => {
    const h = harness([true, true], 'pw'); // present before AND after submit
    await runAutofill(h.deps, { submittedThisSession: false });
    expect(h.failures()).toBe(1);
  });

  it('safety valve: on a resubmit attempt it fills only, never clicks submit, and notifies', async () => {
    const h = harness([true], 'pw');
    await runAutofill(h.deps, { submittedThisSession: true });
    const fillCalls = h.calls.filter((c) => c.includes('fillLogin'));
    expect(fillCalls.length).toBe(1);
    expect(fillCalls[0]).toContain(', false'); // submit=false
    expect(h.failures()).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/main/autofill-run.test.ts`
Expected: FAIL — `autofillDecision`/`runAutofill` not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `src/main/services/autofill.ts`:

```ts
export const PROBE_ATTEMPTS = 8;
export const PROBE_INTERVAL_MS = 250; // ~2s total detection window
export const FAIL_WINDOW_MS = 3000;   // "still on login" => failed sign-in

export interface AutofillState { submittedThisSession: boolean; }
export type AutofillAction = 'skip' | 'fill-and-submit' | 'fill-only';

export function autofillDecision(state: AutofillState, formPresent: boolean): AutofillAction {
  if (!formPresent) return 'skip';
  return state.submittedThisSession ? 'fill-only' : 'fill-and-submit';
}

export interface AutofillDeps {
  runJs(code: string): Promise<unknown>;
  getPassword(): string | null;
  notifyFailure(): void;
  delay(ms: number): Promise<void>;
}

export async function runAutofill(deps: AutofillDeps, state: AutofillState): Promise<void> {
  const password = deps.getPassword();
  if (password == null) return; // no saved secret for this device

  let present = false;
  for (let i = 0; i < PROBE_ATTEMPTS; i++) {
    present = (await deps.runJs(probeCode())) === true;
    if (present) break;
    if (i < PROBE_ATTEMPTS - 1) await deps.delay(PROBE_INTERVAL_MS);
  }

  const action = autofillDecision(state, present);
  if (action === 'skip') return;

  if (action === 'fill-only') {
    await deps.runJs(fillCode(password, false)); // fill, do NOT resubmit
    deps.notifyFailure();
    return;
  }

  // fill-and-submit
  await deps.runJs(fillCode(password, true));
  state.submittedThisSession = true;
  await deps.delay(FAIL_WINDOW_MS);
  const stillLogin = (await deps.runJs(probeCode())) === true;
  if (stillLogin) deps.notifyFailure(); // failed sign-in — safety valve blocks any resubmit
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- test/main/autofill-run.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add src/main/services/autofill.ts test/main/autofill-run.test.ts
git commit -m "feat: autofill orchestration with safety valve against resubmitting bad passwords"
```

---

### Task 4: Wire secrets + autofill into the connection manager and main

**Files:**
- Modify: `src/main/services/connections.ts` (add `secrets` + `onAutofillFailed` to `Deps`; per-device `AutofillState`; call `runAutofill` in `did-finish-load`; reset state in `disconnect`)
- Modify: `src/main/main.ts` (create secrets store, pass it + failure handler into `createConnectionManager`)

**Interfaces:**
- Consumes: `createSecretsStore`, `SecretsStore` (Task 1); `runAutofill`, `AutofillState` (Task 3).
- Produces: `Deps` gains `secrets: SecretsStore` and optional `onAutofillFailed?: (deviceId: string) => void`.

This task is Electron/webContents glue; verification is `npm test` (nothing regresses) + `npm run typecheck` + `npm run lint`. The pure logic it relies on is already tested in Tasks 1 & 3.

- [ ] **Step 1: Extend the connection manager Deps and state**

In `src/main/services/connections.ts`, add imports at the top:

```ts
import { runAutofill, type AutofillState } from './autofill';
import type { SecretsStore } from './secrets';
```

Add to the `Deps` interface (after `store: Store;`):

```ts
  secrets: SecretsStore;
  onAutofillFailed?: (deviceId: string) => void;
```

Inside `createConnectionManager`, next to the other `Map`s (near `const loaded = new Set<string>();`), add:

```ts
  const autofillStates = new Map<string, AutofillState>();
```

- [ ] **Step 2: Trigger autofill on successful load**

In `connections.ts`, inside the `newView.webContents.on('did-finish-load', ...)` handler, AFTER the existing `void measureNatural(id).then(() => applyFit(id));` line, add:

```ts
          // Attempt login autofill for this device (no-op if no saved password or already logged in).
          let af = autofillStates.get(id);
          if (!af) { af = { submittedThisSession: false }; autofillStates.set(id, af); }
          void runAutofill({
            runJs: (code) => newView.webContents.executeJavaScript(code),
            getPassword: () => deps.secrets.get(id),
            notifyFailure: () => deps.onAutofillFailed?.(id),
            delay: (ms) => new Promise((r) => setTimeout(r, ms)),
          }, af);
```

- [ ] **Step 3: Reset autofill state when a session ends**

In `connections.ts`, inside `disconnect`, after `loaded.delete(targetId);` add:

```ts
    autofillStates.delete(targetId);
```

- [ ] **Step 4: Create the secrets store and wire it in `main.ts`**

In `src/main/main.ts`, add imports near the other service imports:

```ts
import { safeStorage } from 'electron';
import { createSecretsStore } from './services/secrets';
```

(Adjust the existing `import { app, session } from 'electron';` line to also import `safeStorage`, or add the separate import above — either is fine.)

After `const store = createStore(app.getPath('userData'));` add:

```ts
  const secrets = createSecretsStore(app.getPath('userData'), safeStorage);
```

In the `createConnectionManager({ ... })` call, add these two properties (e.g. after `store,`):

```ts
    secrets,
    onAutofillFailed: (deviceId) => {
      const dev = store.getDevices().find((d) => d.id === deviceId);
      logger.warn(`autofill sign-in failed for ${dev?.name ?? deviceId}`);
      void bridge.request({
        kind: 'alert',
        message: `Autofill couldn't sign in to ${dev?.name ?? 'the device'}. Check the saved password in its settings.`,
      });
    },
```

- [ ] **Step 5: Verify nothing regressed and types/lint pass**

Run: `npm test`
Expected: PASS (all suites, including Tasks 1–3).

Run: `npm run typecheck`
Expected: no errors.

Run: `npm run lint`
Expected: no errors. (`logger.warn` must exist — if the logger only has `info`/`error`, use `logger.error` instead.)

- [ ] **Step 6: Commit**

```bash
git add src/main/services/connections.ts src/main/main.ts
git commit -m "feat: run login autofill on device load; wire secrets store + failure notice"
```

---

### Task 5: IPC + preload API for managing passwords

**Files:**
- Modify: `src/main/ipc.ts` (add `secrets` param to `registerIpc`; add `secrets:*` handlers; clear secret on device remove)
- Modify: `src/main/main.ts` (pass `secrets` to `registerIpc`)
- Modify: `src/preload/api.ts` (extend `GlkvmApi`)
- Modify: `src/preload/preload.ts` (implement new methods)

**Interfaces:**
- Consumes: `SecretsStore` (Task 1).
- Produces (added to `GlkvmApi`):
  - `setPassword(id: string, password: string): Promise<boolean>`
  - `hasPassword(id: string): Promise<boolean>`
  - `clearPassword(id: string): Promise<void>`
  - `secretsAvailable(): Promise<boolean>`
  - Note: there is deliberately NO `getPassword` — plaintext never returns to the renderer.

Glue task; verification is `npm run typecheck` + `npm run lint` + `npm test`.

- [ ] **Step 1: Add secrets to `registerIpc` and handle device-remove cleanup**

In `src/main/ipc.ts`, add an import:

```ts
import type { SecretsStore } from './services/secrets';
```

Change the `registerIpc` signature to accept secrets:

```ts
export function registerIpc(store: Store, connections: ConnectionManager, bridge: ReturnType<typeof createModalBridge>, secrets: SecretsStore): void {
```

Replace the existing `devices:remove` handler line with one that also clears the secret:

```ts
  ipcMain.handle('devices:remove', (_e, id) => { store.removeDevice(id); secrets.clear(id); });
```

Add these handlers (near the other `ipcMain.handle` calls, before `backup:export`):

```ts
  ipcMain.handle('secrets:set', (_e, id, password) => secrets.set(id, password));
  ipcMain.handle('secrets:has', (_e, id) => secrets.has(id));
  ipcMain.handle('secrets:clear', (_e, id) => secrets.clear(id));
  ipcMain.handle('secrets:available', () => secrets.isAvailable());
```

- [ ] **Step 2: Pass `secrets` from `main.ts`**

In `src/main/main.ts`, update the call:

```ts
  registerIpc(store, connections, bridge, secrets);
```

- [ ] **Step 3: Extend the preload API type**

In `src/preload/api.ts`, add to the `GlkvmApi` interface (after `removeDevice`):

```ts
  setPassword(id: string, password: string): Promise<boolean>;
  hasPassword(id: string): Promise<boolean>;
  clearPassword(id: string): Promise<void>;
  secretsAvailable(): Promise<boolean>;
```

- [ ] **Step 4: Implement in preload**

In `src/preload/preload.ts`, add to the `api` object (after `removeDevice`):

```ts
  setPassword: (id, password) => ipcRenderer.invoke('secrets:set', id, password),
  hasPassword: (id) => ipcRenderer.invoke('secrets:has', id),
  clearPassword: (id) => ipcRenderer.invoke('secrets:clear', id),
  secretsAvailable: () => ipcRenderer.invoke('secrets:available'),
```

- [ ] **Step 5: Verify types, lint, tests**

Run: `npm run typecheck && npm run lint && npm test`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/main/ipc.ts src/main/main.ts src/preload/api.ts src/preload/preload.ts
git commit -m "feat: IPC + preload API to set/clear/query device passwords"
```

---

### Task 6: Device dialog password field + dashboard wiring

**Files:**
- Modify: `src/renderer/deviceDialog.ts` (add password field, saved-state UI, unavailable message; extend `onSave` input)
- Modify: `src/renderer/dashboard.ts` (fetch `hasPassword`/`secretsAvailable`; separate secret fields from device fields on save)
- Modify: `src/renderer/styles.css` (minimal styling for the new field / saved state — reuse existing `.fld` class)

**Interfaces:**
- Consumes: `setPassword`, `hasPassword`, `clearPassword`, `secretsAvailable` (Task 5).
- Produces: `DialogOpts` gains `hasSavedPassword?: boolean` and `secretsAvailable?: boolean`; `onSave` input gains `password?: string` and `clearPassword?: boolean`.

**CRITICAL:** The password/clearPassword fields must NOT be passed into `addDevice`/`updateDevice` (they would be spread into `devices.json` — plaintext leak). The dashboard destructures them off before calling those APIs and routes them to `setPassword`/`clearPassword` instead.

Renderer/UI glue; verification is `npm run typecheck` + `npm run lint` + the smoke test in Step 6.

- [ ] **Step 1: Extend `DialogOpts` and `onSave` in `deviceDialog.ts`**

In `src/renderer/deviceDialog.ts`, update the `DialogOpts` interface:

```ts
interface DialogOpts {
  device?: Device;
  hasSavedPassword?: boolean;
  secretsAvailable?: boolean;
  onSave: (input: {
    name: string; address: string; color?: string; os: OsKind;
    password?: string;        // new/replacement plaintext, if the user typed one
    clearPassword?: boolean;  // user cleared an existing saved password
  }) => Promise<void>;
}
```

- [ ] **Step 2: Thread password state through `runDialog`**

In `deviceDialog.ts`, update `openDeviceDialog` and `runDialog` to carry password intent. Replace the body of `openDeviceDialog` and the `runDialog` signature/state block with:

```ts
export function openDeviceDialog(opts: DialogOpts): void {
  const name0 = opts.device?.name ?? '';
  const address0 = opts.device?.address ?? '';
  const os0: OsKind = opts.device?.os ?? 'generic';
  const color0 = opts.device?.color ?? '#34d399';
  runDialog(opts, name0, address0, os0, color0);
}

function runDialog(opts: DialogOpts, name0: string, address0: string, os0: OsKind, color0: string): void {
  let name = name0;
  let address = address0;
  let os: OsKind = os0;
  let color = color0;
  let password: string | undefined;              // set only if the user types one
  let clearedSaved = false;                       // user hit "Clear" on an existing saved password
  const available = opts.secretsAvailable !== false;
```

- [ ] **Step 3: Render the password field**

In `deviceDialog.ts`, inside the `render:` callback, extend the `body.innerHTML` template to add a password field block after the `Accent` field:

```ts
        <div class="fld"><label>Accent</label><div class="swatches" id="sw"></div></div>
        <div class="fld"><label>Login password</label><div id="pw"></div></div>`;
```

Then, after the swatches wiring (end of the `render` callback, before its closing brace), add:

```ts
      const pw = body.querySelector('#pw') as HTMLElement;
      const renderPw = () => {
        if (!available) {
          pw.innerHTML = `<div class="hint">Secure storage unavailable — autofill disabled.</div>`;
          return;
        }
        if (opts.hasSavedPassword && !clearedSaved && password === undefined) {
          pw.innerHTML = `<div class="saved">Password saved <button type="button" class="link" id="pw-clear">Clear</button></div>`;
          (pw.querySelector('#pw-clear') as HTMLElement).onclick = () => { clearedSaved = true; renderPw(); };
        } else {
          pw.innerHTML = `<input name="password" type="password" placeholder="Optional — used for autofill">`;
          const inp = pw.querySelector('[name=password]') as HTMLInputElement;
          inp.value = password ?? '';
          inp.addEventListener('input', () => { password = inp.value || undefined; });
        }
      };
      renderPw();
```

- [ ] **Step 4: Pass password intent on save**

In `deviceDialog.ts`, update the `.then(async (v) => {...})` block's `opts.onSave(...)` call to include the secret intent:

```ts
    try {
      await opts.onSave({
        name, address, color, os,
        password,
        clearPassword: clearedSaved && !password,
      });
    } catch {
      runDialog(opts, name, address, os, color);
    }
```

(Note: `runDialog` re-open on error resets password entry — acceptable; the user re-enters. Keep it simple.)

- [ ] **Step 5: Wire the dashboard call sites (separate secret fields from device fields)**

In `src/renderer/dashboard.ts`, replace the Add button handler (currently line ~24):

```ts
  (root.querySelector('#add-btn') as HTMLElement).onclick = async () => {
    const secretsAvailable = await window.glkvm.secretsAvailable();
    openDeviceDialog({
      secretsAvailable,
      onSave: async ({ password, clearPassword, ...dev }) => {
        const d = await window.glkvm.addDevice(dev);
        if (password) await window.glkvm.setPassword(d.id, password);
        await renderDashboard(root);
      },
    });
  };
```

And replace the edit (contextmenu) handler in `rowFor` (currently line ~62-63):

```ts
  el.addEventListener('contextmenu', async (e) => {
    e.preventDefault();
    const [hasSavedPassword, secretsAvailable] = await Promise.all([
      window.glkvm.hasPassword(d.id),
      window.glkvm.secretsAvailable(),
    ]);
    openDeviceDialog({
      device: d, hasSavedPassword, secretsAvailable,
      onSave: async ({ password, clearPassword, ...dev }) => {
        await window.glkvm.updateDevice(d.id, dev);
        if (password) await window.glkvm.setPassword(d.id, password);
        else if (clearPassword) await window.glkvm.clearPassword(d.id);
        await renderDashboard(root);
      },
    });
  });
```

- [ ] **Step 6: Add minimal styles**

In `src/renderer/styles.css`, append:

```css
.fld .hint { font-size: 12px; opacity: 0.6; }
.fld .saved { display: flex; align-items: center; gap: 8px; font-size: 13px; }
.fld .link { background: none; border: none; color: #f472b6; cursor: pointer; padding: 0; font: inherit; text-decoration: underline; }
```

- [ ] **Step 7: Verify types, lint, and a focused smoke check**

Run: `npm run typecheck && npm run lint`
Expected: no errors.

Run: `npm run build`
Expected: builds without error (renderer + main compile).

Manual/smoke verification (the existing smoke harness launches the app):
Run: `npm run test:smoke`
Expected: existing smoke passes (app still boots and dashboard renders). If you extend it, assert the device dialog shows a `input[name="password"]` when adding a device.

- [ ] **Step 8: Commit**

```bash
git add src/renderer/deviceDialog.ts src/renderer/dashboard.ts src/renderer/styles.css
git commit -m "feat: password field on device dialog with saved-state + safe field separation"
```

---

### Task 7 (optional): Dashboard tile indicator for armed autofill

**Files:**
- Modify: `src/main/ipc.ts` (add `secrets:list` returning ids with a saved secret)
- Modify: `src/main/services/secrets.ts` (add `ids(): string[]` to `SecretsStore`)
- Modify: `src/preload/api.ts` + `src/preload/preload.ts` (`listPasswordIds(): Promise<string[]>`)
- Modify: `src/renderer/dashboard.ts` (render a key glyph on rows whose id is in the set)
- Modify: `test/main/secrets.test.ts` (cover `ids()`)

Only do this task if the tile indicator from the spec is still wanted. It's cosmetic.

- [ ] **Step 1: Add `ids()` to the secrets store (failing test first)**

In `test/main/secrets.test.ts`, add:

```ts
  it('lists ids that have a stored secret', () => {
    const s = createSecretsStore(dir, fakeSafe());
    s.set('a', 'x'); s.set('b', 'y'); s.clear('a');
    expect(createSecretsStore(dir, fakeSafe()).ids().sort()).toEqual(['b']);
  });
```

Run: `npm test -- test/main/secrets.test.ts` → FAIL (`ids` not a function).

- [ ] **Step 2: Implement `ids()`**

In `src/main/services/secrets.ts`, add `ids(): string[];` to the `SecretsStore` interface, and in the returned object:

```ts
    ids: () => Object.keys(data),
```

Run: `npm test -- test/main/secrets.test.ts` → PASS.

- [ ] **Step 3: Expose over IPC + preload**

`src/main/ipc.ts` (near other secrets handlers):

```ts
  ipcMain.handle('secrets:list', () => secrets.ids());
```

`src/preload/api.ts` (in `GlkvmApi`):

```ts
  listPasswordIds(): Promise<string[]>;
```

`src/preload/preload.ts`:

```ts
  listPasswordIds: () => ipcRenderer.invoke('secrets:list'),
```

- [ ] **Step 4: Render the glyph**

In `src/renderer/dashboard.ts`, in `renderDashboard`, fetch the set alongside devices:

```ts
  const devices = await window.glkvm.listDevices();
  const secretIds = new Set(await window.glkvm.listPasswordIds());
```

Pass it into `rowFor` (update its signature to `rowFor(root: HTMLElement, d: Device, hasSecret: boolean)` and the call `list.appendChild(rowFor(root, d, secretIds.has(d.id)));`). In `rowFor`, when `hasSecret`, append a small marker to the meta block, e.g. after setting `.addr`:

```ts
  if (hasSecret) {
    const key = document.createElement('span');
    key.className = 'keymark';
    key.title = 'Autofill armed';
    key.textContent = '🔑';
    (el.querySelector('.meta') as HTMLElement).appendChild(key);
  }
```

Add to `styles.css`:

```css
.keymark { font-size: 11px; opacity: 0.6; margin-left: 6px; }
```

- [ ] **Step 5: Verify and commit**

Run: `npm run typecheck && npm run lint && npm test`
Expected: all pass.

```bash
git add src/main/services/secrets.ts src/main/ipc.ts src/preload/api.ts src/preload/preload.ts src/renderer/dashboard.ts src/renderer/styles.css test/main/secrets.test.ts
git commit -m "feat: dashboard key glyph marking devices with saved autofill password"
```

---

## Self-Review

**Spec coverage:**
- Encrypted storage via safeStorage, ciphertext-only, separate file → Task 1. ✓
- No-keyring → feature disabled, never plaintext → Task 1 (`set` returns false), surfaced in UI Task 6 (`secretsAvailable` → "unavailable" hint). ✓
- Excluded from backups → inherent: `buildBackup`/`exportBundle` only serialize devices+settings; secrets live in `secrets.json`, never touched by backup. Task 6's field-separation prevents plaintext leaking into `devices.json`. ✓
- Detect login form (`input[type=password]`), bounded ~2s retry → Task 2 (`hasVisiblePasswordField`) + Task 3 (`PROBE_ATTEMPTS`/`PROBE_INTERVAL_MS`). ✓
- Fill value + dispatch input/change + submit → Task 2 (`fillLogin`, native setter). ✓
- Safety valve: no resubmit on failure, fill-only + notice, ~3s window → Task 3 (`autofillDecision`, `FAIL_WINDOW_MS`, `notifyFailure`). ✓
- Fixed app-authored injected code (no remote code) → Task 2 (`.toString()` of local functions, password JSON-escaped). ✓
- Guard against injecting into non-login pages → Task 3 (`skip` when no form). ✓
- UX: password field on device dialog, saved-state + Clear, plaintext never returned → Task 6 (uses `hasPassword`, never `getPassword`). ✓
- Clear secret on device delete → Task 5 (`devices:remove` also calls `secrets.clear`). ✓
- Optional tile glyph → Task 7. ✓
- Error handling table (decrypt fail → null/skip; wrong pw → valve; form never appears → skip) → Tasks 1 & 3. ✓
- Testing: secrets round-trip/missing-keyring/decrypt-fail, safety-valve state machine, DOM probe/fill in jsdom, backup exclusion → Tasks 1–3; smoke → Task 6. ✓

**Placeholder scan:** No TBD/TODO; all steps contain concrete code. ✓

**Type consistency:** `SecretsStore` methods (`isAvailable`/`set`/`get`/`has`/`clear`, plus `ids` in Task 7) consistent across Tasks 1, 4, 5, 7. `AutofillState.submittedThisSession`, `AutofillDeps` shape, and `runAutofill(deps, state)` signature consistent across Tasks 3 & 4. `GlkvmApi` additions (`setPassword`/`hasPassword`/`clearPassword`/`secretsAvailable`/`listPasswordIds`) consistent across Tasks 5, 6, 7. `onSave` input shape consistent between Task 6's `deviceDialog.ts` and `dashboard.ts`. ✓
