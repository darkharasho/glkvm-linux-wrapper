# GitHub Sign-in and Cross-Machine Config Sync — Design

Date: 2026-09-13
Status: Approved in brainstorming, pending spec review

## Summary

Add "Sign in with GitHub" and automatic sync of the app's configuration across machines through a private
GitHub repository. Devices, settings/hotkeys, trusted certificates, and saved device passwords sync.
Passwords are end-to-end encrypted with a user-chosen sync passphrase that never leaves the machine.

The model follows SAI (`../sai/electron/services/github-auth.ts`, `github-sync.ts`): OAuth device flow,
an auto-created private config repo, a single JSON file read and written through the GitHub contents API,
debounced pushes. It departs from SAI in four places: the token is encrypted at rest, merging is per item
(newest edit wins) instead of "local wins", passwords are encrypted with a passphrase, and the app also
pulls when the window regains focus.

## Goals

- Sign in with GitHub from Settings using the OAuth device flow.
- Keep devices, settings/hotkeys, trusted certificates and saved passwords in sync across machines with no
  manual step after setup.
- Edits, additions and deletions made on any machine propagate to all others.
- GitHub never holds plaintext passwords or the passphrase.
- Local use is never blocked or degraded by sync failures.

## Non-goals

- Choosing an arbitrary repo or organization (the repo is fixed: `<login>/glkvm-config`).
- Sync history UI, restoring old versions, or conflict prompts.
- Recovering a forgotten passphrase.
- Syncing machine-specific state: the GitHub token, the derived key, `sync-state.json`, logs.
- Real-time sync (push notifications / webhooks).

## Authentication

- Classic GitHub OAuth App with device flow enabled. Scopes: `repo,read:user`.
- The client ID is a constant in code, overridable with the `GLKVM_GH_CLIENT_ID` environment variable.
  The user registers a "GLKVM" OAuth app; until then the constant is a placeholder and `startAuth` fails
  with the message "GitHub sign-in is not configured".
- Flow: `POST https://github.com/login/device/code` → show `user_code`, open `verification_uri` with
  `shell.openExternal` → poll `POST https://github.com/login/oauth/access_token` at the returned interval
  (minimum 5s). `authorization_pending` → keep polling; `slow_down` → add 5s; `access_denied` /
  `expired_token` → stop and report; network errors → keep polling. Stop at `expires_in`. Cancel stops
  polling.
- On success, fetch `GET /user` and store `{ token, login, name, avatarUrl }`.
- Storage: `github-auth.json` in `userData`, containing only ciphertext from `safeStorage`. If
  `safeStorage` is unavailable, the token is held in memory for the session only and Settings says
  "You'll need to sign in again next launch".
- Sign out (with confirmation): stop sync, delete `github-auth.json` and the stored derived key. Local
  devices, passwords and the remote repo are untouched.

## Remote repository

- Name `glkvm-config`, private, `auto_init: true`, description "GLKVM settings sync", created under the
  signed-in user on first sync if `GET /repos/<login>/glkvm-config` returns 404. Any other error aborts
  that sync cycle. Wait ~1.5s after creation before reading, as SAI does.
- One file: `glkvm-sync.json`. One file means every write, including a passphrase change, is a single
  atomic commit. Commit message: `sync: update config`.

### File format (`glkvm-sync.json`)

```ts
interface SyncDoc {
  format: 1;
  crypto: CryptoHeader | null;              // null until a passphrase has been set
  settings: Stamped<Settings> | null;
  devices: Record<string /*deviceId*/, Entry<Device>>;
  certs: Record<string /*host*/, Entry<string /*fingerprint*/>>;
  secrets: Record<string /*deviceId*/, Entry<EncryptedBlob>>;
}
interface Stamped<T> { updatedAt: number; data: T; }
type Entry<T> = { updatedAt: number; data: T } | { updatedAt: number; deletedAt: number };
interface CryptoHeader {
  keyId: string;                            // random id; changes whenever the key changes
  kdf: 'scrypt'; salt: string /*b64*/; N: number; r: number; p: number;
  check: EncryptedBlob;                     // encryption of the constant "glkvm-sync-check"
}
interface EncryptedBlob { iv: string /*b64, 12 bytes*/; tag: string /*b64*/; ct: string /*b64*/; }
```

- Timestamps are epoch milliseconds from the machine that made the edit.
- Deletion markers (`deletedAt`) older than 90 days are dropped when a document is written.
- `format.ts` validates every part. Devices go through the existing `validateDevices` (including the hex
  color check) and settings through `validateSettings`. An entry that fails validation is dropped. A file
  that isn't valid JSON or has an unknown `format` makes the whole document invalid.

## Encryption

