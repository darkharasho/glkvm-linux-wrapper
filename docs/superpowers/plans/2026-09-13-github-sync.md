# GitHub Sign-in and Config Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users sign in with GitHub and automatically sync devices, settings, trusted certificates and passphrase-encrypted passwords across machines through a private `glkvm-config` repository.

**Architecture:** Pure, shared logic (file format validation and per-item merge) lives in `src/shared/sync/`. Main-process services handle GitHub auth (device flow), encryption (scrypt + AES-256-GCM), encrypted local files (`safeStorage`), and a sync service that fetches, merges, applies and pushes one JSON file through the GitHub contents API. The store and secrets store emit change events that stamp per-item modification times. The renderer gets a Sync section in Settings.

**Tech Stack:** Electron 32, TypeScript (strict), electron-vite, Vitest 2, Node `crypto`, global `fetch`. No new npm dependencies.

**Spec:** `docs/superpowers/specs/2026-09-13-github-sync-design.md`

## Global Constraints

- No new npm dependencies.
- Repo name `glkvm-config`, private; file name `glkvm-sync.json`; commit message `sync: update config`.
- OAuth client ID from `process.env.GLKVM_GH_CLIENT_ID`, empty placeholder otherwise; scopes `repo read:user`.
- Tokens, passphrases, keys and passwords are never logged and never written unencrypted to disk.
- scrypt `N=2^15, r=8, p=1`, 32-byte key, 16-byte salt; AES-256-GCM with 12-byte IV and 16-byte tag.
- Minimum passphrase length: 8 characters.
- Deletion markers expire after 90 days.
- Push debounce 2s; focus sync throttle 60s; launch and sign-in sync after 2s; at most 3 write attempts per cycle.
- Tests: `npx vitest run --maxWorkers=2 <path>` (never more than 2 workers).
- Never use `workmac.local` in examples or fixtures; use neutral hosts like `mypc.local`, `kvm-a.local`.
- ESLint uses `@typescript-eslint/recommended`: avoid `any`.

## Deliberate refinements of the spec

These are implementation-level simplifications decided while planning. They don't change behavior users see.

