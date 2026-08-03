# Secure Password Storage & Autofill for GLKVM Device Login

**Date:** 2026-08-03
**Status:** Approved (design)

## Summary

Store a per-device GLKVM **web login** password securely, and automatically
fill and submit it when a device's login page is detected. Scope is limited to
the device's own web UI sign-in form (a real DOM form) — **not** the remote
machine's OS password (which is a video stream reached only via keystroke
passthrough, explicitly out of scope here).

The GLKVM login is a single **password field + sign-in button** (no username).

## Goals

- Save one optional password per device, encrypted at rest.
- On connecting to a device, detect its login page and auto-fill + auto-submit.
- Never loop or lock out on a wrong password (safety valve).
- Never store or expose the password in plaintext (disk, renderer, backups, logs).

## Non-goals

- Remote machine / OS-level password entry via KVM keystrokes.
- Username + password logins (current firmware is password-only). Detection keys
  off a generic password input, so a future username field is a follow-up, not a
  blocker.

## Architecture

Three concerns, each isolated:

1. **Secrets store (main process)** — encrypted persistence of per-device passwords.
2. **Autofill orchestration (main process)** — detect login page, fill, submit,
   safety valve. Lives with / beside the connection manager.
3. **UX (renderer + IPC)** — set/clear a password on the device dialog; the
   renderer never receives plaintext.

### 1. Secrets store

- Uses Electron's built-in `safeStorage` (OS keychain-backed: libsecret/kwallet
  on Linux, Keychain on macOS, DPAPI on Windows). No extra native dependency.
- New file `secrets.json` in the existing `baseDir`, shape:
  `{ [deviceId: string]: string /* base64(safeStorage ciphertext) */ }`.
  Only ciphertext is ever written.
- API (main-process only):
  - `set(deviceId, password)` — encrypt + persist. Refuses (throws / returns
    false) when `safeStorage.isEncryptionAvailable()` is false.
  - `get(deviceId): string | null` — decrypt; used only internally by autofill.
    Never crosses IPC to the renderer.
  - `has(deviceId): boolean` — presence check for UI/state.
  - `clear(deviceId)` — remove entry.
- Plaintext lives only transiently in the main process at fill time.
- **Excluded from backups**: `buildBackup`/export continues to serialize only
  devices + settings. Secrets are never in the bundle, so exporting the device
  list cannot leak credentials.
- `removeDevice` also clears the device's secret.

**Linux-without-keyring caveat:** if `safeStorage.isEncryptionAvailable()` is
false, the feature is disabled — saving is blocked with a clear message. We
**never** fall back to plaintext storage.

### 2. Autofill orchestration

Runs in the main process, triggered from the connection manager's existing
`did-finish-load` handler for a device view.

**Detection ("are we on the login screen?")**
- After load, run a fixed, app-controlled `executeJavaScript` probe (same pattern
  as the existing `measureNatural` probe) that looks for a visible
  `input[type=password]`.
- Bounded retry: re-probe a few times over ~2s to allow SPA logins that render
  the form a beat after load.
- **Found** → login page → proceed to fill. **Not found** (after retries) →
  already authenticated / not a login page → do nothing. This guard ensures an
  already-logged-in session, or the live remote-desktop view, is never touched.

**Fill + submit**
1. Decrypt the device's password via the secrets store. (Absent → stop.)
2. Inject: set the password `input.value`, dispatch `input` + `change` events so
   the GLKVM front-end framework registers the value, then click the sign-in
   button / submit the form.
3. Injected code is a fixed string we author — no page-supplied code executed.

**Safety valve (prevents loops / lockouts)**
- In-memory only (per app run, never persisted): remember that we just
  auto-submitted for this device.
- If a login form is still/again present within ~3s of submit → treat as a failed
  sign-in: do **not** resubmit. Fill the field (leave it for the user) and surface
  a small "Autofill: sign-in failed — check saved password" notice.

### 3. UX (device dialog + IPC)

- Add an optional **Password** field to the add/edit device dialog
  (`deviceDialog.ts`). Blank → no autofill for that device (opt-in per device).
- Editing a device that has a saved password shows a **"Password saved" state +
  Clear button** instead of the characters. The renderer never receives the
  plaintext (uses `has(deviceId)`). Typing a new value replaces it; leaving the
  saved state keeps the existing secret.
- Optional dashboard tile indicator (small key/lock glyph) marking devices with
  autofill armed.
- IPC surface (main-only secrets ops): `secrets.set(deviceId, password)`,
  `secrets.clear(deviceId)`, `secrets.has(deviceId) -> boolean`. Autofill itself
  is triggered internally by the connection manager, not exposed to the renderer.

## Data flow

```
Device dialog (renderer)
   -- secrets.set/clear/has (IPC, no plaintext returned) --> Secrets store (main)
                                                              writes secrets.json (ciphertext)

Connect device --> WebContentsView loads device URL --> did-finish-load
   --> probe for input[type=password] (retry ~2s)
       -- found --> secrets.get(deviceId) --> inject value + events + submit
                    --> re-check within ~3s
                        -- still login form --> mark failed, no resubmit, notify
                        -- form gone        --> success
       -- not found --> no-op
```

## Error handling

| Case | Behavior |
|------|----------|
| No keyring / encryption unavailable | `set` refuses; dialog shows "secure storage unavailable"; existing devices don't autofill |
| Decrypt fails (keyring changed / blob corrupt) | Skip autofill, leave login page for manual entry, log a warning (never the password) |
| Login form never appears in retry window | No-op (already in, or not a login page) |
| Wrong password | Safety valve: fill-only, no resubmit, quiet notice |
| Device deleted | Its `secrets.json` entry is removed alongside `removeDevice` |

## Testing

- **Unit (vitest `--maxWorkers=2`):**
  - Secrets store round-trip with mocked `safeStorage`: set/has/clear;
    missing-keyring path (set refused); decrypt-failure path.
  - Safety-valve state machine: submit → reappear = no resubmit;
    submit → gone = success.
  - Backup/export excludes secrets.
- **DOM probe/fill script** extracted as a pure string-returning function so its
  logic (find password input, dispatch events, locate submit) is testable against
  a jsdom fixture.
- **Smoke (playwright):** device dialog shows/saves/clears the password field and
  the "saved" state.

## Security summary

- Plaintext never on disk, never in the renderer, never in backups, never logged.
- Encryption is OS-keychain-backed; unavailable keyring disables the feature
  rather than degrading to plaintext.
- Injected autofill code is fixed and app-authored; no remote code execution.
- Detection guard prevents injecting a password into anything but a real login form.