- Key derivation: `scrypt(passphrase, salt, 32 bytes, { N: 2^15, r: 8, p: 1 })` with a random 16-byte salt.
- Cipher: AES-256-GCM, random 12-byte IV per blob. Encrypted plaintext is the password string.
- Passphrase verification: decrypt `crypto.check`; failure or mismatch means "Incorrect passphrase".
- Local key storage: the derived 32-byte key plus its `keyId`, encrypted with `safeStorage`, in
  `sync-key.json`. The passphrase itself is never stored. Without `safeStorage` the key is held in memory
  for the session only.
- Minimum passphrase length: 8 characters.

### Passphrase flows

- **Set (first machine, `crypto` is null):** after sign-in, prompt to set (entered twice) or skip. Setting
  creates the header, encrypts every local password, and pushes.
- **Enter (`crypto` exists, no local key or `keyId` mismatch):** prompt to enter or skip. Correct entry
  stores the key and lets the next cycle merge passwords.
- **Skipped / key missing / `keyId` mismatch:** everything except passwords syncs. Remote `secrets` are
  neither applied nor modified; this machine's local password changes aren't pushed. Settings shows
  "Passwords aren't syncing on this computer".
- **Change:** requires the current passphrase (verified against `check`) and a new one. Generate a new
  salt and `keyId`, re-encrypt every remote secret this machine can decrypt plus any local-only passwords,
  write one commit. Other machines see the `keyId` change and move to the "Enter" state.
- **Forgot / reset (with confirmation):** set a new passphrase, replace `secrets` with this machine's
  local passwords encrypted under the new key, write one commit. Other machines move to "Enter"; once
  they enter the new passphrase, their local-only passwords merge back in normally.
- Settings text notes that changing the passphrase protects old git history only if the old passphrase
  was never exposed.

## Local state

- Existing files (`devices.json`, `settings.json`, `trusted-certs.json`, `secrets.json`) keep their
  formats. Pulled passwords are stored through the existing `SecretsStore.set` (OS keychain encryption).
  If `safeStorage` is unavailable, passwords are skipped entirely on that machine.
- New `sync-state.json`:

```ts
interface SyncState {
  settings: number;                         // updatedAt of local settings, 0 = never stamped
  devices: Record<string, number>;          // id -> updatedAt
  certs: Record<string, number>;            // host -> updatedAt
  secrets: Record<string, number>;          // deviceId -> updatedAt
  deleted: { devices: Record<string, number>; certs: Record<string, number>; secrets: Record<string, number> };
  remoteSha: string | null;
}
```

- Local items with no stamp count as `updatedAt = 0`, so on a machine's first sync the repo's version wins
  for anything both sides have, and local-only items are pushed.

## Merge rules (`src/shared/sync/merge.ts`, pure)

Input: local snapshot + `SyncState`, remote `SyncDoc`. Output: the merged `SyncDoc`, plus the list of local
changes to apply.

- Per key in each collection, the entry with the larger `updatedAt` (or `deletedAt`) wins. Ties go to the
  remote entry, so every machine converges on the same result.
- A deletion marker beats an older edit; a newer edit beats an older deletion marker (the item comes back).
- Settings are merged as a single item.
- After merging devices, entries with the same normalized `address` collapse into one, keeping the newest.
  The loser becomes a deletion marker, and its password entry (if any) is moved to the winner's id only if
  the winner has none.
- A device deletion also marks its password entry deleted.
- `secrets` are merged only when this machine holds the key matching `crypto.keyId`; otherwise the remote
  `secrets` map passes through unchanged.
- Markers older than 90 days are removed from the output.
- A key present locally but absent remotely (with no marker) is treated as local-only and pushed. As a
  known limitation, a machine offline for more than 90 days can bring back items deleted in that window.

## Sync service (`src/main/services/sync/syncService.ts`)

### Triggers

- ~2s after successful sign-in and after app launch (when signed in).
- 2s debounce after any local change (devices, settings, certs, passwords).
- Window focus, throttled to at most once per 60s.
- "Sync now" button.
- Only one cycle runs at a time; a trigger during a cycle schedules one follow-up cycle.

### Cycle

1. Ensure the repo exists.
2. `GET contents/glkvm-sync.json` → document + `sha` (404 → empty document, `sha` null).
3. If the document is invalid: set status error "Sync file in GitHub is unreadable", stop. Never overwrite.
4. Merge. Apply local changes through store/secrets methods that don't emit change events. Notify the
   renderer so the dashboard refreshes.
5. If the merged document differs from the fetched one, `PUT` it with the fetched `sha`.
6. On 409/422 (sha mismatch), repeat from step 2, up to 3 attempts total, then status error.
7. Save `sync-state.json` (stamps + new `sha`). Status "synced" with timestamp.

### Change tracking