- `SyncState.remoteSha` is dropped: every cycle fetches the current `sha` before writing, so storing it adds nothing.
- The renderer receives one `sync:overview` event (user, sync status, password state) instead of separate `github:auth-complete` and `sync:status` events. `github:auth-error` and `sync:applied` remain.
- Passphrase and sign-out confirmations render as inline forms inside the Sync section, not pop-up dialogs. The existing `openModal` renders under the Settings `<dialog>` (which sits in the browser's top layer), so it can't be used from inside Settings.
- The avatar is always shown as the first letter of the login. The packaged CSP (`img-src 'self' data:`) blocks GitHub avatar URLs.

## File map

| File | Responsibility |
|---|---|
| `src/shared/sync/format.ts` (new) | Sync types, constants, `canonicalJson`, `parseSyncDoc`, `parseSyncState`, UI overview types |
| `src/shared/sync/merge.ts` (new) | Pure per-item merge of local state and remote document |
| `src/main/services/sync/crypto.ts` (new) | Key derivation, encrypt/decrypt, header creation, unlock, key (de)serialization |
| `src/main/services/sealedFile.ts` (new) | A single string stored encrypted with `safeStorage`, with a session-only fallback |
| `src/main/services/store.ts` (modify) | Emit change events; `applySynced` |
| `src/main/services/secrets.ts` (modify) | Emit change events; `replaceAll` |
| `src/main/services/github/api.ts` (new) | `fetch` helpers for the GitHub REST API and OAuth form posts |
| `src/main/services/github/auth.ts` (new) | Device flow, session storage, sign-out |
| `src/main/services/sync/stateFile.ts` (new) | Load/save `sync-state.json` |
| `src/main/services/sync/syncService.ts` (new) | Repo setup, sync cycle, triggers, passphrase operations, status |
| `src/main/syncIpc.ts` (new) | IPC handlers for auth and sync |
| `src/main/main.ts` (modify) | Construct and wire auth + sync |
| `src/preload/api.ts`, `src/preload/preload.ts` (modify) | Renderer API |
| `src/renderer/syncSection.ts` (new) | Sync section UI |
| `src/renderer/settingsPanel.ts`, `src/renderer/main.ts`, `src/renderer/styles.css` (modify) | Mount section, refresh dashboard, styles |

---

### Task 0: Install dependencies and confirm a green baseline

**Files:** none

- [ ] **Step 1: Install**

Run: `npm ci`
Expected: completes without errors.

- [ ] **Step 2: Run the existing checks**

Run: `npx vitest run --maxWorkers=2 && npm run typecheck && npm run lint`
Expected: all tests pass, no type errors, no lint errors. If anything fails before any change, stop and report it.

---

### Task 1: Sync file format and validation

**Files:**
- Create: `src/shared/sync/format.ts`
- Test: `test/shared/sync-format.test.ts`

**Interfaces:**
- Consumes: `validateDevices`, `validateSettings`, `DEFAULT_SETTINGS` from `src/shared/schema.ts`; `Device`, `Settings` from `src/shared/types.ts`.
- Produces (all exported from `src/shared/sync/format.ts`):
  - Constants `SYNC_FORMAT = 1`, `SYNC_REPO = 'glkvm-config'`, `SYNC_FILE = 'glkvm-sync.json'`, `MARKER_TTL_MS`
  - Types `EncryptedBlob`, `CryptoHeader`, `Stamped<T>`, `Tombstone`, `Entry<T>`, `SyncDoc`, `SyncState`, `ChangeEvent`, `GithubUser`, `SyncStatus`, `PasswordsState`, `SyncOverview`, `SyncResult`
  - `isLive<T>(e: Entry<T>): e is Stamped<T>`
  - `emptyDoc(): SyncDoc`, `emptyState(): SyncState`
  - `canonicalJson(value: unknown): string`
  - `parseSyncDoc(json: string): SyncDoc` (throws `Error` when invalid)
  - `parseSyncState(raw: unknown): SyncState`

- [ ] **Step 1: Write the failing tests**

Create `test/shared/sync-format.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  canonicalJson, emptyDoc, emptyState, parseSyncDoc, parseSyncState, isLive, SYNC_FORMAT,
} from '../../src/shared/sync/format';
import { DEFAULT_SETTINGS } from '../../src/shared/schema';

const device = (id: string, extra: Record<string, unknown> = {}) => ({
  id, name: 'Lab', address: 'kvm-a.local', url: 'https://kvm-a.local', os: 'linux', createdAt: 1, ...extra,
});
const blob = { iv: 'aXY=', tag: 'dGFn', ct: 'Y3Q=' };
const header = { keyId: 'k1', kdf: 'scrypt', salt: 'c2FsdA==', N: 32768, r: 8, p: 1, check: blob };

describe('canonicalJson', () => {
  it('is independent of object key order and drops undefined', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: undefined, e: [3, { z: 1, y: 2 }] } }))
      .toBe(canonicalJson({ a: { e: [3, { y: 2, z: 1 }], d: 2 }, b: 1 }));
  });
});

describe('parseSyncDoc', () => {
  it('round-trips a valid document', () => {
    const doc = {
      format: SYNC_FORMAT,
      crypto: header,
      settings: { updatedAt: 5, data: DEFAULT_SETTINGS },
      devices: { d1: { updatedAt: 3, data: device('d1') }, d2: { updatedAt: 4, deletedAt: 4 } },
      certs: { 'kvm-a.local': { updatedAt: 2, data: 'AB:CD' } },
      secrets: { d1: { updatedAt: 3, data: blob } },
    };
    const parsed = parseSyncDoc(JSON.stringify(doc));
    expect(canonicalJson(parsed)).toBe(canonicalJson(doc));
    expect(isLive(parsed.devices.d1)).toBe(true);
    expect(isLive(parsed.devices.d2)).toBe(false);
  });

  it('throws on invalid JSON, unknown format and a bad crypto header', () => {
    expect(() => parseSyncDoc('{nope')).toThrow();
    expect(() => parseSyncDoc(JSON.stringify({ ...emptyDoc(), format: 2 }))).toThrow();
    expect(() => parseSyncDoc(JSON.stringify({ ...emptyDoc(), crypto: { ...header, N: 1000 } }))).toThrow();
  });

  it('drops invalid entries but keeps the rest', () => {
    const parsed = parseSyncDoc(JSON.stringify({
      ...emptyDoc(),
      devices: {
        ok: { updatedAt: 1, data: device('ok') },
        badColor: { updatedAt: 1, data: device('badColor', { color: 'url(http://x)' }) },
        idMismatch: { updatedAt: 1, data: device('other') },
        noStamp: { data: device('noStamp') },
      },
      certs: { 'kvm-a.local': { updatedAt: 1, data: 42 } },
      secrets: { ok: { updatedAt: 1, data: { iv: '!!', tag: 'x', ct: 'y' } } },
    }));
    expect(Object.keys(parsed.devices)).toEqual(['ok']);
    expect(parsed.certs).toEqual({});
    expect(parsed.secrets).toEqual({});
  });
});

describe('parseSyncState', () => {
  it('returns an empty state for garbage and keeps valid stamps', () => {
    expect(parseSyncState('nope')).toEqual(emptyState());
    const s = parseSyncState({ settings: 7, devices: { a: 1, b: 'x' }, deleted: { certs: { h: 2 } } });
    expect(s.settings).toBe(7);
    expect(s.devices).toEqual({ a: 1 });
    expect(s.deleted.certs).toEqual({ h: 2 });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run --maxWorkers=2 test/shared/sync-format.test.ts`
Expected: FAIL — cannot resolve `../../src/shared/sync/format`.

- [ ] **Step 3: Implement `src/shared/sync/format.ts`**

```ts
import type { Device, Settings } from '../types';
import { validateDevices, validateSettings } from '../schema';

export const SYNC_FORMAT = 1;
export const SYNC_REPO = 'glkvm-config';
export const SYNC_FILE = 'glkvm-sync.json';
export const MARKER_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const MAX_SCRYPT_N = 1 << 17;

export interface EncryptedBlob { iv: string; tag: string; ct: string; }
export interface CryptoHeader {
  keyId: string; kdf: 'scrypt'; salt: string; N: number; r: number; p: number; check: EncryptedBlob;
}
export interface Stamped<T> { updatedAt: number; data: T; }
export interface Tombstone { updatedAt: number; deletedAt: number; }
export type Entry<T> = Stamped<T> | Tombstone;

export interface SyncDoc {
  format: typeof SYNC_FORMAT;
  crypto: CryptoHeader | null;
  settings: Stamped<Settings> | null;
  devices: Record<string, Entry<Device>>;
  certs: Record<string, Entry<string>>;
  secrets: Record<string, Entry<EncryptedBlob>>;
}

export interface SyncState {
  settings: number;
  devices: Record<string, number>;
  certs: Record<string, number>;
  secrets: Record<string, number>;
  deleted: { devices: Record<string, number>; certs: Record<string, number>; secrets: Record<string, number> };
}

export type ChangeEvent =
  | { kind: 'device'; id: string } | { kind: 'device-removed'; id: string }
  | { kind: 'settings' }
  | { kind: 'cert'; host: string } | { kind: 'cert-removed'; host: string }
  | { kind: 'secret'; id: string } | { kind: 'secret-removed'; id: string };

export interface GithubUser { login: string; name: string; avatarUrl: string; }
export interface SyncStatus { state: 'idle' | 'syncing' | 'synced' | 'error'; lastSynced?: number; error?: string; }
export type PasswordsState = 'unknown' | 'syncing' | 'needs-set' | 'needs-passphrase' | 'unavailable';
export interface SyncOverview { user: GithubUser | null; configured: boolean; sync: SyncStatus; passwords: PasswordsState; }
export type SyncResult = { ok: true } | { ok: false; error: string };

export function isLive<T>(e: Entry<T>): e is Stamped<T> {
  return 'data' in e;
}

export function emptyDoc(): SyncDoc {
  return { format: SYNC_FORMAT, crypto: null, settings: null, devices: {}, certs: {}, secrets: {} };
}

export function emptyState(): SyncState {
  return { settings: 0, devices: {}, certs: {}, secrets: {}, deleted: { devices: {}, certs: {}, secrets: {} } };
}

/** JSON with object keys sorted, so equal data always serializes identically. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v).sort()) {
      const x = (v as Record<string, unknown>)[k];
      if (x !== undefined) out[k] = sortKeys(x);
    }
    return out;
  }
  return v;
}

const obj = (v: unknown): Record<string, unknown> | null =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : null;
const isTime = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const isB64 = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9+/]*={0,2}$/.test(v);

function parseBlob(v: unknown): EncryptedBlob | null {
  const b = obj(v);
  return b && isB64(b.iv) && isB64(b.tag) && isB64(b.ct) ? { iv: b.iv, tag: b.tag, ct: b.ct } : null;
}

function parseCrypto(v: unknown): CryptoHeader | null {
  const c = obj(v);
  if (!c) return null;
  const check = parseBlob(c.check);
  const { N, r, p } = c;
  const okN = typeof N === 'number' && Number.isInteger(N) && N >= 2 && N <= MAX_SCRYPT_N && (N & (N - 1)) === 0;
  const okR = typeof r === 'number' && Number.isInteger(r) && r >= 1 && r <= 8;
  const okP = typeof p === 'number' && Number.isInteger(p) && p >= 1 && p <= 2;
  if (typeof c.keyId !== 'string' || !c.keyId || c.kdf !== 'scrypt' || !isB64(c.salt) || !okN || !okR || !okP || !check) {
    return null;
  }
  return { keyId: c.keyId, kdf: 'scrypt', salt: c.salt, N: N as number, r: r as number, p: p as number, check };
}

function parseEntries<T>(raw: unknown, parseData: (key: string, data: unknown) => T | null): Record<string, Entry<T>> {
  const out: Record<string, Entry<T>> = {};
  const r = obj(raw);
  if (!r) return out;
  for (const [k, v] of Object.entries(r)) {
    const e = obj(v);
    if (!e || !isTime(e.updatedAt)) continue;
    if ('deletedAt' in e) {
      if (isTime(e.deletedAt)) out[k] = { updatedAt: e.updatedAt, deletedAt: e.deletedAt };
      continue;
    }
    const data = parseData(k, e.data);
    if (data !== null) out[k] = { updatedAt: e.updatedAt, data };
  }
  return out;
}

export function parseSyncDoc(json: string): SyncDoc {
  let raw: unknown;
  try { raw = JSON.parse(json); } catch { throw new Error('not valid JSON'); }
  const r = obj(raw);
  if (!r || r.format !== SYNC_FORMAT) throw new Error('unsupported format');
  let crypto: CryptoHeader | null = null;
  if (r.crypto !== null && r.crypto !== undefined) {
    crypto = parseCrypto(r.crypto);
    if (!crypto) throw new Error('invalid encryption header');
  }
  const s = obj(r.settings);
  const settings = s && isTime(s.updatedAt) && obj(s.data)
    ? { updatedAt: s.updatedAt, data: validateSettings(s.data) }
    : null;
  return {
    format: SYNC_FORMAT,
    crypto,
    settings,
    devices: parseEntries<Device>(r.devices, (id, d) => {
      const [dev] = validateDevices([d]);
      return dev && dev.id === id ? dev : null;
    }),
    certs: parseEntries<string>(r.certs, (_host, d) => (typeof d === 'string' && d ? d : null)),
    secrets: parseEntries<EncryptedBlob>(r.secrets, (_id, d) => parseBlob(d)),
  };
}

function timeMap(v: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  const r = obj(v);
  if (r) for (const [k, x] of Object.entries(r)) if (isTime(x)) out[k] = x;
  return out;
}

export function parseSyncState(raw: unknown): SyncState {
  const r = obj(raw) ?? {};
  const d = obj(r.deleted) ?? {};
  return {
    settings: isTime(r.settings) ? r.settings : 0,
    devices: timeMap(r.devices),
    certs: timeMap(r.certs),
    secrets: timeMap(r.secrets),
    deleted: { devices: timeMap(d.devices), certs: timeMap(d.certs), secrets: timeMap(d.secrets) },
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run --maxWorkers=2 test/shared/sync-format.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/shared/sync/format.ts test/shared/sync-format.test.ts
git commit -m "feat(sync): sync file format and validation"
```

---

### Task 2: Per-item merge

**Files:**
- Create: `src/shared/sync/merge.ts`
- Test: `test/shared/sync-merge.test.ts`

**Interfaces:**
- Consumes: from Task 1 — `Entry`, `Stamped`, `Tombstone`, `SyncState`, `isLive`, `canonicalJson`, `MARKER_TTL_MS`, `emptyState`. `TrustStore` from `src/shared/certs.ts`.
- Produces:
  - `interface LocalSnapshot { devices: Device[]; settings: Settings; certs: TrustStore; secrets: Record<string, string> | null }`
  - `interface RemoteView { settings: Stamped<Settings> | null; devices: Record<string, Entry<Device>>; certs: Record<string, Entry<string>>; secrets: Record<string, Entry<string>> | null }`
  - `interface MergeResult { remote: { settings: Stamped<Settings>; devices: Record<string, Entry<Device>>; certs: Record<string, Entry<string>>; secrets: Record<string, Entry<string>> | null }; local: LocalSnapshot; state: SyncState; changed: { devices: boolean; settings: boolean; certs: boolean; secrets: boolean } }`
  - `mergeSync(local: LocalSnapshot, state: SyncState, remote: RemoteView, now: number): MergeResult`

Merge semantics (from the spec): per key, the larger `updatedAt` wins, ties go to remote; unstamped local items count as `0`; settings are one item; after merging, live devices sharing an `address` collapse to the newest (tie: smaller id), the loser becomes a tombstone at the winner's stamp and its password moves to the winner if the winner has none; a device tombstone tombstones a not-newer password; markers older than 90 days are dropped; when `secrets` is `null` on either side, secrets pass through untouched.

- [ ] **Step 1: Write the failing tests**

Create `test/shared/sync-merge.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { mergeSync, type LocalSnapshot, type RemoteView } from '../../src/shared/sync/merge';
import { emptyState, MARKER_TTL_MS, type SyncState } from '../../src/shared/sync/format';
import { DEFAULT_SETTINGS } from '../../src/shared/schema';
import type { Device } from '../../src/shared/types';

const NOW = 1_000_000_000_000;
const dev = (id: string, address = `${id}.local`, name = id): Device =>
  ({ id, name, address, url: `https://${address}`, os: 'linux', createdAt: 1 });
const local = (p: Partial<LocalSnapshot> = {}): LocalSnapshot =>
  ({ devices: [], settings: DEFAULT_SETTINGS, certs: {}, secrets: null, ...p });
const remote = (p: Partial<RemoteView> = {}): RemoteView =>
  ({ settings: null, devices: {}, certs: {}, secrets: null, ...p });
const state = (p: Partial<SyncState> = {}): SyncState => ({ ...emptyState(), ...p });

describe('mergeSync', () => {
  it('keeps the newer edit on each side', () => {
    const m = mergeSync(
      local({ devices: [dev('a', 'a.local', 'Local A'), dev('b', 'b.local', 'Local B')] }),
      state({ devices: { a: 20, b: 5 } }),
      remote({ devices: { a: { updatedAt: 10, data: dev('a', 'a.local', 'Remote A') }, b: { updatedAt: 15, data: dev('b', 'b.local', 'Remote B') } } }),
      NOW,
    );
    expect(m.local.devices.map(d => d.name)).toEqual(['Local A', 'Remote B']);
    expect(m.remote.devices.a).toEqual({ updatedAt: 20, data: dev('a', 'a.local', 'Local A') });
    expect(m.state.devices).toEqual({ a: 20, b: 15 });
    expect(m.changed.devices).toBe(true);
  });

  it('lets remote win a tie', () => {
    const m = mergeSync(
      local({ devices: [dev('a', 'a.local', 'Local')] }), state({ devices: { a: 10 } }),
      remote({ devices: { a: { updatedAt: 10, data: dev('a', 'a.local', 'Remote') } } }), NOW,
    );
    expect(m.local.devices[0].name).toBe('Remote');
  });

  it('propagates deletions and lets a newer edit restore an item', () => {
    const deleted = mergeSync(
      local(), state({ deleted: { devices: { a: 30 }, certs: {}, secrets: {} } }),
      remote({ devices: { a: { updatedAt: 10, data: dev('a') } } }), NOW,
    );
    expect(deleted.remote.devices.a).toEqual({ updatedAt: 30, deletedAt: 30 });
    expect(deleted.local.devices).toEqual([]);

    const restored = mergeSync(
      local(), state({ deleted: { devices: { a: 30 }, certs: {}, secrets: {} } }),
      remote({ devices: { a: { updatedAt: 40, data: dev('a') } } }), NOW,
    );
    expect(restored.local.devices.map(d => d.id)).toEqual(['a']);
    expect(restored.state.deleted.devices).toEqual({});
  });

  it('on first join, remote wins shared items and local-only items are pushed', () => {
    const m = mergeSync(
      local({ devices: [dev('shared', 'shared.local', 'Local'), dev('mine')] }), state(),
      remote({ devices: { shared: { updatedAt: 5, data: dev('shared', 'shared.local', 'Remote') } } }), NOW,
    );
    expect(m.local.devices.map(d => d.name)).toEqual(['Remote', 'mine']);
    expect(m.remote.devices.mine).toEqual({ updatedAt: 0, data: dev('mine') });
  });

  it('collapses duplicate addresses to the newest and moves the password', () => {
    const m = mergeSync(
      local({ devices: [dev('old', 'kvm-a.local')], secrets: { old: 'pw-old' } }),
      state({ devices: { old: 10 }, secrets: { old: 10 } }),
      remote({ devices: { new: { updatedAt: 20, data: dev('new', 'kvm-a.local') } }, secrets: {} }),
      NOW,
    );
    expect(m.local.devices.map(d => d.id)).toEqual(['new']);
    expect(m.remote.devices.old).toEqual({ updatedAt: 20, deletedAt: 20 });
    expect(m.local.secrets).toEqual({ new: 'pw-old' });
  });

  it('tombstones the password of a deleted device', () => {
    const m = mergeSync(
      local({ secrets: { a: 'pw' } }),
      state({ secrets: { a: 5 }, deleted: { devices: { a: 30 }, certs: {}, secrets: {} } }),
      remote({ devices: { a: { updatedAt: 10, data: dev('a') } }, secrets: { a: { updatedAt: 5, data: 'pw' } } }),
      NOW,
    );
    expect(m.remote.secrets?.a).toEqual({ updatedAt: 30, deletedAt: 30 });
    expect(m.local.secrets).toEqual({});
  });

  it('passes secrets through when there is no key', () => {
    const st = state({ secrets: { a: 9 } });
    const m = mergeSync(local(), st, remote(), NOW);
    expect(m.remote.secrets).toBeNull();
    expect(m.state.secrets).toEqual({ a: 9 });
    expect(m.changed.secrets).toBe(false);
  });

  it('drops markers older than 90 days', () => {
    const old = NOW - MARKER_TTL_MS - 1;
    const m = mergeSync(local(), state(), remote({ certs: { 'kvm-a.local': { updatedAt: old, deletedAt: old } } }), NOW);
    expect(m.remote.certs).toEqual({});
  });

  it('merges settings as one item and reports no change when identical', () => {
    const newer = { ...DEFAULT_SETTINGS, general: { ...DEFAULT_SETTINGS.general, captureIndicator: false } };
    const m = mergeSync(local(), state({ settings: 1 }), remote({ settings: { updatedAt: 2, data: newer } }), NOW);
    expect(m.local.settings.general.captureIndicator).toBe(false);
    expect(m.changed.settings).toBe(true);

    const same = mergeSync(local(), state(), remote(), NOW);
    expect(same.remote.settings).toEqual({ updatedAt: 0, data: DEFAULT_SETTINGS });
    expect(same.changed).toEqual({ devices: false, settings: false, certs: false, secrets: false });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run --maxWorkers=2 test/shared/sync-merge.test.ts`
Expected: FAIL — cannot resolve `../../src/shared/sync/merge`.

- [ ] **Step 3: Implement `src/shared/sync/merge.ts`**

```ts
import type { Device, Settings } from '../types';
import type { TrustStore } from '../certs';
import {
  MARKER_TTL_MS, canonicalJson, isLive, type Entry, type Stamped, type SyncState, type Tombstone,
} from './format';

export interface LocalSnapshot {
  devices: Device[];
  settings: Settings;
  certs: TrustStore;
  secrets: Record<string, string> | null;
}

export interface RemoteView {
  settings: Stamped<Settings> | null;
  devices: Record<string, Entry<Device>>;
  certs: Record<string, Entry<string>>;
  secrets: Record<string, Entry<string>> | null;
}

export interface MergeResult {
  remote: {
    settings: Stamped<Settings>;
    devices: Record<string, Entry<Device>>;
    certs: Record<string, Entry<string>>;
    secrets: Record<string, Entry<string>> | null;
  };
  local: LocalSnapshot;
  state: SyncState;
  changed: { devices: boolean; settings: boolean; certs: boolean; secrets: boolean };
}

interface Collection<T> {
  entries: Record<string, Entry<T>>;
  items: Record<string, T>;
  stamps: Record<string, number>;
  deleted: Record<string, number>;
}

const has = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);
const tombstone = (at: number): Tombstone => ({ updatedAt: at, deletedAt: at });

function setEntry<T>(c: Collection<T>, k: string, e: Entry<T>): void {
  c.entries[k] = e;
  delete c.items[k]; delete c.stamps[k]; delete c.deleted[k];
  if (isLive(e)) { c.items[k] = e.data; c.stamps[k] = e.updatedAt; }
  else c.deleted[k] = e.updatedAt;
}

function mergeCollection<T>(
  items: Record<string, T>, stamps: Record<string, number>, deleted: Record<string, number>,
  remote: Record<string, Entry<T>>,
): Collection<T> {
  const out: Collection<T> = { entries: {}, items: {}, stamps: {}, deleted: {} };
  const keys = new Set([...Object.keys(items), ...Object.keys(deleted), ...Object.keys(remote)]);
  for (const k of keys) {
    let mine: Entry<T> | undefined;
    if (has(items, k)) mine = { updatedAt: has(stamps, k) ? stamps[k] : 0, data: items[k] };
    else if (has(deleted, k)) mine = tombstone(deleted[k]);
    const theirs = has(remote, k) ? remote[k] : undefined;
    const winner = !mine ? theirs! : !theirs ? mine : mine.updatedAt > theirs.updatedAt ? mine : theirs;
    setEntry(out, k, winner);
  }
  return out;
}

function expire<T>(c: Collection<T>, cutoff: number): void {
  for (const [k, e] of Object.entries(c.entries)) {
    if (!isLive(e) && e.updatedAt < cutoff) { delete c.entries[k]; delete c.deleted[k]; }
  }
}

export function mergeSync(local: LocalSnapshot, state: SyncState, remote: RemoteView, now: number): MergeResult {
  const mySettings: Stamped<Settings> = { updatedAt: state.settings, data: local.settings };
  const settings = remote.settings && remote.settings.updatedAt >= mySettings.updatedAt ? remote.settings : mySettings;

  const devices = mergeCollection(
    Object.fromEntries(local.devices.map(d => [d.id, d])), state.devices, state.deleted.devices, remote.devices,
  );
  const certs = mergeCollection(local.certs, state.certs, state.deleted.certs, remote.certs);
  const secrets = local.secrets && remote.secrets
    ? mergeCollection(local.secrets, state.secrets, state.deleted.secrets, remote.secrets)
    : null;

  const byAddress = new Map<string, string>();
  for (const id of Object.keys(devices.items).sort()) {
    const address = devices.items[id].address;
    const otherId = byAddress.get(address);
    if (otherId === undefined) { byAddress.set(address, id); continue; }
    const [keep, drop] = devices.stamps[id] > devices.stamps[otherId] ? [id, otherId] : [otherId, id];
    const at = devices.stamps[keep];
    byAddress.set(address, keep);
    if (secrets && has(secrets.items, drop) && !has(secrets.items, keep)) {
      setEntry(secrets, keep, { updatedAt: at, data: secrets.items[drop] });
    }
    setEntry(devices, drop, tombstone(at));
  }

  if (secrets) {
    for (const [id, e] of Object.entries(devices.entries)) {
      if (!isLive(e) && has(secrets.items, id) && secrets.stamps[id] <= e.updatedAt) {
        setEntry(secrets, id, tombstone(e.updatedAt));
      }
    }
  }

  const cutoff = now - MARKER_TTL_MS;
  expire(devices, cutoff);
  expire(certs, cutoff);
  if (secrets) expire(secrets, cutoff);

  const localIds = new Set(local.devices.map(d => d.id));
  const nextDevices = [
    ...local.devices.filter(d => has(devices.items, d.id)).map(d => devices.items[d.id]),
    ...Object.values(devices.items)
      .filter(d => !localIds.has(d.id))
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)),
  ];

  return {
    remote: { settings, devices: devices.entries, certs: certs.entries, secrets: secrets ? secrets.entries : null },
    local: { devices: nextDevices, settings: settings.data, certs: certs.items, secrets: secrets ? secrets.items : local.secrets },
    state: {
      settings: settings.updatedAt,
      devices: devices.stamps,
      certs: certs.stamps,
      secrets: secrets ? secrets.stamps : state.secrets,
      deleted: {
        devices: devices.deleted,
        certs: certs.deleted,
        secrets: secrets ? secrets.deleted : state.deleted.secrets,
      },
    },
    changed: {
      devices: canonicalJson(nextDevices) !== canonicalJson(local.devices),
      settings: canonicalJson(settings.data) !== canonicalJson(local.settings),
      certs: canonicalJson(certs.items) !== canonicalJson(local.certs),
      secrets: !!secrets && canonicalJson(secrets.items) !== canonicalJson(local.secrets),
    },
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run --maxWorkers=2 test/shared/sync-merge.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add src/shared/sync/merge.ts test/shared/sync-merge.test.ts
git commit -m "feat(sync): per-item merge with deletion markers"
```

---

### Task 3: Encryption

**Files:**
- Create: `src/main/services/sync/crypto.ts`
- Test: `test/main/sync-crypto.test.ts`

**Interfaces:**
- Consumes: `CryptoHeader`, `EncryptedBlob` from Task 1.
- Produces:
  - `CHECK_PLAINTEXT`, `KDF_PARAMS = { N: 32768, r: 8, p: 1 }`, `MIN_PASSPHRASE_LENGTH = 8`
  - `interface SyncKey { keyId: string; key: Buffer }`
  - `encrypt(key: Buffer, plaintext: string): EncryptedBlob`
  - `decrypt(key: Buffer, blob: EncryptedBlob): string` (throws on wrong key or tampering)
  - `createHeader(passphrase: string, kdf?: { N: number; r: number; p: number }): { header: CryptoHeader; key: SyncKey }`
  - `unlock(passphrase: string, header: CryptoHeader): SyncKey | null`
  - `serializeKey(k: SyncKey): string`, `parseKey(raw: string | null): SyncKey | null`

- [ ] **Step 1: Write the failing tests**

Create `test/main/sync-crypto.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  createHeader, decrypt, encrypt, parseKey, serializeKey, unlock, KDF_PARAMS,
} from '../../src/main/services/sync/crypto';

const FAST = { N: 1024, r: 8, p: 1 };

describe('sync crypto', () => {
  it('round-trips with the right key and rejects tampering', () => {
    const { key } = createHeader('correct horse', FAST);
    const blob = encrypt(key.key, 'hunter2');
    expect(blob.ct).not.toContain('hunter2');
    expect(decrypt(key.key, blob)).toBe('hunter2');
    const flipped = Buffer.from(blob.ct, 'base64');
    flipped[0] ^= 1;
    expect(() => decrypt(key.key, { ...blob, ct: flipped.toString('base64') })).toThrow();
    expect(() => decrypt(key.key, { ...blob, tag: Buffer.from('short').toString('base64') })).toThrow();
  });

  it('unlocks with the right passphrase only', () => {
    const { header, key } = createHeader('correct horse', FAST);
    const unlocked = unlock('correct horse', header);
    expect(unlocked?.keyId).toBe(header.keyId);
    expect(unlocked?.key.equals(key.key)).toBe(true);
    expect(unlock('wrong horse', header)).toBeNull();
  });

  it('gives a new salt and keyId every time', () => {
    const a = createHeader('same passphrase', FAST);
    const b = createHeader('same passphrase', FAST);
    expect(a.header.salt).not.toBe(b.header.salt);
    expect(a.header.keyId).not.toBe(b.header.keyId);
    expect(() => decrypt(b.key.key, encrypt(a.key.key, 'x'))).toThrow();
  });

  it('uses the spec parameters by default', () => {
    const { header } = createHeader('correct horse');
    expect({ N: header.N, r: header.r, p: header.p }).toEqual(KDF_PARAMS);
    expect(Buffer.from(header.salt, 'base64')).toHaveLength(16);
  });

  it('serializes keys and rejects malformed ones', () => {
    const { key } = createHeader('correct horse', FAST);
    const back = parseKey(serializeKey(key));
    expect(back?.keyId).toBe(key.keyId);
    expect(back?.key.equals(key.key)).toBe(true);
    expect(parseKey(null)).toBeNull();
    expect(parseKey('{"keyId":"x","key":"c2hvcnQ="}')).toBeNull();
    expect(parseKey('garbage')).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run --maxWorkers=2 test/main/sync-crypto.test.ts`
Expected: FAIL — cannot resolve the module.

- [ ] **Step 3: Implement `src/main/services/sync/crypto.ts`**

```ts
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import type { CryptoHeader, EncryptedBlob } from '@shared/sync/format';

export const CHECK_PLAINTEXT = 'glkvm-sync-check';
export const KDF_PARAMS = { N: 1 << 15, r: 8, p: 1 };
export const MIN_PASSPHRASE_LENGTH = 8;
const KEY_BYTES = 32;

export interface SyncKey { keyId: string; key: Buffer; }

function deriveKey(passphrase: string, h: { salt: string; N: number; r: number; p: number }): Buffer {
  return scryptSync(passphrase.normalize('NFC'), Buffer.from(h.salt, 'base64'), KEY_BYTES, {
    N: h.N, r: h.r, p: h.p, maxmem: 256 * 1024 * 1024,
  });
}

export function encrypt(key: Buffer, plaintext: string): EncryptedBlob {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ct: ct.toString('base64') };
}

export function decrypt(key: Buffer, blob: EncryptedBlob): string {
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(blob.iv, 'base64'), { authTagLength: 16 });
  decipher.setAuthTag(Buffer.from(blob.tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(blob.ct, 'base64')), decipher.final()]).toString('utf8');
}

export function createHeader(passphrase: string, kdf = KDF_PARAMS): { header: CryptoHeader; key: SyncKey } {
  const salt = randomBytes(16).toString('base64');
  const keyId = randomBytes(12).toString('hex');
  const key = deriveKey(passphrase, { salt, ...kdf });
  return {
    header: { keyId, kdf: 'scrypt', salt, ...kdf, check: encrypt(key, CHECK_PLAINTEXT) },
    key: { keyId, key },
  };
}

export function unlock(passphrase: string, header: CryptoHeader): SyncKey | null {
  const key = deriveKey(passphrase, header);
  try {
    return decrypt(key, header.check) === CHECK_PLAINTEXT ? { keyId: header.keyId, key } : null;
  } catch {
    return null;
  }
}

export function serializeKey(k: SyncKey): string {
  return JSON.stringify({ keyId: k.keyId, key: k.key.toString('base64') });
}

export function parseKey(raw: string | null): SyncKey | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as { keyId?: unknown; key?: unknown };
    if (typeof v.keyId !== 'string' || typeof v.key !== 'string') return null;
    const key = Buffer.from(v.key, 'base64');
    return key.length === KEY_BYTES ? { keyId: v.keyId, key } : null;
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run --maxWorkers=2 test/main/sync-crypto.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/main/services/sync/crypto.ts test/main/sync-crypto.test.ts
git commit -m "feat(sync): passphrase key derivation and AES-GCM encryption"
```

---

### Task 4: Encrypted single-value file

**Files:**
- Create: `src/main/services/sealedFile.ts`
- Test: `test/main/sealedFile.test.ts`

**Interfaces:**
- Consumes: `SafeStorageLike` from `src/main/services/secrets.ts`.
- Produces: `interface SealedFile { read(): string | null; write(value: string): void; clear(): void; persistent(): boolean }` and `createSealedFile(file: string, safe: SafeStorageLike): SealedFile`. Used for `github-auth.json` and `sync-key.json`.

- [ ] **Step 1: Write the failing tests**

Create `test/main/sealedFile.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSealedFile } from '../../src/main/services/sealedFile';
import type { SafeStorageLike } from '../../src/main/services/secrets';

function fakeSafe(available = true): SafeStorageLike {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (p) => Buffer.from('ENC:' + Buffer.from(p).toString('base64'), 'utf8'),
    decryptString: (c) => {
      const s = c.toString('utf8');
      if (!s.startsWith('ENC:')) throw new Error('bad cipher');
      return Buffer.from(s.slice(4), 'base64').toString('utf8');
    },
  };
}

let file: string;
beforeEach(() => { file = join(mkdtempSync(join(tmpdir(), 'glkvm-sealed-')), 'value.json'); });

describe('sealed file', () => {
  it('persists only ciphertext and reads it back in a new instance', () => {
    createSealedFile(file, fakeSafe()).write('token-123');
    expect(readFileSync(file, 'utf8')).not.toContain('token-123');
    expect(createSealedFile(file, fakeSafe()).read()).toBe('token-123');
  });

  it('keeps the value in memory only when encryption is unavailable', () => {
    const s = createSealedFile(file, fakeSafe(false));
    s.write('token-123');
    expect(s.read()).toBe('token-123');
    expect(s.persistent()).toBe(false);
    expect(existsSync(file)).toBe(false);
  });

  it('clears the value and file, and returns null for corrupt files', () => {
    const s = createSealedFile(file, fakeSafe());
    s.write('token-123');
    s.clear();
    expect(s.read()).toBeNull();
    expect(existsSync(file)).toBe(false);
    writeFileSync(file, 'not encrypted');
    expect(createSealedFile(file, fakeSafe()).read()).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run --maxWorkers=2 test/main/sealedFile.test.ts`
Expected: FAIL — cannot resolve the module.

- [ ] **Step 3: Implement `src/main/services/sealedFile.ts`**

```ts
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import type { SafeStorageLike } from './secrets';

export interface SealedFile {
  read(): string | null;
  write(value: string): void;
  clear(): void;
  /** False when the OS keychain is unavailable and the value lives only for this session. */
  persistent(): boolean;
}

export function createSealedFile(file: string, safe: SafeStorageLike): SealedFile {
  let memory: string | null = null;
  return {
    persistent: () => safe.isEncryptionAvailable(),
    read() {
      if (memory !== null) return memory;
      if (!safe.isEncryptionAvailable() || !existsSync(file)) return null;
      try {
        memory = safe.decryptString(readFileSync(file));
        return memory;
      } catch {
        return null;
      }
    },
    write(value) {
      memory = value;
      if (!safe.isEncryptionAvailable()) return;
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, safe.encryptString(value));
      renameSync(tmp, file);
    },
    clear() {
      memory = null;
      rmSync(file, { force: true });
    },
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run --maxWorkers=2 test/main/sealedFile.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/main/services/sealedFile.ts test/main/sealedFile.test.ts
git commit -m "feat(sync): safeStorage-encrypted single value file"
```

---

### Task 5: Change events and sync-apply methods on the store and secrets store

**Files:**
- Modify: `src/main/services/store.ts` (whole file shown below)
- Modify: `src/main/services/secrets.ts`
- Test: `test/main/store-events.test.ts`

**Interfaces:**
- Consumes: `ChangeEvent` from Task 1.
- Produces:
  - Store: `onChange(listener: (e: ChangeEvent) => void): void`; `applySynced(next: { devices?: Device[]; settings?: Settings; certs?: TrustStore }): void` (persists, emits nothing).
  - `SecretsStore` interface gains `onChange(listener: (e: ChangeEvent) => void): void` and `replaceAll(passwords: Record<string, string>): void` (persists, emits nothing, no-op when encryption is unavailable).
  - Events: `addDevice`/`updateDevice` → `device`; `removeDevice` (existing id only) → `device-removed`; `setSettings` → `settings`; `trustCert` → `cert`; `untrustHost` (existing host only) → `cert-removed`; `applyImport` → `device` per resulting device, `device-removed` per device no longer present, and `settings`; `secrets.set` success → `secret`; `secrets.clear` (existing id only) → `secret-removed`.

- [ ] **Step 1: Write the failing tests**

Create `test/main/store-events.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../../src/main/services/store';
import { createSecretsStore, type SafeStorageLike } from '../../src/main/services/secrets';
import { DEFAULT_SETTINGS } from '../../src/shared/schema';
import type { ChangeEvent } from '../../src/shared/sync/format';

const safe: SafeStorageLike = {
  isEncryptionAvailable: () => true,
  encryptString: (p) => Buffer.from('ENC:' + p, 'utf8'),
  decryptString: (c) => c.toString('utf8').slice(4),
};

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'glkvm-ev-')); });

describe('store change events', () => {
  it('emits an event for every user-facing mutation', () => {
    const s = createStore(dir);
    const events: ChangeEvent[] = [];
    s.onChange(e => events.push(e));
    const d = s.addDevice({ name: 'Lab', address: 'kvm-a.local' });
    s.updateDevice(d.id, { name: 'Lab 2' });
    s.setSettings(DEFAULT_SETTINGS);
    s.trustCert('kvm-a.local', 'AB');
    s.untrustHost('kvm-a.local');
    s.untrustHost('never-trusted.local');
    s.removeDevice(d.id);
    s.removeDevice('missing');
    expect(events).toEqual([
      { kind: 'device', id: d.id }, { kind: 'device', id: d.id }, { kind: 'settings' },
      { kind: 'cert', host: 'kvm-a.local' }, { kind: 'cert-removed', host: 'kvm-a.local' },
      { kind: 'device-removed', id: d.id },
    ]);
  });

  it('emits for backup imports, including devices removed by replace', () => {
    const s = createStore(dir);
    const a = s.addDevice({ name: 'A', address: 'kvm-a.local' });
    const b = { ...a, id: 'b-id', address: 'kvm-b.local', url: 'https://kvm-b.local' };
    const events: ChangeEvent[] = [];
    s.onChange(e => events.push(e));
    s.applyImport({ version: 1, devices: [b], settings: DEFAULT_SETTINGS }, 'replace');
    expect(events).toEqual([
      { kind: 'device', id: 'b-id' }, { kind: 'device-removed', id: a.id }, { kind: 'settings' },
    ]);
  });

  it('applySynced persists without emitting', () => {
    const s = createStore(dir);
    const events: ChangeEvent[] = [];
    s.onChange(e => events.push(e));
    const dev = { id: 'x', name: 'X', address: 'kvm-x.local', url: 'https://kvm-x.local', os: 'linux' as const, createdAt: 1 };
    s.applySynced({ devices: [dev], certs: { 'kvm-x.local': 'CD' } });
    expect(events).toEqual([]);
    const reloaded = createStore(dir);
    expect(reloaded.getDevices()).toEqual([dev]);
    expect(reloaded.getTrustStore()).toEqual({ 'kvm-x.local': 'CD' });
  });
});

describe('secrets change events', () => {
  it('emits on set and clear, and replaceAll persists silently', () => {
    const s = createSecretsStore(dir, safe);
    const events: ChangeEvent[] = [];
    s.onChange(e => events.push(e));
    s.set('a', 'pw-a');
    s.clear('a');
    s.clear('missing');
    s.replaceAll({ b: 'pw-b', c: 'pw-c' });
    expect(events).toEqual([{ kind: 'secret', id: 'a' }, { kind: 'secret-removed', id: 'a' }]);
    const reloaded = createSecretsStore(dir, safe);
    expect(reloaded.ids().sort()).toEqual(['b', 'c']);
    expect(reloaded.get('b')).toBe('pw-b');
    reloaded.replaceAll({ c: 'pw-c2' });
    expect(reloaded.ids()).toEqual(['c']);
    expect(reloaded.get('c')).toBe('pw-c2');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run --maxWorkers=2 test/main/store-events.test.ts`
Expected: FAIL — `s.onChange is not a function`.

- [ ] **Step 3: Replace `src/main/services/store.ts` with the event-emitting version**

The helpers `readJson` and `writeJsonAtomic` at the top of the file stay exactly as they are. Replace the imports block and the `createStore` function with:

```ts
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Device, Settings, BackupBundle, OsKind } from '@shared/types';
import { DEFAULT_SETTINGS, validateDevices, validateSettings, coerceOs } from '@shared/schema';
import { toDeviceUrl, normalizeAddress } from '@shared/url';
import { applyBackup, buildBackup } from '@shared/backup';
import type { TrustStore } from '@shared/certs';
import type { ChangeEvent } from '@shared/sync/format';
```

```ts
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

  const listeners: Array<(e: ChangeEvent) => void> = [];
  const emit = (e: ChangeEvent) => { for (const l of listeners) l(e); };

  return {
    onChange(listener: (e: ChangeEvent) => void) { listeners.push(listener); },
    getDevices: () => devices,
    addDevice(input: { name: string; address: string; color?: string; os?: OsKind }): Device {
      const address = normalizeAddress(input.address);
      const d: Device = {
        id: randomUUID(), name: input.name, address, url: toDeviceUrl(address),
        color: input.color, createdAt: Date.now(), os: coerceOs(input.os),
      };
      devices = [...devices, d];
      saveDevices();
      emit({ kind: 'device', id: d.id });
      return d;
    },
    updateDevice(id: string, patch: Partial<Pick<Device, 'name' | 'address' | 'color' | 'os'>>): Device | null {
      const i = devices.findIndex(d => d.id === id);
      if (i === -1) return null;
      const address = patch.address ? normalizeAddress(patch.address) : devices[i].address;
      const updated: Device = { ...devices[i], ...patch, address, url: toDeviceUrl(address), os: coerceOs(patch.os ?? devices[i].os) };
      devices = devices.map(d => d.id === id ? updated : d);
      saveDevices();
      emit({ kind: 'device', id });
      return updated;
    },
    removeDevice(id: string) {
      const existed = devices.some(d => d.id === id);
      devices = devices.filter(d => d.id !== id);
      saveDevices();
      if (existed) emit({ kind: 'device-removed', id });
    },
    getSettings: () => settings,
    setSettings(next: Settings) { settings = validateSettings(next); saveSettings(); emit({ kind: 'settings' }); },
    getTrustStore: () => trust,
    trustCert(host: string, fingerprint: string) {
      trust = { ...trust, [host]: fingerprint };
      saveTrust();
      emit({ kind: 'cert', host });
    },
    untrustHost(host: string) {
      if (!(host in trust)) return;
      const next = { ...trust };
      delete next[host];
      trust = next;
      saveTrust();
      emit({ kind: 'cert-removed', host });
    },
    applyImport(bundle: BackupBundle, mode: 'merge' | 'replace') {
      const before = devices.map(d => d.id);
      const out = applyBackup({ devices, settings }, bundle, mode);
      devices = out.devices; settings = out.settings;
      saveDevices(); saveSettings();
      const after = new Set(devices.map(d => d.id));
      for (const d of devices) emit({ kind: 'device', id: d.id });
      for (const id of before) if (!after.has(id)) emit({ kind: 'device-removed', id });
      emit({ kind: 'settings' });
    },
    exportBundle: (): BackupBundle => buildBackup(devices, settings),
    /** Sync-only: replace local data with merged results. Deliberately emits no change events. */
    applySynced(next: { devices?: Device[]; settings?: Settings; certs?: TrustStore }) {
      if (next.devices) { devices = validateDevices(next.devices); saveDevices(); }
      if (next.settings) { settings = validateSettings(next.settings); saveSettings(); }
      if (next.certs) { trust = { ...next.certs }; saveTrust(); }
    },
  };
}
```

- [ ] **Step 4: Update `src/main/services/secrets.ts`**

Add the import at the top:

```ts
import type { ChangeEvent } from '@shared/sync/format';
```

Add to the `SecretsStore` interface, after `ids(): string[];`:

```ts
  onChange(listener: (e: ChangeEvent) => void): void;
  /** Sync-only: make the stored set exactly `passwords`. Emits no change events. No-op without encryption. */
  replaceAll(passwords: Record<string, string>): void;
```

Inside `createSecretsStore`, after `const save = () => writeJsonAtomic(file, data);`, add:

```ts
  const listeners: Array<(e: ChangeEvent) => void> = [];
  const emit = (e: ChangeEvent) => { for (const l of listeners) l(e); };
  const decryptOrNull = (b64: string | undefined): string | null => {
    if (!b64) return null;
    try { return safe.decryptString(Buffer.from(b64, 'base64')); } catch { return null; }
  };
```

Replace the returned object with:

```ts
  return {
    isAvailable: () => safe.isEncryptionAvailable(),
    set(deviceId, password) {
      if (!safe.isEncryptionAvailable()) return false;
      data = { ...data, [deviceId]: safe.encryptString(password).toString('base64') };
      save();
      emit({ kind: 'secret', id: deviceId });
      return true;
    },
    get: (deviceId) => decryptOrNull(data[deviceId]),
    has: (deviceId) => typeof data[deviceId] === 'string' && data[deviceId].length > 0,
    clear(deviceId) {
      if (!(deviceId in data)) return;
      const next = { ...data };
      delete next[deviceId];
      data = next;
      save();
      emit({ kind: 'secret-removed', id: deviceId });
    },
    ids: () => Object.keys(data),
    onChange(listener) { listeners.push(listener); },
    replaceAll(passwords) {
      if (!safe.isEncryptionAvailable()) return;
      const next: SecretsFile = {};
      for (const [id, pw] of Object.entries(passwords)) {
        next[id] = decryptOrNull(data[id]) === pw ? data[id] : safe.encryptString(pw).toString('base64');
      }
      data = next;
      save();
    },
  };
```

- [ ] **Step 5: Run the new and existing store/secrets tests**

Run: `npx vitest run --maxWorkers=2 test/main/store-events.test.ts test/main/store.test.ts test/main/secrets.test.ts`
Expected: PASS (all).

- [ ] **Step 6: Commit**

```bash
git add src/main/services/store.ts src/main/services/secrets.ts test/main/store-events.test.ts
git commit -m "feat(sync): change events and sync apply methods on stores"
```

---

### Task 6: GitHub API helpers and device-flow auth

**Files:**
- Create: `src/main/services/github/api.ts`
- Create: `src/main/services/github/auth.ts`
- Test: `test/main/github-auth.test.ts`

**Interfaces:**
- Consumes: `SealedFile` (Task 4), `GithubUser` (Task 1).
- Produces:
  - `api.ts`: `type FetchLike`, `interface GithubResponse { status: number; data: unknown }`, `githubApi(fetchFn: FetchLike, token: string, method: string, path: string, body?: unknown): Promise<GithubResponse>` (rejects only on network failure), `postForm(fetchFn: FetchLike, url: string, fields: Record<string, string>): Promise<Record<string, unknown>>`, `asRecord(v: unknown): Record<string, unknown> | null`.
  - `auth.ts`: `GITHUB_CLIENT_ID`, `GITHUB_SCOPES`, `interface DeviceCodeInfo { userCode: string; verificationUri: string; expiresIn: number }`, `interface AuthDeps`, `interface GithubAuth { configured(): boolean; getUser(): GithubUser | null; getToken(): string | null; start(): Promise<DeviceCodeInfo>; openVerification(): void; cancel(): void; signOut(): void; onChange(cb: (user: GithubUser | null) => void): void; onError(cb: (message: string) => void): void }`, `createGithubAuth(deps: AuthDeps): GithubAuth`, `pollForToken(...)`.

- [ ] **Step 1: Write the failing tests**

Create `test/main/github-auth.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { createGithubAuth, pollForToken } from '../../src/main/services/github/auth';
import type { FetchLike } from '../../src/main/services/github/api';
import type { SealedFile } from '../../src/main/services/sealedFile';

type Reply = { status?: number; body: unknown } | Error;

function fakeFetch(routes: Record<string, Reply[]>) {
  const calls: Array<{ url: string; body?: string }> = [];
  const fn: FetchLike = async (url, init) => {
    calls.push({ url, body: init?.body });
    const queue = routes[url];
    const next = queue && (queue.length > 1 ? queue.shift()! : queue[0]);
    if (!next) throw new Error(`unexpected ${url}`);
    if (next instanceof Error) throw next;
    const text = JSON.stringify(next.body);
    return { status: next.status ?? 200, json: async () => next.body, text: async () => text };
  };
  return { fn, calls };
}

function memorySealed(): SealedFile & { value: string | null } {
  const s = {
    value: null as string | null,
    read: () => s.value,
    write: (v: string) => { s.value = v; },
    clear: () => { s.value = null; },
    persistent: () => true,
  };
  return s;
}

const DEVICE = 'https://github.com/login/device/code';
const TOKEN = 'https://github.com/login/oauth/access_token';
const USER = 'https://api.github.com/user';

describe('pollForToken', () => {
  it('keeps polling through pending, network errors and slow_down', async () => {
    const { fn } = fakeFetch({
      [TOKEN]: [
        { body: { error: 'authorization_pending' } }, new Error('offline'),
        { body: { error: 'slow_down' } }, { body: { access_token: 'tok' } },
      ],
    });
    const waits: number[] = [];
    let t = 0;
    const r = await pollForToken({
      fetch: fn, clientId: 'cid', deviceCode: 'dc', intervalSec: 5, expiresInSec: 900,
      sleep: async (ms) => { waits.push(ms); t += ms; }, now: () => t, isCancelled: () => false,
    });
    expect(r).toEqual({ token: 'tok' });
    expect(waits).toEqual([5000, 5000, 5000, 10000]);
  });

  it('reports denial, expiry and cancellation', async () => {
    const base = { clientId: 'cid', deviceCode: 'dc', intervalSec: 5, sleep: async () => {}, now: () => 0 };
    const denied = fakeFetch({ [TOKEN]: [{ body: { error: 'access_denied' } }] });
    expect(await pollForToken({ ...base, fetch: denied.fn, expiresInSec: 900, isCancelled: () => false }))
      .toEqual({ error: 'Sign-in was cancelled on GitHub.' });
    const expired = fakeFetch({ [TOKEN]: [{ body: { error: 'expired_token' } }] });
    expect(await pollForToken({ ...base, fetch: expired.fn, expiresInSec: 900, isCancelled: () => false }))
      .toEqual({ error: 'The sign-in code expired. Try again.' });
    expect(await pollForToken({ ...base, fetch: denied.fn, expiresInSec: 900, isCancelled: () => true }))
      .toEqual({ cancelled: true });
  });
});

describe('createGithubAuth', () => {
  it('signs in, stores the session sealed, and signs out', async () => {
    const { fn, calls } = fakeFetch({
      [DEVICE]: [{ body: { device_code: 'dc', user_code: 'ABCD-1234', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 5 } }],
      [TOKEN]: [{ body: { error: 'authorization_pending' } }, { body: { access_token: 'tok' } }],
      [USER]: [{ body: { login: 'octocat', name: 'Mona', avatar_url: 'https://avatars.githubusercontent.com/u/1' } }],
    });
    const sealed = memorySealed();
    const opened: string[] = [];
    const auth = createGithubAuth({ fetch: fn, sealed, clientId: 'cid', openExternal: (u) => opened.push(u), sleep: async () => {} });
    const changes: unknown[] = [];
    auth.onChange((u) => changes.push(u));

    const info = await auth.start();
    expect(info).toEqual({ userCode: 'ABCD-1234', verificationUri: 'https://github.com/login/device', expiresIn: 900 });
    expect(opened).toEqual(['https://github.com/login/device']);
    expect(calls[0].body).toContain('scope=repo+read%3Auser');

    await vi.waitFor(() => expect(auth.getUser()?.login).toBe('octocat'));
    expect(auth.getToken()).toBe('tok');
    expect(JSON.parse(sealed.value!)).toEqual({ token: 'tok', user: { login: 'octocat', name: 'Mona', avatarUrl: 'https://avatars.githubusercontent.com/u/1' } });

    const reloaded = createGithubAuth({ fetch: fn, sealed, clientId: 'cid', openExternal: () => {} });
    expect(reloaded.getToken()).toBe('tok');

    auth.signOut();
    expect(auth.getToken()).toBeNull();
    expect(sealed.value).toBeNull();
    expect(changes).toEqual([expect.objectContaining({ login: 'octocat' }), null]);
  });

  it('reports poll errors, ignores untrusted verification URLs, and refuses when unconfigured', async () => {
    const { fn } = fakeFetch({
      [DEVICE]: [{ body: { device_code: 'dc', user_code: 'X', verification_uri: 'https://evil.example/', expires_in: 900 } }],
      [TOKEN]: [{ body: { error: 'access_denied' } }],
    });
    const opened: string[] = [];
    const auth = createGithubAuth({ fetch: fn, sealed: memorySealed(), clientId: 'cid', openExternal: (u) => opened.push(u), sleep: async () => {} });
    const errors: string[] = [];
    auth.onError((m) => errors.push(m));
    await auth.start();
    expect(opened).toEqual(['https://github.com/login/device']);
    await vi.waitFor(() => expect(errors).toEqual(['Sign-in was cancelled on GitHub.']));

    const unconfigured = createGithubAuth({ fetch: fn, sealed: memorySealed(), clientId: '', openExternal: () => {} });
    expect(unconfigured.configured()).toBe(false);
    await expect(unconfigured.start()).rejects.toThrow('GitHub sign-in is not configured');
  });

  it('cancel stops a pending sign-in from completing', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const { fn } = fakeFetch({
      [DEVICE]: [{ body: { device_code: 'dc', user_code: 'X', verification_uri: 'https://github.com/login/device', expires_in: 900 } }],
      [TOKEN]: [{ body: { access_token: 'tok' } }],
      [USER]: [{ body: { login: 'octocat' } }],
    });
    const auth = createGithubAuth({ fetch: fn, sealed: memorySealed(), clientId: 'cid', openExternal: () => {}, sleep: () => gate });
    await auth.start();
    auth.cancel();
    release();
    await new Promise((r) => setTimeout(r, 10));
    expect(auth.getToken()).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run --maxWorkers=2 test/main/github-auth.test.ts`
Expected: FAIL — cannot resolve the modules.

- [ ] **Step 3: Implement `src/main/services/github/api.ts`**

```ts
export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{ status: number; json(): Promise<unknown>; text(): Promise<string> }>;

export interface GithubResponse { status: number; data: unknown; }

const USER_AGENT = 'GLKVM';

export const asRecord = (v: unknown): Record<string, unknown> | null =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : null;

/** Calls api.github.com. Resolves for every HTTP status; rejects only when the request can't be made. */
export async function githubApi(
  fetchFn: FetchLike, token: string, method: string, path: string, body?: unknown,
): Promise<GithubResponse> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'User-Agent': USER_AGENT,
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetchFn(`https://api.github.com${path}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data: unknown = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, data };
}

export async function postForm(fetchFn: FetchLike, url: string, fields: Record<string, string>): Promise<Record<string, unknown>> {
  const res = await fetchFn(url, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': USER_AGENT },
    body: new URLSearchParams(fields).toString(),
  });
  return asRecord(await res.json()) ?? {};
}
```

- [ ] **Step 4: Implement `src/main/services/github/auth.ts`**

```ts
import { asRecord, githubApi, postForm, type FetchLike } from './api';
import type { SealedFile } from '../sealedFile';
import type { GithubUser } from '@shared/sync/format';

export const GITHUB_CLIENT_ID = process.env.GLKVM_GH_CLIENT_ID || '';
export const GITHUB_SCOPES = 'repo read:user';
const DEFAULT_VERIFICATION_URI = 'https://github.com/login/device';
const EXPIRED = 'The sign-in code expired. Try again.';

export interface DeviceCodeInfo { userCode: string; verificationUri: string; expiresIn: number; }

export interface AuthDeps {
  fetch: FetchLike;
  sealed: SealedFile;
  clientId: string;
  openExternal(url: string): void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface GithubAuth {
  configured(): boolean;
  getUser(): GithubUser | null;
  getToken(): string | null;
  start(): Promise<DeviceCodeInfo>;
  openVerification(): void;
  cancel(): void;
  signOut(): void;
  onChange(cb: (user: GithubUser | null) => void): void;
  onError(cb: (message: string) => void): void;
}

type PollResult = { token: string } | { error: string } | { cancelled: true };

export async function pollForToken(opts: {
  fetch: FetchLike; clientId: string; deviceCode: string; intervalSec: number; expiresInSec: number;
  sleep: (ms: number) => Promise<void>; now: () => number; isCancelled: () => boolean;
}): Promise<PollResult> {
  let intervalMs = Math.max(opts.intervalSec, 5) * 1000;
  const deadline = opts.now() + opts.expiresInSec * 1000;
  for (;;) {
    await opts.sleep(intervalMs);
    if (opts.isCancelled()) return { cancelled: true };
    if (opts.now() >= deadline) return { error: EXPIRED };
    let res: Record<string, unknown>;
    try {
      res = await postForm(opts.fetch, 'https://github.com/login/oauth/access_token', {
        client_id: opts.clientId, device_code: opts.deviceCode, grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      });
    } catch {
      continue;
    }
    if (opts.isCancelled()) return { cancelled: true };
    if (typeof res.access_token === 'string') return { token: res.access_token };
    if (res.error === 'authorization_pending') continue;
    if (res.error === 'slow_down') { intervalMs += 5000; continue; }
    if (res.error === 'access_denied') return { error: 'Sign-in was cancelled on GitHub.' };
    if (res.error === 'expired_token') return { error: EXPIRED };
    return { error: typeof res.error_description === 'string' ? res.error_description : 'GitHub sign-in failed.' };
  }
}

interface Session { token: string; user: GithubUser; }

function parseSession(raw: string | null): Session | null {
  if (!raw) return null;
  try {
    const v = asRecord(JSON.parse(raw));
    const u = asRecord(v?.user);
    if (!v || !u || typeof v.token !== 'string' || typeof u.login !== 'string') return null;
    return {
      token: v.token,
      user: { login: u.login, name: typeof u.name === 'string' ? u.name : u.login, avatarUrl: typeof u.avatarUrl === 'string' ? u.avatarUrl : '' },
    };
  } catch {
    return null;
  }
}

export function createGithubAuth(deps: AuthDeps): GithubAuth {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;
  let session = parseSession(deps.sealed.read());
  let generation = 0;
  let verificationUri = DEFAULT_VERIFICATION_URI;
  const changeListeners: Array<(user: GithubUser | null) => void> = [];
  const errorListeners: Array<(message: string) => void> = [];

  const setSession = (next: Session | null) => {
    session = next;
    if (next) deps.sealed.write(JSON.stringify(next)); else deps.sealed.clear();
    for (const l of changeListeners) l(next?.user ?? null);
  };
  const fail = (message: string) => { for (const l of errorListeners) l(message); };

  return {
    configured: () => !!deps.clientId,
    getUser: () => session?.user ?? null,
    getToken: () => session?.token ?? null,
    async start() {
      if (!deps.clientId) throw new Error('GitHub sign-in is not configured');
      const gen = ++generation;
      let res: Record<string, unknown>;
      try {
        res = await postForm(deps.fetch, 'https://github.com/login/device/code', { client_id: deps.clientId, scope: GITHUB_SCOPES });
      } catch {
        throw new Error("Couldn't reach GitHub");
      }
      if (typeof res.device_code !== 'string' || typeof res.user_code !== 'string') {
        throw new Error(typeof res.error_description === 'string' ? res.error_description : 'GitHub sign-in failed.');
      }
      verificationUri = typeof res.verification_uri === 'string' && res.verification_uri.startsWith('https://github.com/')
        ? res.verification_uri : DEFAULT_VERIFICATION_URI;
      const expiresIn = typeof res.expires_in === 'number' ? res.expires_in : 900;
      deps.openExternal(verificationUri);

      void pollForToken({
        fetch: deps.fetch, clientId: deps.clientId, deviceCode: res.device_code,
        intervalSec: typeof res.interval === 'number' ? res.interval : 5, expiresInSec: expiresIn,
        sleep, now, isCancelled: () => gen !== generation,
      }).then(async (r) => {
        if ('cancelled' in r) return;
        if ('error' in r) { fail(r.error); return; }
        const profile = await githubApi(deps.fetch, r.token, 'GET', '/user').catch(() => null);
        if (gen !== generation) return;
        const u = profile?.status === 200 ? asRecord(profile.data) : null;
        if (!u || typeof u.login !== 'string') { fail("Signed in, but couldn't load your GitHub profile."); return; }
        setSession({
          token: r.token,
          user: {
            login: u.login,
            name: typeof u.name === 'string' && u.name ? u.name : u.login,
            avatarUrl: typeof u.avatar_url === 'string' ? u.avatar_url : '',
          },
        });
      });

      return { userCode: res.user_code, verificationUri, expiresIn };
    },
    openVerification: () => deps.openExternal(verificationUri),
    cancel: () => { generation++; },
    signOut: () => { generation++; setSession(null); },
    onChange: (cb) => { changeListeners.push(cb); },
    onError: (cb) => { errorListeners.push(cb); },
  };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run --maxWorkers=2 test/main/github-auth.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Commit**

```bash
git add src/main/services/github test/main/github-auth.test.ts
git commit -m "feat(sync): GitHub device-flow sign-in"
```

---

### Task 7: Sync service — repo setup, sync cycle, triggers

**Files:**
- Create: `src/main/services/sync/stateFile.ts`
- Create: `src/main/services/sync/syncService.ts`
- Create: `test/main/sync-fakes.ts` (shared test helpers; not matched by the test glob because it has no `.test.ts` suffix)
- Test: `test/main/sync-service.test.ts`

**Interfaces:**
- Consumes: Tasks 1–6 (`parseSyncDoc`, `canonicalJson`, `emptyDoc`, `mergeSync`, `encrypt`/`decrypt`/`parseKey`, `SealedFile`, `githubApi`/`asRecord`/`FetchLike`, store `applySynced`, secrets `replaceAll`).
- Produces:
  - `stateFile.ts`: `interface SyncStateFile { load(): SyncState; save(state: SyncState): void }`, `createSyncStateFile(dir: string): SyncStateFile`
  - `syncService.ts`: `PUSH_DEBOUNCE_MS`, `FOCUS_THROTTLE_MS`, `MAX_ATTEMPTS`, `interface SyncDeps`, `interface SyncService { overview(): SyncOverview; syncNow(): Promise<void>; scheduleSync(delayMs?: number): void; onFocus(): void; noteChange(e: ChangeEvent): void; setPassphrase(p: string): Promise<SyncResult>; enterPassphrase(p: string): Promise<SyncResult>; changePassphrase(current: string, next: string): Promise<SyncResult>; resetPassphrase(next: string): Promise<SyncResult>; forgetKey(): void; dispose(): void }`, `createSyncService(deps: SyncDeps): SyncService`
  - The passphrase methods are implemented in Task 8. In this task they return `{ ok: false, error: 'Not implemented' }`.

- [ ] **Step 1: Write the test helpers**

Create `test/main/sync-fakes.ts`:

```ts
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FetchLike } from '../../src/main/services/github/api';
import { createStore } from '../../src/main/services/store';
import { createSecretsStore, type SafeStorageLike } from '../../src/main/services/secrets';
import { createSealedFile } from '../../src/main/services/sealedFile';
import { createSyncStateFile } from '../../src/main/services/sync/stateFile';
import { createSyncService } from '../../src/main/services/sync/syncService';
import type { SyncOverview } from '../../src/shared/sync/format';

export const fakeSafe: SafeStorageLike = {
  isEncryptionAvailable: () => true,
  encryptString: (p) => Buffer.from('ENC:' + Buffer.from(p).toString('base64'), 'utf8'),
  decryptString: (c) => Buffer.from(c.toString('utf8').slice(4), 'base64').toString('utf8'),
};

/** In-memory stand-in for the parts of the GitHub API the sync service uses. */
export function fakeGithub() {
  const gh = {
    repoExists: false,
    file: null as { text: string; sha: string } | null,
    conflicts: 0,
    unauthorized: false,
    offline: false,
    puts: 0,
    shaCounter: 0,
    setRaw(text: string) { gh.file = { text, sha: `sha${++gh.shaCounter}` }; },
    doc(): Record<string, unknown> { return JSON.parse(gh.file!.text); },
  };
  const base = '/repos/octocat/glkvm-config';
  const fetch: FetchLike = async (url, init) => {
    if (gh.offline) throw new Error('offline');
    const method = init?.method ?? 'GET';
    const path = url.replace('https://api.github.com', '');
    const body = init?.body ? JSON.parse(init.body) : undefined;
    const reply = (status: number, data: unknown = {}) =>
      ({ status, json: async () => data, text: async () => JSON.stringify(data) });
    if (gh.unauthorized) return reply(401, { message: 'Bad credentials' });
    if (method === 'GET' && path === base) return gh.repoExists ? reply(200, { private: true }) : reply(404);
    if (method === 'POST' && path === '/user/repos') {
      if (gh.repoExists) return reply(422, { message: 'name already exists' });
      gh.repoExists = true;
      return reply(201, { private: body.private });
    }
    if (path === `${base}/contents/glkvm-sync.json`) {
      if (method === 'GET') {
        return gh.file ? reply(200, { content: Buffer.from(gh.file.text).toString('base64'), sha: gh.file.sha }) : reply(404);
      }
      if (method === 'PUT') {
        gh.puts++;
        if (gh.conflicts > 0) { gh.conflicts--; return reply(409, { message: 'conflict' }); }
        if ((gh.file?.sha ?? undefined) !== body.sha) return reply(gh.file ? 409 : 422, { message: 'sha mismatch' });
        gh.setRaw(Buffer.from(body.content, 'base64').toString('utf8'));
        return reply(gh.file!.sha === 'sha1' ? 201 : 200, { content: { sha: gh.file!.sha } });
      }
    }
    return reply(500, { message: `unhandled ${method} ${path}` });
  };
  return { gh, fetch };
}

export function machine(fetch: FetchLike) {
  const dir = mkdtempSync(join(tmpdir(), 'glkvm-sync-'));
  const store = createStore(dir);
  const secrets = createSecretsStore(dir, fakeSafe);
  let token: string | null = 'tok';
  const signOuts: number[] = [];
  const auth = {
    configured: () => true,
    getToken: () => token,
    getUser: () => (token ? { login: 'octocat', name: 'Mona', avatarUrl: '' } : null),
    signOut: () => { token = null; signOuts.push(1); },
  };
  const overviews: SyncOverview[] = [];
  let applied = 0;
  const service = createSyncService({
    fetch, auth, store, secrets,
    keyFile: createSealedFile(join(dir, 'sync-key.json'), fakeSafe),
    stateFile: createSyncStateFile(dir),
    logger: { info: () => {}, error: () => {} },
    onOverview: (o) => overviews.push(o),
    onApplied: () => { applied++; },
    sleep: async () => {},
  });
  store.onChange((e) => service.noteChange(e));
  secrets.onChange((e) => service.noteChange(e));
  return { dir, store, secrets, service, auth, signOuts, overviews, applied: () => applied };
}
```

- [ ] **Step 2: Write the failing tests**

Create `test/main/sync-service.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fakeGithub, machine } from './sync-fakes';

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('sync service cycle', () => {
  it('creates the private repo on first sync and pushes local data', async () => {
    const { gh, fetch } = fakeGithub();
    const a = machine(fetch);
    a.store.addDevice({ name: 'Lab', address: 'kvm-a.local' });
    await a.service.syncNow();
    expect(gh.repoExists).toBe(true);
    const doc = gh.doc() as { devices: Record<string, { data: { name: string } }> };
    expect(Object.values(doc.devices).map(e => e.data.name)).toEqual(['Lab']);
    expect(a.overviews.at(-1)?.sync.state).toBe('synced');
  });

  it('propagates additions, edits and deletions between two computers', async () => {
    const { fetch } = fakeGithub();
    const a = machine(fetch);
    const b = machine(fetch);
    const dev = a.store.addDevice({ name: 'Lab', address: 'kvm-a.local' });
    await a.service.syncNow();
    await b.service.syncNow();
    expect(b.store.getDevices().map(d => d.name)).toEqual(['Lab']);
    expect(b.applied()).toBe(1);

    vi.setSystemTime(Date.now() + 1000);
    b.store.updateDevice(dev.id, { name: 'Lab renamed' });
    await b.service.syncNow();
    await a.service.syncNow();
    expect(a.store.getDevices().map(d => d.name)).toEqual(['Lab renamed']);

    vi.setSystemTime(Date.now() + 1000);
    a.store.removeDevice(dev.id);
    await a.service.syncNow();
    await b.service.syncNow();
    expect(b.store.getDevices()).toEqual([]);
  });

  it('does not write when nothing changed', async () => {
    const { gh, fetch } = fakeGithub();
    const a = machine(fetch);
    await a.service.syncNow();
    const puts = gh.puts;
    await a.service.syncNow();
    expect(gh.puts).toBe(puts);
  });

  it('retries write conflicts and gives up after three attempts', async () => {
    const { gh, fetch } = fakeGithub();
    const a = machine(fetch);
    gh.conflicts = 2;
    await a.service.syncNow();
    expect(a.overviews.at(-1)?.sync.state).toBe('synced');

    a.store.addDevice({ name: 'Lab', address: 'kvm-a.local' });
    gh.conflicts = 3;
    await a.service.syncNow();
    expect(a.overviews.at(-1)?.sync).toMatchObject({ state: 'error' });
  });

  it('signs out locally on 401', async () => {
    const { gh, fetch } = fakeGithub();
    const a = machine(fetch);
    gh.unauthorized = true;
    await a.service.syncNow();
    expect(a.signOuts).toHaveLength(1);
    expect(a.overviews.at(-1)?.sync.error).toBe('Signed out of GitHub — sign in again');
  });

  it('never overwrites an unreadable sync file', async () => {
    const { gh, fetch } = fakeGithub();
    gh.repoExists = true;
    gh.setRaw('{ not json');
    const a = machine(fetch);
    a.store.addDevice({ name: 'Lab', address: 'kvm-a.local' });
    await a.service.syncNow();
    expect(gh.puts).toBe(0);
    expect(gh.file?.text).toBe('{ not json');
    expect(a.overviews.at(-1)?.sync.error).toMatch(/unreadable/);
  });

  it('reports network failures without touching local data', async () => {
    const { gh, fetch } = fakeGithub();
    const a = machine(fetch);
    a.store.addDevice({ name: 'Lab', address: 'kvm-a.local' });
    gh.offline = true;
    await a.service.syncNow();
    expect(a.overviews.at(-1)?.sync.error).toBe("Couldn't reach GitHub");
    expect(a.store.getDevices()).toHaveLength(1);
  });

  it('debounces pushes after local changes and does not loop on applied data', async () => {
    const { gh, fetch } = fakeGithub();
    const a = machine(fetch);
    const b = machine(fetch);
    await a.service.syncNow();
    await b.service.syncNow();
    const putsBefore = gh.puts;

    a.store.addDevice({ name: 'One', address: 'kvm-1.local' });
    a.store.addDevice({ name: 'Two', address: 'kvm-2.local' });
    expect(gh.puts).toBe(putsBefore);
    await vi.advanceTimersByTimeAsync(2000);
    await vi.waitFor(() => expect(a.overviews.at(-1)?.sync.state).toBe('synced'));
    expect(gh.puts).toBe(putsBefore + 1);

    await b.service.syncNow();
    expect(b.store.getDevices()).toHaveLength(2);
    const putsAfterPull = gh.puts;
    await vi.advanceTimersByTimeAsync(5000);
    expect(gh.puts).toBe(putsAfterPull);
  });

  it('throttles focus syncs to once per minute', async () => {
    const { fetch } = fakeGithub();
    const a = machine(fetch);
    a.service.onFocus();
    a.service.onFocus();
    expect(a.overviews.filter(o => o.sync.state === 'syncing')).toHaveLength(1);
    await vi.waitFor(() => expect(a.overviews.at(-1)?.sync.state).toBe('synced'));
    a.service.onFocus();
    expect(a.overviews.filter(o => o.sync.state === 'syncing')).toHaveLength(1);
    vi.setSystemTime(Date.now() + 61_000);
    a.service.onFocus();
    expect(a.overviews.filter(o => o.sync.state === 'syncing')).toHaveLength(2);
    await vi.waitFor(() => expect(a.overviews.at(-1)?.sync.state).toBe('synced'));
  });

  it('leaves remote passwords untouched and reports needs-set without a passphrase', async () => {
    const { gh, fetch } = fakeGithub();
    gh.repoExists = true;
    gh.setRaw(JSON.stringify({
      format: 1, crypto: null, settings: null, devices: {}, certs: {},
      secrets: { d1: { updatedAt: 5, data: { iv: 'aXY=', tag: 'dGFn', ct: 'Y3Q=' } } },
    }));
    const a = machine(fetch);
    a.secrets.set('local-only', 'pw');
    await a.service.syncNow();
    expect((gh.doc() as { secrets: unknown }).secrets).toEqual({ d1: { updatedAt: 5, data: { iv: 'aXY=', tag: 'dGFn', ct: 'Y3Q=' } } });
    expect(a.overviews.at(-1)?.passwords).toBe('needs-set');
  });
});
```

Note on the focus test: `onFocus` calls `syncNow` synchronously, which publishes a `syncing` overview immediately (and `tracked` doesn't publish a second one while already syncing), so counting `syncing` overviews counts cycles started. `vi.waitFor` advances fake timers automatically while it polls.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run --maxWorkers=2 test/main/sync-service.test.ts`
Expected: FAIL — cannot resolve `stateFile` / `syncService`.

- [ ] **Step 4: Implement `src/main/services/sync/stateFile.ts`**

```ts
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { emptyState, parseSyncState, type SyncState } from '@shared/sync/format';

export interface SyncStateFile {
  load(): SyncState;
  save(state: SyncState): void;
}

export function createSyncStateFile(dir: string): SyncStateFile {
  const file = join(dir, 'sync-state.json');
  return {
    load() {
      if (!existsSync(file)) return emptyState();
      try { return parseSyncState(JSON.parse(readFileSync(file, 'utf8'))); } catch { return emptyState(); }
    },
    save(state) {
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, JSON.stringify(state), 'utf8');
      renameSync(tmp, file);
    },
  };
}
```

- [ ] **Step 5: Implement `src/main/services/sync/syncService.ts`**

```ts
import type { Device, Settings } from '@shared/types';
import type { TrustStore } from '@shared/certs';
import {
  SYNC_FILE, SYNC_FORMAT, SYNC_REPO, canonicalJson, emptyDoc, isLive, parseSyncDoc,
  type ChangeEvent, type CryptoHeader, type EncryptedBlob, type Entry, type GithubUser,
  type PasswordsState, type SyncDoc, type SyncOverview, type SyncResult, type SyncStatus,
} from '@shared/sync/format';
import { mergeSync, type LocalSnapshot } from '@shared/sync/merge';
import { asRecord, githubApi, type FetchLike, type GithubResponse } from '../github/api';
import type { SealedFile } from '../sealedFile';
import type { SyncStateFile } from './stateFile';
import { decrypt, encrypt, parseKey, type SyncKey } from './crypto';

export const PUSH_DEBOUNCE_MS = 2000;
export const FOCUS_THROTTLE_MS = 60_000;
export const MAX_ATTEMPTS = 3;

export interface SyncDeps {
  fetch: FetchLike;
  auth: { configured(): boolean; getToken(): string | null; getUser(): GithubUser | null; signOut(): void };
  store: {
    getDevices(): Device[]; getSettings(): Settings; getTrustStore(): TrustStore;
    applySynced(next: { devices?: Device[]; settings?: Settings; certs?: TrustStore }): void;
  };
  secrets: { isAvailable(): boolean; ids(): string[]; get(id: string): string | null; replaceAll(passwords: Record<string, string>): void };
  keyFile: SealedFile;
  stateFile: SyncStateFile;
  logger: { info(msg: string): void; error(msg: string, err?: unknown): void };
  onOverview(overview: SyncOverview): void;
  onApplied(): void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface SyncService {
  overview(): SyncOverview;
  syncNow(): Promise<void>;
  scheduleSync(delayMs?: number): void;
  onFocus(): void;
  noteChange(e: ChangeEvent): void;
  setPassphrase(passphrase: string): Promise<SyncResult>;
  enterPassphrase(passphrase: string): Promise<SyncResult>;
  changePassphrase(current: string, next: string): Promise<SyncResult>;
  resetPassphrase(next: string): Promise<SyncResult>;
  forgetKey(): void;
  dispose(): void;
}

class SyncError extends Error {
  constructor(message: string, readonly kind: 'network' | 'auth' | 'invalid' | 'github') { super(message); }
}

export function createSyncService(deps: SyncDeps): SyncService {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let state = deps.stateFile.load();
  let key: SyncKey | null = parseKey(deps.keyFile.read());
  let lastCrypto: CryptoHeader | null | undefined;
  let status: SyncStatus = { state: 'idle' };
  let repoReady = false;
  let queue: Promise<unknown> = Promise.resolve();
  let pending: Promise<void> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastFocusSync = -Infinity;

  function passwordsState(): PasswordsState {
    if (!deps.secrets.isAvailable()) return 'unavailable';
    if (lastCrypto === undefined) return 'unknown';
    if (lastCrypto === null) return 'needs-set';
    return key && key.keyId === lastCrypto.keyId ? 'syncing' : 'needs-passphrase';
  }
  const overview = (): SyncOverview => ({
    user: deps.auth.getUser(), configured: deps.auth.configured(), sync: status, passwords: passwordsState(),
  });
  const publish = () => deps.onOverview(overview());
  const setStatus = (next: SyncStatus) => { status = next; publish(); };

  function exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = queue.then(fn, fn);
    queue = run.catch(() => undefined);
    return run;
  }

  function session(): { token: string; login: string } {
    const token = deps.auth.getToken();
    const user = deps.auth.getUser();
    if (!token || !user) throw new SyncError('Signed out of GitHub — sign in again', 'auth');
    return { token, login: user.login };
  }

  async function api(method: string, path: string, body?: unknown): Promise<GithubResponse> {
    const { token } = session();
    let res: GithubResponse;
    try { res = await githubApi(deps.fetch, token, method, path, body); }
    catch { throw new SyncError("Couldn't reach GitHub", 'network'); }
    if (res.status === 401) throw new SyncError('Signed out of GitHub — sign in again', 'auth');
    if (res.status >= 500) throw new SyncError("Couldn't reach GitHub", 'network');
    return res;
  }

  function githubError(action: string, res: GithubResponse): SyncError {
    const message = asRecord(res.data)?.message;
    return new SyncError(`GitHub error ${res.status} ${action}${typeof message === 'string' ? `: ${message}` : ''}`, 'github');
  }

  const repoPath = () => `/repos/${encodeURIComponent(session().login)}/${SYNC_REPO}`;
  const filePath = () => `${repoPath()}/contents/${SYNC_FILE}`;

  async function ensureRepo(): Promise<void> {
    if (repoReady) return;
    const res = await api('GET', repoPath());
    if (res.status === 404) {
      const created = await api('POST', '/user/repos', {
        name: SYNC_REPO, private: true, auto_init: true, description: 'GLKVM settings sync',
      });
      if (created.status !== 201 && created.status !== 422) throw githubError('creating the sync repository', created);
      await sleep(1500);
    } else if (res.status !== 200) {
      throw githubError('opening the sync repository', res);
    }
    repoReady = true;
  }

  async function fetchDoc(): Promise<{ doc: SyncDoc; sha: string | null }> {
    const res = await api('GET', filePath());
    if (res.status === 404) return { doc: emptyDoc(), sha: null };
    const d = asRecord(res.data);
    if (res.status !== 200 || !d || typeof d.content !== 'string' || typeof d.sha !== 'string') {
      throw githubError('reading the sync file', res);
    }
    try {
      return { doc: parseSyncDoc(Buffer.from(d.content, 'base64').toString('utf8')), sha: d.sha };
    } catch (e) {
      throw new SyncError(`Sync file in GitHub is unreadable (${(e as Error).message})`, 'invalid');
    }
  }

  /** Returns the new sha, or null when GitHub rejected the write because the file changed. */
  async function putDoc(doc: SyncDoc, sha: string | null, message: string): Promise<string | null> {
    const body: Record<string, unknown> = {
      message, content: Buffer.from(`${canonicalJson(doc)}\n`, 'utf8').toString('base64'),
    };
    if (sha) body.sha = sha;
    const res = await api('PUT', filePath(), body);
    if (res.status === 409 || res.status === 422) return null;
    const newSha = asRecord(asRecord(res.data)?.content)?.sha;
    if ((res.status !== 200 && res.status !== 201) || typeof newSha !== 'string') throw githubError('writing the sync file', res);
    return newSha;
  }

  const activeKey = (crypto: CryptoHeader | null): SyncKey | null =>
    deps.secrets.isAvailable() && crypto && key && key.keyId === crypto.keyId ? key : null;

  function localPasswords(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const id of deps.secrets.ids()) {
      const pw = deps.secrets.get(id);
      if (pw !== null) out[id] = pw;
    }
    return out;
  }

  function decryptEntries(k: SyncKey, entries: Record<string, Entry<EncryptedBlob>>) {
    const plain: Record<string, Entry<string>> = {};
    const unreadable: Record<string, Entry<EncryptedBlob>> = {};
    for (const [id, e] of Object.entries(entries)) {
      if (!isLive(e)) { plain[id] = e; continue; }
      try { plain[id] = { updatedAt: e.updatedAt, data: decrypt(k.key, e.data) }; }
      catch { unreadable[id] = e; deps.logger.error(`sync: couldn't decrypt the synced password for device ${id}`); }
    }
    return { plain, unreadable };
  }

  function encryptEntries(
    k: SyncKey, merged: Record<string, Entry<string>>, previousPlain: Record<string, Entry<string>>,
    previous: Record<string, Entry<EncryptedBlob>>, unreadable: Record<string, Entry<EncryptedBlob>>,
  ): Record<string, Entry<EncryptedBlob>> {
    const out: Record<string, Entry<EncryptedBlob>> = { ...unreadable };
    for (const [id, e] of Object.entries(merged)) {
      if (!isLive(e)) { out[id] = e; continue; }
      const prev = previousPlain[id];
      const unchanged = prev && isLive(prev) && prev.updatedAt === e.updatedAt && prev.data === e.data;
      out[id] = unchanged ? previous[id] : { updatedAt: e.updatedAt, data: encrypt(k.key, e.data) };
    }
    return out;
  }

  async function runCycle(): Promise<void> {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      await ensureRepo();
      const { doc, sha } = await fetchDoc();
      lastCrypto = doc.crypto;
      const k = activeKey(doc.crypto);
      const dec = k ? decryptEntries(k, doc.secrets) : null;
      const local: LocalSnapshot = {
        devices: deps.store.getDevices(), settings: deps.store.getSettings(), certs: deps.store.getTrustStore(),
        secrets: k ? localPasswords() : null,
      };
      const m = mergeSync(local, state, {
        settings: doc.settings, devices: doc.devices, certs: doc.certs, secrets: dec ? dec.plain : null,
      }, now());

      if (m.changed.devices || m.changed.settings || m.changed.certs) {
        deps.store.applySynced({
          devices: m.changed.devices ? m.local.devices : undefined,
          settings: m.changed.settings ? m.local.settings : undefined,
          certs: m.changed.certs ? m.local.certs : undefined,
        });
      }
      if (m.changed.secrets && m.local.secrets) deps.secrets.replaceAll(m.local.secrets);
      state = m.state;
      deps.stateFile.save(state);
      if (m.changed.devices || m.changed.settings || m.changed.certs || m.changed.secrets) deps.onApplied();

      const next: SyncDoc = {
        format: SYNC_FORMAT,
        crypto: doc.crypto,
        settings: m.remote.settings,
        devices: m.remote.devices,
        certs: m.remote.certs,
        secrets: k && dec && m.remote.secrets
          ? encryptEntries(k, m.remote.secrets, dec.plain, doc.secrets, dec.unreadable)
          : doc.secrets,
      };
      if (sha !== null && canonicalJson(next) === canonicalJson(doc)) return;
      if (await putDoc(next, sha, 'sync: update config') !== null) return;
      deps.logger.info(`sync: write conflict, retrying (attempt ${attempt})`);
    }
    throw new SyncError('Another computer kept syncing at the same time — try again', 'github');
  }

  function handleError(e: unknown, label: string): string {
    const err = e instanceof SyncError ? e : new SyncError('Sync failed unexpectedly', 'github');
    deps.logger.error(`sync: ${label} failed`, err.message);
    if (!(e instanceof SyncError)) deps.logger.error('sync: unexpected error', e);
    if (err.kind === 'auth') { repoReady = false; deps.auth.signOut(); }
    setStatus({ state: 'error', error: err.message, lastSynced: status.lastSynced });
    return err.message;
  }

  /** Runs `fn` with syncing/synced/error status handling. Call only inside `exclusive`. */
  async function tracked(label: string, fn: () => Promise<void>): Promise<boolean> {
    if (!deps.auth.getToken()) return false;
    if (status.state !== 'syncing') setStatus({ state: 'syncing', lastSynced: status.lastSynced });
    try {
      await fn();
      setStatus({ state: 'synced', lastSynced: now() });
      deps.logger.info(`sync: ${label} ok`);
      return true;
    } catch (e) {
      handleError(e, label);
      return false;
    }
  }

  function syncNow(): Promise<void> {
    if (pending) return pending;
    if (deps.auth.getToken()) setStatus({ state: 'syncing', lastSynced: status.lastSynced });
    pending = exclusive(async () => {
      pending = null;
      await tracked('sync', runCycle);
    });
    return pending;
  }

  function scheduleSync(delayMs = PUSH_DEBOUNCE_MS): void {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; void syncNow(); }, delayMs);
  }

  function noteChange(e: ChangeEvent): void {
    const t = now();
    const touch = (live: Record<string, number>, dead: Record<string, number>, id: string, removed: boolean) => {
      if (removed) { delete live[id]; dead[id] = t; } else { live[id] = t; delete dead[id]; }
    };
    switch (e.kind) {
      case 'settings': state.settings = t; break;
      case 'device': case 'device-removed':
        touch(state.devices, state.deleted.devices, e.id, e.kind === 'device-removed'); break;
      case 'cert': case 'cert-removed':
        touch(state.certs, state.deleted.certs, e.host, e.kind === 'cert-removed'); break;
      case 'secret': case 'secret-removed':
        touch(state.secrets, state.deleted.secrets, e.id, e.kind === 'secret-removed'); break;
    }
    deps.stateFile.save(state);
    if (deps.auth.getToken()) scheduleSync();
  }

  const notImplemented = async (): Promise<SyncResult> => ({ ok: false, error: 'Not implemented' });

  return {
    overview,
    syncNow,
    scheduleSync,
    onFocus() {
      if (!deps.auth.getToken() || now() - lastFocusSync < FOCUS_THROTTLE_MS) return;
      lastFocusSync = now();
      void syncNow();
    },
    noteChange,
    setPassphrase: notImplemented,
    enterPassphrase: notImplemented,
    changePassphrase: notImplemented,
    resetPassphrase: notImplemented,
    forgetKey() {
      key = null;
      deps.keyFile.clear();
      repoReady = false;
      lastCrypto = undefined;
      publish();
    },
    dispose() {
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}
```

Note: `tracked` is used by Task 8's passphrase operations, and `putDoc`, `fetchDoc`, `ensureRepo`, `localPasswords`, `handleError`, `exclusive` and `publish` are all reused there.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run --maxWorkers=2 test/main/sync-service.test.ts`
Expected: PASS (10 tests). If the focus test is flaky because `syncNow` resolves before counting, keep the assertion on `syncing` overviews, which are published synchronously inside `syncNow`.

- [ ] **Step 7: Run the full suite and typecheck**

Run: `npx vitest run --maxWorkers=2 && npm run typecheck`
Expected: all PASS, no type errors (`notImplemented` is replaced in Task 8).

- [ ] **Step 8: Commit**

```bash
git add src/main/services/sync/stateFile.ts src/main/services/sync/syncService.ts test/main/sync-fakes.ts test/main/sync-service.test.ts
git commit -m "feat(sync): sync service with repo setup, merge cycle and triggers"
```

---

### Task 8: Passphrase operations

**Files:**
- Modify: `src/main/services/sync/syncService.ts`
- Test: `test/main/sync-passphrase.test.ts`

**Interfaces:**
- Consumes: Task 3 `createHeader`, `unlock`, `encrypt`, `decrypt`, `serializeKey`, `MIN_PASSPHRASE_LENGTH`; Task 7 internals.
- Produces: real implementations of `setPassphrase`, `enterPassphrase`, `changePassphrase`, `resetPassphrase` on `SyncService`, each returning `SyncResult`. Error messages (exact strings, used by the UI): `'Sign in to GitHub first'`, `'Saved passwords aren't available on this computer'`, `'Use at least 8 characters'`, `'A sync passphrase is already set — enter it instead'`, `'No sync passphrase has been set yet'`, `'Incorrect passphrase'`, `'Current passphrase is incorrect'`, `'Another computer synced at the same time — try again'`.

- [ ] **Step 1: Write the failing tests**

Create `test/main/sync-passphrase.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fakeGithub, machine } from './sync-fakes';

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

async function twoMachinesWithPassword() {
  const { gh, fetch } = fakeGithub();
  const a = machine(fetch);
  const b = machine(fetch);
  const dev = a.store.addDevice({ name: 'Lab', address: 'kvm-a.local' });
  a.secrets.set(dev.id, 'hunter2-secret');
  await a.service.syncNow();
  expect(await a.service.setPassphrase('correct horse battery')).toEqual({ ok: true });
  await b.service.syncNow();
  return { gh, a, b, dev };
}

describe('sync passphrase', () => {
  it('encrypts passwords before they reach GitHub', async () => {
    const { gh, a } = await twoMachinesWithPassword();
    expect(gh.file!.text).not.toContain('hunter2-secret');
    expect(a.service.overview().passwords).toBe('syncing');
  });

  it('rejects short passphrases and a second set', async () => {
    const { a } = await twoMachinesWithPassword();
    expect(await a.service.setPassphrase('short')).toEqual({ ok: false, error: 'Use at least 8 characters' });
    expect(await a.service.setPassphrase('another passphrase'))
      .toEqual({ ok: false, error: 'A sync passphrase is already set — enter it instead' });
  });

  it('unlocks passwords on another computer with the right passphrase', async () => {
    const { b, dev } = await twoMachinesWithPassword();
    expect(b.service.overview().passwords).toBe('needs-passphrase');
    expect(b.secrets.get(dev.id)).toBeNull();
    expect(await b.service.enterPassphrase('wrong passphrase')).toEqual({ ok: false, error: 'Incorrect passphrase' });
    expect(await b.service.enterPassphrase('correct horse battery')).toEqual({ ok: true });
    expect(b.secrets.get(dev.id)).toBe('hunter2-secret');
    expect(b.service.overview().passwords).toBe('syncing');
  });

  it('changing the passphrase re-locks other computers without touching their passwords', async () => {
    const { gh, a, b, dev } = await twoMachinesWithPassword();
    await b.service.enterPassphrase('correct horse battery');
    expect(await a.service.changePassphrase('wrong passphrase', 'new passphrase 42'))
      .toEqual({ ok: false, error: 'Current passphrase is incorrect' });
    expect(await a.service.changePassphrase('correct horse battery', 'new passphrase 42')).toEqual({ ok: true });
    expect(gh.file!.text).not.toContain('hunter2-secret');

    await b.service.syncNow();
    expect(b.service.overview().passwords).toBe('needs-passphrase');
    expect(b.secrets.get(dev.id)).toBe('hunter2-secret');
    expect(await b.service.enterPassphrase('correct horse battery')).toEqual({ ok: false, error: 'Incorrect passphrase' });
    expect(await b.service.enterPassphrase('new passphrase 42')).toEqual({ ok: true });
  });

  it('reset replaces synced passwords with this computer\'s and re-locks others', async () => {
    const { gh, a, b, dev } = await twoMachinesWithPassword();
    const other = b.store.addDevice({ name: 'Other', address: 'kvm-b.local' });
    b.secrets.set(other.id, 'b-only-password');
    expect(await b.service.resetPassphrase('fresh passphrase 1')).toEqual({ ok: true });
    const secrets = (gh.doc() as { secrets: Record<string, unknown> }).secrets;
    expect(Object.keys(secrets)).toEqual([other.id]);

    await a.service.syncNow();
    expect(a.service.overview().passwords).toBe('needs-passphrase');
    expect(await a.service.enterPassphrase('fresh passphrase 1')).toEqual({ ok: true });
    expect(a.secrets.get(other.id)).toBe('b-only-password');
    const after = (gh.doc() as { secrets: Record<string, unknown> }).secrets;
    expect(Object.keys(after).sort()).toEqual([dev.id, other.id].sort());
  });

  it('requires sign-in', async () => {
    const { fetch } = fakeGithub();
    const a = machine(fetch);
    a.auth.signOut();
    expect(await a.service.setPassphrase('correct horse battery')).toEqual({ ok: false, error: 'Sign in to GitHub first' });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run --maxWorkers=2 test/main/sync-passphrase.test.ts`
Expected: FAIL — results are `{ ok: false, error: 'Not implemented' }`.

- [ ] **Step 3: Implement the operations in `syncService.ts`**

Change the crypto import to:

```ts
import {
  MIN_PASSPHRASE_LENGTH, createHeader, decrypt, encrypt, parseKey, serializeKey, unlock, type SyncKey,
} from './crypto';
```

Delete the `notImplemented` constant. Add these functions inside `createSyncService`, directly above the `return {`:

```ts
  const failure = (error: string): SyncResult => ({ ok: false, error });
  const TOO_SHORT = failure(`Use at least ${MIN_PASSPHRASE_LENGTH} characters`);
  const CONFLICT = failure('Another computer synced at the same time — try again');

  function storeKey(k: SyncKey, header: CryptoHeader): void {
    key = k;
    deps.keyFile.write(serializeKey(k));
    lastCrypto = header;
  }

  function passphraseOp(label: string, fn: () => Promise<SyncResult>): Promise<SyncResult> {
    return exclusive(async () => {
      if (!deps.auth.getToken()) return failure('Sign in to GitHub first');
      if (!deps.secrets.isAvailable()) return failure("Saved passwords aren't available on this computer");
      try {
        const result = await fn();
        publish();
        return result;
      } catch (e) {
        return failure(handleError(e, label));
      }
    });
  }

  const setPassphrase = (passphrase: string) => passphraseOp('set passphrase', async () => {
    if (passphrase.length < MIN_PASSPHRASE_LENGTH) return TOO_SHORT;
    await ensureRepo();
    const { doc, sha } = await fetchDoc();
    lastCrypto = doc.crypto;
    if (doc.crypto) return failure('A sync passphrase is already set — enter it instead');
    const { header, key: k } = createHeader(passphrase);
    if (await putDoc({ ...doc, crypto: header, secrets: {} }, sha, 'sync: set passphrase') === null) return CONFLICT;
    storeKey(k, header);
    await tracked('sync', runCycle);
    return { ok: true };
  });

  const enterPassphrase = (passphrase: string) => passphraseOp('enter passphrase', async () => {
    await ensureRepo();
    const { doc } = await fetchDoc();
    lastCrypto = doc.crypto;
    if (!doc.crypto) return failure('No sync passphrase has been set yet');
    const k = unlock(passphrase, doc.crypto);
    if (!k) return failure('Incorrect passphrase');
    storeKey(k, doc.crypto);
    await tracked('sync', runCycle);
    return { ok: true };
  });

  const changePassphrase = (current: string, nextPassphrase: string) => passphraseOp('change passphrase', async () => {
    if (nextPassphrase.length < MIN_PASSPHRASE_LENGTH) return TOO_SHORT;
    await ensureRepo();
    const first = await fetchDoc();
    if (!first.doc.crypto) return failure('No sync passphrase has been set yet');
    const old = unlock(current, first.doc.crypto);
    if (!old) return failure('Current passphrase is incorrect');
    storeKey(old, first.doc.crypto);
    await runCycle();
    const { doc, sha } = await fetchDoc();
    if (!doc.crypto || doc.crypto.keyId !== old.keyId) return CONFLICT;
    const { header, key: k } = createHeader(nextPassphrase);
    const secrets: Record<string, Entry<EncryptedBlob>> = {};
    for (const [id, e] of Object.entries(doc.secrets)) {
      if (!isLive(e)) { secrets[id] = e; continue; }
      try { secrets[id] = { updatedAt: e.updatedAt, data: encrypt(k.key, decrypt(old.key, e.data)) }; }
      catch { deps.logger.error(`sync: dropped an unreadable synced password for device ${id} while changing passphrase`); }
    }
    if (await putDoc({ ...doc, crypto: header, secrets }, sha, 'sync: change passphrase') === null) return CONFLICT;
    storeKey(k, header);
    setStatus({ state: 'synced', lastSynced: now() });
    return { ok: true };
  });

  const resetPassphrase = (nextPassphrase: string) => passphraseOp('reset passphrase', async () => {
    if (nextPassphrase.length < MIN_PASSPHRASE_LENGTH) return TOO_SHORT;
    await ensureRepo();
    const { doc, sha } = await fetchDoc();
    const { header, key: k } = createHeader(nextPassphrase);
    const t = now();
    const secrets: Record<string, Entry<EncryptedBlob>> = {};
    for (const [id, pw] of Object.entries(localPasswords())) {
      secrets[id] = { updatedAt: state.secrets[id] ?? t, data: encrypt(k.key, pw) };
    }
    if (await putDoc({ ...doc, crypto: header, secrets }, sha, 'sync: reset passphrase') === null) return CONFLICT;
    storeKey(k, header);
    await tracked('sync', runCycle);
    return { ok: true };
  });
```

In the returned object, replace the four `notImplemented` entries with:

```ts
    setPassphrase,
    enterPassphrase,
    changePassphrase,
    resetPassphrase,
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run --maxWorkers=2 test/main/sync-passphrase.test.ts test/main/sync-service.test.ts`
Expected: PASS (all). scrypt at the default cost takes roughly 50–150 ms per call, so this file may take a few seconds.

- [ ] **Step 5: Commit**

```bash
git add src/main/services/sync/syncService.ts test/main/sync-passphrase.test.ts
git commit -m "feat(sync): set, enter, change and reset sync passphrase"
```

---

### Task 9: Wire auth and sync into the main process, IPC and preload

**Files:**
- Create: `src/main/syncIpc.ts`
- Modify: `src/main/main.ts`
- Modify: `src/preload/api.ts`
- Modify: `src/preload/preload.ts`

**Interfaces:**
- Consumes: `createGithubAuth`, `GITHUB_CLIENT_ID` (Task 6); `createSealedFile` (Task 4); `createSyncStateFile`, `createSyncService` (Tasks 7–8).
- Produces for the renderer (`window.glkvm`):
  - `syncOverview(): Promise<SyncOverview>`
  - `githubStartAuth(): Promise<({ ok: true } & DeviceCodeInfo) | { ok: false; error: string }>`
  - `githubOpenVerification(): Promise<void>`, `githubCancelAuth(): Promise<void>`, `githubSignOut(): Promise<void>`
  - `syncNow(): Promise<void>`
  - `syncSetPassphrase(p: string)`, `syncEnterPassphrase(p: string)`, `syncChangePassphrase(current: string, next: string)`, `syncResetPassphrase(next: string)` → `Promise<SyncResult>`
  - `onSyncOverview(cb: (o: SyncOverview) => void): () => void`, `onGithubAuthError(cb: (message: string) => void): () => void`, `onSyncApplied(cb: () => void): () => void` (each returns an unsubscribe function)
- IPC channels: `sync:overview` (invoke and event), `github:start-auth`, `github:open-verification`, `github:cancel-auth`, `github:sign-out`, `sync:now`, `sync:set-passphrase`, `sync:enter-passphrase`, `sync:change-passphrase`, `sync:reset-passphrase`, events `github:auth-error`, `sync:applied`.

- [ ] **Step 1: Create `src/main/syncIpc.ts`**

```ts
import { ipcMain } from 'electron';
import type { GithubAuth } from './services/github/auth';
import type { SyncService } from './services/sync/syncService';
import type { SyncResult } from '@shared/sync/format';

const BAD_INPUT: SyncResult = { ok: false, error: 'Invalid input' };
const str = (v: unknown): v is string => typeof v === 'string';

export function registerSyncIpc(auth: GithubAuth, sync: SyncService): void {
  ipcMain.handle('sync:overview', () => sync.overview());
  ipcMain.handle('github:start-auth', async () => {
    try { return { ok: true, ...(await auth.start()) }; }
    catch (e) { return { ok: false, error: (e as Error).message }; }
  });
  ipcMain.handle('github:open-verification', () => auth.openVerification());
  ipcMain.handle('github:cancel-auth', () => auth.cancel());
  ipcMain.handle('github:sign-out', () => auth.signOut());
  ipcMain.handle('sync:now', () => sync.syncNow());
  ipcMain.handle('sync:set-passphrase', (_e, p: unknown) => (str(p) ? sync.setPassphrase(p) : BAD_INPUT));
  ipcMain.handle('sync:enter-passphrase', (_e, p: unknown) => (str(p) ? sync.enterPassphrase(p) : BAD_INPUT));
  ipcMain.handle('sync:change-passphrase', (_e, current: unknown, next: unknown) =>
    (str(current) && str(next) ? sync.changePassphrase(current, next) : BAD_INPUT));
  ipcMain.handle('sync:reset-passphrase', (_e, next: unknown) => (str(next) ? sync.resetPassphrase(next) : BAD_INPUT));
}
```

- [ ] **Step 2: Wire it in `src/main/main.ts`**

Change the first import line to:

```ts
import { app, session, safeStorage, shell } from 'electron';
import { join } from 'node:path';
```

Add after the existing imports:

```ts
import { registerSyncIpc } from './syncIpc';
import { createSealedFile } from './services/sealedFile';
import { createGithubAuth, GITHUB_CLIENT_ID } from './services/github/auth';
import { createSyncStateFile } from './services/sync/stateFile';
import { createSyncService } from './services/sync/syncService';
```

Directly after the line `registerIpc(store, connections, bridge, secrets);`, add:

```ts
  const userData = app.getPath('userData');
  const auth = createGithubAuth({
    fetch,
    sealed: createSealedFile(join(userData, 'github-auth.json'), safeStorage),
    clientId: GITHUB_CLIENT_ID,
    openExternal: (url) => { void shell.openExternal(url); },
  });
  const sync = createSyncService({
    fetch,
    auth,
    store,
    secrets,
    keyFile: createSealedFile(join(userData, 'sync-key.json'), safeStorage),
    stateFile: createSyncStateFile(userData),
    logger,
    onOverview: (o) => dashboard.webContents.send('sync:overview', o),
    onApplied: () => dashboard.webContents.send('sync:applied'),
  });
  store.onChange((e) => sync.noteChange(e));
  secrets.onChange((e) => sync.noteChange(e));
  auth.onChange((user) => {
    logger.info(user ? 'github: signed in' : 'github: signed out');
    if (user) sync.scheduleSync(); else sync.forgetKey();
    dashboard.webContents.send('sync:overview', sync.overview());
  });
  auth.onError((message) => {
    logger.error('github: sign-in failed', message);
    dashboard.webContents.send('github:auth-error', message);
  });
  window.on('focus', () => sync.onFocus());
  if (dashboard.webContents.isLoading()) dashboard.webContents.once('did-finish-load', () => sync.scheduleSync());
  else sync.scheduleSync();
  registerSyncIpc(auth, sync);
```

- [ ] **Step 3: Extend `src/preload/api.ts`**

Replace the first import line with:

```ts
import type { Device, OsKind, Settings } from '@shared/types';
import type { SyncOverview, SyncResult } from '@shared/sync/format';
```

Add these members to `GlkvmApi`, after `modalDone(id: number, value: string): void;`:

```ts
  syncOverview(): Promise<SyncOverview>;
  githubStartAuth(): Promise<{ ok: true; userCode: string; verificationUri: string; expiresIn: number } | { ok: false; error: string }>;
  githubOpenVerification(): Promise<void>;
  githubCancelAuth(): Promise<void>;
  githubSignOut(): Promise<void>;
  syncNow(): Promise<void>;
  syncSetPassphrase(passphrase: string): Promise<SyncResult>;
  syncEnterPassphrase(passphrase: string): Promise<SyncResult>;
  syncChangePassphrase(current: string, next: string): Promise<SyncResult>;
  syncResetPassphrase(next: string): Promise<SyncResult>;
  /** Each on* subscription returns an unsubscribe function. */
  onSyncOverview(cb: (overview: SyncOverview) => void): () => void;
  onGithubAuthError(cb: (message: string) => void): () => void;
  onSyncApplied(cb: () => void): () => void;
```

- [ ] **Step 4: Implement them in `src/preload/preload.ts`**

Change the imports to:

```ts
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { GlkvmApi } from './api';

function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_e: IpcRendererEvent, payload: T) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => { ipcRenderer.removeListener(channel, listener); };
}
```

Add inside the `api` object, after `modalDone`:

```ts
  syncOverview: () => ipcRenderer.invoke('sync:overview'),
  githubStartAuth: () => ipcRenderer.invoke('github:start-auth'),
  githubOpenVerification: () => ipcRenderer.invoke('github:open-verification'),
  githubCancelAuth: () => ipcRenderer.invoke('github:cancel-auth'),
  githubSignOut: () => ipcRenderer.invoke('github:sign-out'),
  syncNow: () => ipcRenderer.invoke('sync:now'),
  syncSetPassphrase: (p) => ipcRenderer.invoke('sync:set-passphrase', p),
  syncEnterPassphrase: (p) => ipcRenderer.invoke('sync:enter-passphrase', p),
  syncChangePassphrase: (current, next) => ipcRenderer.invoke('sync:change-passphrase', current, next),
  syncResetPassphrase: (next) => ipcRenderer.invoke('sync:reset-passphrase', next),
  onSyncOverview: (cb) => subscribe('sync:overview', cb),
  onGithubAuthError: (cb) => subscribe('github:auth-error', cb),
  onSyncApplied: (cb) => subscribe<void>('sync:applied', () => cb()),
```

- [ ] **Step 5: Typecheck, lint, test and build**

Run: `npm run typecheck && npm run lint && npx vitest run --maxWorkers=2 && npm run build`
Expected: no errors; all tests pass; build succeeds. The preload bundle only imports types from `@shared`, so the missing preload alias in `electron.vite.config.ts` is not a problem; if the build reports an unresolved `@shared` import in preload, change the import to `import type` (it must be type-only).

- [ ] **Step 6: Commit**

```bash
git add src/main/syncIpc.ts src/main/main.ts src/preload/api.ts src/preload/preload.ts
git commit -m "feat(sync): wire GitHub auth and sync service into main, IPC and preload"
```

---

### Task 10: Sync section in Settings

**Files:**
- Create: `src/renderer/syncSection.ts`
- Modify: `src/renderer/settingsPanel.ts`
- Modify: `src/renderer/main.ts`
- Modify: `src/renderer/styles.css`

**Interfaces:**
- Consumes: the `window.glkvm` sync/auth API from Task 9; `SyncOverview` from Task 1.
- Produces: `mountSyncSection(el: HTMLElement): () => void` (returns a dispose function).

The renderer has no unit-test harness (Vitest only includes `test/shared` and `test/main`), so this task is verified by typecheck, lint and running the app.

- [ ] **Step 1: Create `src/renderer/syncSection.ts`**

```ts
import type { SyncOverview, SyncResult } from '@shared/sync/format';

type FormKind = 'set' | 'enter' | 'change' | 'reset' | 'signout';

interface FormCopy { title: string; text?: string; fields: Array<'current' | 'passphrase' | 'confirm'>; submit: string; cancel: string; danger?: boolean; }

const FORMS: Record<FormKind, FormCopy> = {
  set: {
    title: 'Set a sync passphrase',
    text: "Saved passwords are encrypted with this before they're sent to GitHub. It can't be recovered — if you forget it you can reset it, and each computer keeps its own saved passwords.",
    fields: ['passphrase', 'confirm'], submit: 'Set passphrase', cancel: 'Skip for now',
  },
  enter: {
    title: 'Enter your sync passphrase',
    fields: ['passphrase'], submit: 'Unlock passwords', cancel: 'Cancel',
  },
  change: {
    title: 'Change sync passphrase',
    text: "Your other computers will ask for the new passphrase. Older copies in the repository's history stay protected only if the old passphrase was never exposed.",
    fields: ['current', 'passphrase', 'confirm'], submit: 'Change passphrase', cancel: 'Cancel',
  },
  reset: {
    title: 'Reset sync passphrase',
    text: 'This deletes the synced passwords from GitHub and sets a new passphrase. Each computer keeps the passwords it has saved; they sync again once that computer enters the new passphrase.',
    fields: ['passphrase', 'confirm'], submit: 'Reset passphrase', cancel: 'Cancel', danger: true,
  },
  signout: {
    title: 'Sign out of GitHub?',
    text: 'Sync stops on this computer. Your devices and saved passwords stay here, and the GitHub repository is not changed.',
    fields: [], submit: 'Sign out', cancel: 'Cancel', danger: true,
  },
};

const LABELS = { current: 'Current passphrase', passphrase: 'Passphrase', confirm: 'Confirm passphrase' };

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K, attrs: Record<string, string> = {}, ...children: Array<Node | string>
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  node.append(...children);
  return node;
}

function button(label: string, onClick: () => void, cls = ''): HTMLButtonElement {
  const b = h('button', cls ? { class: cls, type: 'button' } : { type: 'button' }, label);
  b.onclick = onClick;
  return b;
}

const row = (...children: Node[]) => h('div', { class: 'sync-row' }, ...children);

function note(kind: 'warn' | 'err', title: string, text: string): HTMLElement {
  return h('div', { class: `sync-note ${kind}` }, h('b', {}, title), text);
}

function relative(ts: number): string {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function statusPill(o: SyncOverview): HTMLElement {
  const { state, lastSynced } = o.sync;
  const text = state === 'syncing' ? 'Syncing…'
    : state === 'error' ? 'Sync failed'
    : state === 'synced' && lastSynced ? `Synced ${relative(lastSynced)}`
    : 'Not synced yet';
  return h('div', { class: `sync-pill ${state}` }, h('i'), text);
}

export function mountSyncSection(el: HTMLElement): () => void {
  let overview: SyncOverview | null = null;
  let signing: { userCode: string; expiresAt: number } | null = null;
  let authError = '';
  let formEl: HTMLElement | null = null;

  const offOverview = window.glkvm.onSyncOverview((o) => {
    overview = o;
    if (o.user) { signing = null; authError = ''; }
    render();
  });
  const offAuthError = window.glkvm.onGithubAuthError((message) => { signing = null; authError = message; render(); });
  const tick = window.setInterval(() => { if (signing || overview?.sync.state === 'synced') render(); }, 1000);
  void window.glkvm.syncOverview().then((o) => { overview = o; render(); });

  function closeForm(): void { formEl = null; render(); }

  function openForm(kind: FormKind): void {
    formEl = buildForm(kind);
    render();
    formEl.querySelector('input')?.focus();
  }

  function buildForm(kind: FormKind): HTMLElement {
    const copy = FORMS[kind];
    const box = h('div', { class: 'sync-form' }, h('h5', {}, copy.title));
    if (copy.text) box.append(h('p', { class: 's' }, copy.text));
    const inputs: Partial<Record<'current' | 'passphrase' | 'confirm', HTMLInputElement>> = {};
    for (const f of copy.fields) {
      const input = h('input', { type: 'password', autocomplete: 'off' });
      inputs[f] = input;
      box.append(h('div', { class: 'fld' }, h('label', {}, LABELS[f]), input));
    }
    const errorEl = h('div', { class: 'sync-error' });
    const submitBtn = button(copy.submit, () => void submit(), copy.danger ? 'danger' : 'pri');
    const cancelBtn = button(copy.cancel, closeForm);
    box.append(errorEl, row(cancelBtn, submitBtn));

    async function submit(): Promise<void> {
      const p = inputs.passphrase?.value ?? '';
      if (inputs.confirm && inputs.confirm.value !== p) { errorEl.textContent = "Passphrases don't match"; return; }
      submitBtn.disabled = true; cancelBtn.disabled = true; errorEl.textContent = '';
      let result: SyncResult;
      if (kind === 'set') result = await window.glkvm.syncSetPassphrase(p);
      else if (kind === 'enter') result = await window.glkvm.syncEnterPassphrase(p);
      else if (kind === 'change') result = await window.glkvm.syncChangePassphrase(inputs.current?.value ?? '', p);
      else if (kind === 'reset') result = await window.glkvm.syncResetPassphrase(p);
      else { await window.glkvm.githubSignOut(); result = { ok: true }; }
      submitBtn.disabled = false; cancelBtn.disabled = false;
      if (result.ok) closeForm(); else errorEl.textContent = result.error;
    }

    box.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); void submit(); }
    });
    return box;
  }

  async function startAuth(btn: HTMLButtonElement): Promise<void> {
    authError = '';
    btn.disabled = true;
    const r = await window.glkvm.githubStartAuth();
    if (r.ok) signing = { userCode: r.userCode, expiresAt: Date.now() + r.expiresIn * 1000 };
    else authError = r.error;
    render();
  }

  function renderSignedOut(o: SyncOverview): void {
    if (signing) {
      const code = signing.userCode;
      const left = Math.max(0, Math.round((signing.expiresAt - Date.now()) / 1000));
      el.append(
        h('p', { class: 's' }, 'Enter this code on the GitHub page that opened in your browser.'),
        h('div', { class: 'sync-code' }, code),
        row(
          button('Copy code', () => { void navigator.clipboard.writeText(code); }),
          button('Open GitHub', () => { void window.glkvm.githubOpenVerification(); }),
          button('Cancel', () => { signing = null; void window.glkvm.githubCancelAuth(); render(); }),
        ),
        h('p', { class: 's small' }, `Waiting for approval… code expires in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`),
      );
      return;
    }
    el.append(h('p', { class: 's' }, 'Sync devices, settings, trusted certificates and saved passwords across your computers using a private GitHub repository.'));
    const error = authError || (o.sync.state === 'error' ? o.sync.error ?? '' : '');
    if (error) el.append(note('err', 'GitHub sign-in', error));
    if (!o.configured) {
      el.append(h('p', { class: 's small' }, "GitHub sign-in isn't configured in this build."));
      return;
    }
    const signIn = button('Sign in with GitHub', () => void startAuth(signIn), 'pri');
    el.append(row(signIn));
  }

  function renderSignedIn(o: SyncOverview): void {
    const user = o.user!;
    el.append(h('div', { class: 'sync-who' },
      h('div', { class: 'sync-av' }, user.login.slice(0, 1).toUpperCase()),
      h('div', {}, h('b', {}, user.name), h('span', {}, `github.com/${user.login}/glkvm-config`)),
      statusPill(o),
    ));
    if (o.sync.state === 'error' && o.sync.error) {
      el.append(note('err', "Sync didn't finish", `${o.sync.error}. Your local devices work normally.`));
    }
    if (o.passwords === 'needs-set') {
      el.append(note('warn', "Passwords aren't syncing yet", 'Set a sync passphrase to sync saved passwords. Devices, settings and certificates already sync.'));
    } else if (o.passwords === 'needs-passphrase') {
      el.append(note('warn', "Passwords aren't syncing on this computer", 'Devices, settings and certificates are up to date. Enter your sync passphrase to sync saved passwords.'));
    } else if (o.passwords === 'unavailable') {
      el.append(note('warn', "Passwords can't sync on this computer", 'This system has no secure storage for saved passwords.'));
    }
    if (formEl) { el.append(formEl); return; }
    const actions = [button('Sync now', () => { void window.glkvm.syncNow(); })];
    if (o.passwords === 'needs-set') actions.push(button('Set passphrase…', () => openForm('set'), 'pri'));
    if (o.passwords === 'needs-passphrase') {
      actions.push(button('Enter passphrase…', () => openForm('enter'), 'pri'), button('Forgot passphrase', () => openForm('reset')));
    }
    if (o.passwords === 'syncing') actions.push(button('Change passphrase…', () => openForm('change')));
    actions.push(button('Sign out', () => openForm('signout'), 'danger'));
    el.append(row(...actions));
  }

  function render(): void {
    el.replaceChildren();
    if (!overview) return;
    el.append(h('h4', {}, 'Sync'));
    if (overview.user) renderSignedIn(overview);
    else { formEl = null; renderSignedOut(overview); }
  }

  return () => {
    offOverview();
    offAuthError();
    window.clearInterval(tick);
  };
}
```

Note: re-rendering every second while "Synced" keeps the relative time fresh. It reuses the same `formEl` node, so a half-typed passphrase form is not lost.

- [ ] **Step 2: Mount it in `src/renderer/settingsPanel.ts`**

Add the import:

```ts
import { mountSyncSection } from './syncSection';
```

In the dialog template, change:

```ts
      <section class="io"><button id="export">Export backup…</button><button id="import">Import backup…</button></section>
```

to:

```ts
      <section id="sync" class="sync"></section>
      <section class="io"><button id="export">Export backup…</button><button id="import">Import backup…</button></section>
```

After `dlg.showModal();`, add:

```ts
  const disposeSync = mountSyncSection(dlg.querySelector('#sync') as HTMLElement);
```

Change the close listener to:

```ts
  dlg.addEventListener('close', () => { disposeSync(); dlg.remove(); onClose(); });
```

- [ ] **Step 3: Refresh the dashboard after synced changes in `src/renderer/main.ts`**

After the line `window.glkvm.onConnectedDevices((ids) => setConnectedDevices(ids));`, add:

```ts
// While Settings is open, closing it re-renders the dashboard anyway.
window.glkvm.onSyncApplied(() => { if (!document.querySelector('dialog.settings-panel')) void renderDashboard(root); });
```

- [ ] **Step 4: Add styles to `src/renderer/styles.css`**

Append after the `.settings .io` rule:

```css
.settings .sync{display:flex;flex-direction:column;gap:10px;padding-bottom:14px;border-bottom:1px solid var(--line)}
.settings .sync:empty{display:none}
.sync .s{font-size:12.5px;color:var(--mut);line-height:1.5;margin:0}
.sync .s.small{font-size:11.5px}
.sync-row{display:flex;gap:8px;flex-wrap:wrap}
.sync-form .sync-row{justify-content:flex-end}
.sync-code{font-family:'JetBrains Mono',monospace;font-size:24px;letter-spacing:.16em;text-align:center;
  padding:12px;border:1px dashed var(--line2);border-radius:10px}
.sync-who{display:flex;align-items:center;gap:12px}
.sync-who b{display:block;font-size:13.5px;font-weight:600}
.sync-who span{font-size:12px;color:var(--mut)}
.sync-av{width:34px;height:34px;border-radius:50%;background:var(--panel2);border:1px solid var(--line2);
  display:grid;place-items:center;font-weight:600;font-size:13px}
.sync-pill{margin-left:auto;font-size:11.5px;padding:4px 9px;border-radius:99px;border:1px solid var(--line2);
  color:var(--mut);display:flex;align-items:center;gap:6px;white-space:nowrap}
.sync-pill i{width:7px;height:7px;border-radius:50%;background:var(--dim)}
.sync-pill.synced i{background:var(--ok)}
.sync-pill.error{color:var(--danger)}
.sync-pill.error i{background:var(--danger)}
.sync-note{font-size:12.5px;line-height:1.45;border:1px solid #3a3020;background:#17140e;border-radius:10px;padding:10px 12px}
.sync-note b{display:block;margin-bottom:2px}
.sync-note.err{border-color:#3a2626;background:#170f0f}
.sync-form{display:flex;flex-direction:column;gap:10px;border:1px solid var(--line2);border-radius:10px;padding:14px;background:var(--bg)}
.sync-form h5{margin:0;font-size:14px;font-weight:600}
.sync-error{color:var(--danger);font-size:12px}
.sync-error:empty{display:none}
```

- [ ] **Step 5: Typecheck, lint and build**

Run: `npm run typecheck && npm run lint && npm run build`
Expected: no errors.

- [ ] **Step 6: Run the app and check the signed-out and unconfigured states**

Use the `run` skill (or `npm run dev`). Open Settings. With no `GLKVM_GH_CLIENT_ID` set, the Sync section shows the description and "GitHub sign-in isn't configured in this build." Hotkeys and backup buttons still work. Take a screenshot for the report.

- [ ] **Step 7: Commit**

```bash
git add src/renderer/syncSection.ts src/renderer/settingsPanel.ts src/renderer/main.ts src/renderer/styles.css
git commit -m "feat(sync): Sync section in Settings"
```

---

### Task 11: End-to-end verification with a real GitHub account

**Files:** none (manual). Requires the user's registered OAuth app client ID; if it isn't available, report this task as blocked and stop.

- [ ] **Step 1: Full automated checks**

Run: `npx vitest run --maxWorkers=2 && npm run typecheck && npm run lint && npm run build`
Expected: everything passes.

- [ ] **Step 2: Sign in**

Run: `GLKVM_GH_CLIENT_ID=<client id> npm run dev`. Settings → Sign in with GitHub → approve the code in the browser. Expected: the section shows the login, `github.com/<login>/glkvm-config`, and "Synced just now"; a private `glkvm-config` repo with `glkvm-sync.json` exists on GitHub.

- [ ] **Step 3: Passphrase and encryption**

Save a password on a device, set a passphrase. Expected: `glkvm-sync.json` on GitHub contains a `crypto` header and encrypted `secrets`, and the password text does not appear anywhere in it.

- [ ] **Step 4: Second computer simulation**

Start a second instance with a separate data directory: `GLKVM_GH_CLIENT_ID=<client id> npm run dev -- --user-data-dir=/tmp/glkvm-second` (if electron-vite doesn't forward the flag, run `npm run build` then `npx electron . --user-data-dir=/tmp/glkvm-second`). Sign in; expected: devices appear, "Passwords aren't syncing on this computer" shows; entering the passphrase makes the saved password available. Rename a device on one instance; after focusing the other window (or Sync now), the rename appears.

- [ ] **Step 5: Sign out and logs**

Sign out on the second instance. Expected: devices remain locally; `github-auth.json` and `sync-key.json` are gone from its data directory. Check `app.log` in both instances: sync events are logged and no token, passphrase or password appears in it.