- `store.ts` and `secrets.ts` gain `onChange(listener)`. Events carry the kind and key, for example
  `{ kind: 'device', id }`, `{ kind: 'device-removed', id }`, `{ kind: 'settings' }`,
  `{ kind: 'cert', host }`, `{ kind: 'cert-removed', host }`, `{ kind: 'secret', id }`,
  `{ kind: 'secret-removed', id }`.
- The sync service stamps `Date.now()` into `SyncState` on each event (and a deletion time for removals),
  then schedules a push.
- `applyImport` (backup import) emits change events for every affected item.
- New non-emitting apply methods are used only by the sync service.

### Errors

| Condition | Behavior |
|---|---|
| Network error / 5xx | Status error "Couldn't reach GitHub"; next trigger retries |
| 401 | Delete stored token, status "Signed out of GitHub — sign in again" |
| 403 / 404 on the repo after creation | Status error with GitHub's message |
| Invalid remote file | Status error, no write |
| A secret fails to decrypt | Skip that entry, log it, continue |
| `safeStorage` unavailable | Passwords skipped; token and key session-only |

All sync events and errors are written to `app.log` via the existing logger. Tokens, passphrases, keys and
passwords are never logged.

## IPC (preload `window.glkvm`)

- `githubGetStatus(): { user: { login, name, avatarUrl } | null; sync: SyncStatus; passwords: 'syncing' | 'needs-set' | 'needs-passphrase' | 'unavailable' }`
- `githubStartAuth(): { userCode, verificationUri, expiresIn }`, `githubCancelAuth()`, `githubSignOut()`
- `syncNow()`, `syncSetPassphrase(p)`, `syncEnterPassphrase(p)`, `syncChangePassphrase(current, next)`,
  `syncResetPassphrase(next)` — each returns `{ ok: true } | { ok: false, error }`
- Events: `github:auth-complete`, `github:auth-error`, `sync:status`, `sync:applied` (dashboard refresh)
- `SyncStatus = { state: 'idle' | 'syncing' | 'synced' | 'error'; lastSynced?: number; error?: string }`

## Settings UI (`settingsPanel.ts`)

A **Sync** section at the top of the Settings dialog, above the backup buttons:

1. Signed out: one-line description, "Sign in with GitHub".
2. Signing in: large device code, Copy code, Open GitHub, Cancel, expiry countdown.
3. Signed in: avatar, login, repo link, status pill, Sync now, Change passphrase…, Sign out.
4. Passphrase needed: notice "Passwords aren't syncing on this computer", Enter passphrase…, Forgot
   passphrase.
5. Passphrase dialog variants: Set (twice, Skip for now), Enter, Change (current + new), Reset (confirm +
   new twice).
6. Errors: plain-language message; 401 shows "Signed out of GitHub — sign in again".

Styling uses the existing tokens and button classes in `styles.css`. Avatars load from
`avatars.githubusercontent.com`; if the renderer CSP blocks that, show an initial instead.

## Files

New:
- `src/main/services/github/api.ts` — `https` request helper for api.github.com
- `src/main/services/github/auth.ts` — device flow, token storage, sign-out
- `src/shared/sync/format.ts` — `SyncDoc` / `SyncState` types and validation
- `src/shared/sync/merge.ts` — pure merge
- `src/main/services/sync/crypto.ts` — scrypt, AES-GCM, check value
- `src/main/services/sync/syncService.ts` — orchestration

Changed: `src/main/services/store.ts`, `src/main/services/secrets.ts`, `src/main/ipc.ts`,
`src/main/main.ts`, `src/preload/api.ts`, `src/preload/preload.ts`, `src/renderer/settingsPanel.ts`,
`src/renderer/styles.css`, dashboard refresh on `sync:applied`.

No new npm dependencies.

## Testing (Vitest, `--maxWorkers=2`)

- `merge.ts`: newest wins; tie goes to remote; delete vs. older edit; newer edit vs. delete; first join
  with unstamped local items; address collapse including password move; device delete marks password;
  secrets pass through without key; marker expiry.
- `format.ts`: malformed JSON, unknown format, invalid device color dropped, invalid entries dropped.
- `crypto.ts`: round trip; wrong passphrase fails the check; tampered ciphertext/tag rejected; change
  passphrase re-encrypts under a new salt and `keyId`.
- `syncService.ts` with a fake API: repo creation; 409 retry then success; 3 failures → error; no PUT when
  unchanged; 401 signs out; invalid remote never written; passwords skipped without key; applying merged
  data doesn't trigger a push.
- `auth.ts`: pending / slow_down / access_denied / expired handling; token written only as ciphertext;
  session-only when `safeStorage` is unavailable.
- Manual: real sign-in and two-machine sync with the registered OAuth app.

## Open items

- The user must register the GLKVM OAuth app (device flow enabled) and provide its client ID.
