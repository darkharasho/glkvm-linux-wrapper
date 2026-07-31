# glkvm-linux-wrapper — Design

**Date:** 2026-07-31
**Status:** Approved (brainstorm complete)

## Summary

A Linux-first Electron desktop app that wraps the GL.iNet KVM (GLKVM) web control
interface. It embeds each device's web UI in an isolated, persistent
`WebContentsView`; presents saved devices as dashboard tiles (local JSON store
with import/export); intercepts every keystroke via `before-input-event` for a
full-capture, per-hotkey-configurable keybinding engine; trusts self-signed certs
per-device by fingerprint; keeps you logged in via persistent per-device
sessions; degrades every failure to a recoverable local state; is tested via
pure-logic unit tests plus Electron smoke tests; and ships as an auto-updating
AppImage built and released by GitHub Actions from a public repo.

## Goals

- Wrap the GLKVM web interface in a dedicated Electron desktop app (primary
  target: Linux).
- Provide a dashboard of saved computers as clickable tiles, each opening its own
  local address/URL (e.g. `workmac.local`).
- Full-capture keyboard passthrough so shortcuts (copy, paste, Esc, etc.) reach
  the remote machine, with a per-hotkey settings panel and sensible defaults.
- Run as a standalone app window rather than a browser tab.
- Ship as an auto-updating AppImage from a public GitHub repo.

## Out of scope (v1)

- Reimplementing the GLKVM control protocol — we wrap the existing web UI.
- Stored passwords / login autofill (persistent session only for v1).
- `.deb` / Flatpak packaging (AppImage only for v1).
- Syncable/cloud device storage (local file + manual import/export only).
- Automated tests for real keystroke delivery, live cert acceptance, and the
  auto-update download path (covered by a manual checklist instead).

## Resolved decisions (from brainstorm)

| Open question | Decision |
|---|---|
| Keybind passthrough model | **Full capture** while connected, **plus per-hotkey settings** with sensible defaults. |
| Device store location | **Local JSON** in userData, **with Import/Export** (bundle includes settings/hotkeys). |
| Connection reality | HTTPS with **self-signed cert**; login **required each time** in the browser today. |
| Login handling | **Persistent per-device session** only for v1 (no stored passwords). |
| Embedding tech | **`WebContentsView`** (modern `BrowserView` successor). |
| Packaging / update | **AppImage** via `electron-builder`; **auto-update** via `electron-updater` from **GitHub Releases**; public repo. |
| License | **MIT**. |

---

## Section 1 — Architecture & process model

Electron app with a clean main/renderer split.

- **Main process** (`src/main/`) — owns windows, embedded `WebContentsView`s,
  keybinding interception (`before-input-event`), cert trust, session partitions,
  device/settings storage, and the auto-updater. All privileged work lives here.
- **Dashboard renderer** (`src/renderer/`) — local UI: tile grid, add/edit-device
  dialogs, settings/hotkeys panel, import/export. Sandboxed; talks to main only
  through a typed preload bridge (`contextBridge`, `contextIsolation: true`,
  `nodeIntegration: false`, `sandbox: true`).
- **Embedded KVM view** — one `WebContentsView` per open device, loading that
  device's `https://…` URL in its own persistent session partition. The dashboard
  is itself a view/region; connecting brings the KVM view to the front, and
  "back to dashboard" returns.
- **Preload / IPC** — a small, explicit set of channels (list/add/update/remove
  device, connect/disconnect, get/set settings, import/export, update status).
  No raw Node in the renderer.

Three well-bounded units: **local UI**, **privileged main services**, **embedded
remote view** — each independently testable.

## Section 2 — Keybinding engine

Lives entirely in the main process so it intercepts keys before Chromium acts.

**Model — full capture while connected.** When a device's `WebContentsView` is
focused, a `before-input-event` handler on its `webContents` fires for every key
*before* Chromium's own shortcuts. For each event we look up the **binding map**
and take one of three actions:

- **`remote`** (default for almost everything) — let the event through to the KVM
  page so its JS forwards the keystroke to the controlled machine (Ctrl+C/V/X,
  Esc, Tab, arrows, F-keys, etc.). Browser-ish combos (Ctrl+W/T/R) are remapped to
  `remote` or ignored, never treated as browser actions.
- **`local`** — `event.preventDefault()` and run an **app action** instead
  (back-to-dashboard, next/prev device, toggle fullscreen, open settings, quit).
- **`release`** — one dedicated hotkey (default `Ctrl+Alt+Esc`, rebindable) that
  drops keyboard capture back to local control without leaving the session.

**Binding representation.** Each binding is a record:
`{ id, label, accelerator (e.g. "Ctrl+Shift+C"), action: 'remote' | 'local:<appAction>' | 'release', editable }`.
The full map is an array of these — exactly what the settings panel edits and what
import/export carries. Defaults ship as a built-in map; user overrides merge on top.

**Matching.** Each `before-input-event` is normalized (key + modifiers,
platform-aware for Super/Meta on Linux) into a canonical accelerator string and
matched against the map. Unmatched keys default to `remote` (pass through) so
nothing is silently swallowed.

**Edge cases.** OS-reserved combos we can't intercept (Alt+Tab, Super) are
documented as out of scope, not silently broken. Capture detaches on
blur/disconnect so local shortcuts always work on the dashboard. A visible
indicator shows when capture is active.

**Testability.** Normalize-and-match is a pure function (input event → action),
unit-tested independently of Electron; the handler wiring is a thin adapter.

## Section 3 — Storage (devices, settings, hotkeys) + import/export

**Location.** `app.getPath('userData')` → `~/.config/glkvm-linux-wrapper/`.
Two JSON files, written atomically (temp file + rename):

- `devices.json` — tile list:
  `[{ id, name, address, url, color?, icon?, createdAt }]`. `address` is what you
  type (`workmac.local`); `url` is the normalized `https://workmac.local`.
- `settings.json` — app preferences **plus** hotkey overrides:
  `{ version, general: {…}, hotkeys: [ …binding records… ] }`.

**Access.** A `store` service in main is the only code that touches disk. It loads
on startup, validates against a schema (bad/missing fields fall back to defaults
rather than crashing), keeps state in memory, and persists on change. Renderer
reaches it only through preload IPC (`devices:list/add/update/remove`,
`settings:get/set`). Each file carries a `version` field for clean migrations.

**Import / Export.** One combined bundle:

- **Export** → native save dialog → `glkvm-backup-<date>.json` =
  `{ version, devices, settings }`.
- **Import** → native open dialog → validate → prompt **merge or replace**.
  Devices merge by `id` (or address) to avoid dupes; hotkeys/settings replace.
  Invalid files are rejected whole with a clear error, never partially imported.

No secrets in these files (v1 has no stored passwords), so the backup is safe to
copy around. Session cookies live in Electron's per-partition session storage and
are intentionally **not** exported.

## Section 4 — Cert trust & sessions

**Cert trust — scoped, not global.** Handled in main on the session
`certificate-error` event. We **never** blanket-disable TLS verification.

- Trust is decided **per device host**. First time a device's view hits a
  self-signed cert, an in-app prompt appears — "`workmac.local` is using a
  self-signed certificate. Trust this device?" — showing the fingerprint.
- On accept, the host's cert **fingerprint** is persisted to
  `trusted-certs.json` in userData. Thereafter we only bypass the error when the
  presented fingerprint for that exact host matches the stored one; anything else
  re-prompts (protects against a changed/spoofed cert).
- Non-device requests get no exception.

**Sessions — persistent, isolated per device.** Each device connects through its
own partition: `session.fromPartition('persist:device-<id>')`. Because it's
`persist:`, the KVM's login cookie/token is written to disk and survives restarts
— log in **once per device**, stay logged in until the device expires the session.
Isolation means one device's cookies never leak into another's; "forget / log out"
clears that partition.

**Interaction with storage.** `trusted-certs.json` sits alongside `devices.json`
but is deliberately **excluded** from export (fingerprints and session cookies are
machine-local trust decisions; re-approve on a new machine).

**Testability.** The fingerprint decision is a pure function
(host + fingerprint + trust store → `allow | prompt | deny`), unit-tested without
a live TLS connection.

## Section 5 — Error handling

Rule: **never a blank view or a silent hang — always a clear state with a retry.**

- **Device unreachable / DNS fail** — `did-fail-load` fires; we render a local
  overlay over the view: "Can't reach `workmac.local`" + reason + **Retry** and
  **Back to dashboard**. Chromium's default error page is never shown.
- **Cert rejected / changed** — the trust prompt (Section 4) appears; declining
  returns to the dashboard with a "connection not trusted" note.
- **Session expired / logged out** — the KVM page shows its own login screen; the
  persistent partition handles the rest. No special handling needed.
- **Load timeout / hang** — a per-connect watchdog; if `did-finish-load` hasn't
  fired within N seconds, show the unreachable overlay with Retry.
- **Storage errors (corrupt JSON)** — `store` falls back to defaults, keeps the
  bad file as `devices.json.bak`, and shows a non-blocking toast. Never crashes,
  never blindly overwrites the bad file.
- **Import errors** — schema-validated before applying; bad bundle rejected whole
  with a specific message.
- **Auto-update failures** — non-fatal and quiet: log, optionally show a subtle
  note; the app keeps running the current version.
- **Crash/diagnostics** — errors written to a rotating log in `userData/logs/`.

Theme: **degrade to a clear, recoverable local state**; the dashboard is always
reachable.

## Section 6 — Testing

Hard logic is pure and heavily unit-tested; Electron wiring is thin and covered by
smoke tests. TDD throughout — tests first for each unit.

**Unit tests (bulk) — `vitest`, no Electron runtime:**

- **Keybinding engine** — normalize `(key + modifiers, platform)` → accelerator,
  and map lookup → `remote | local:<action> | release`. Table-driven.
- **Cert decision** — `(host, fingerprint, trust store)` →
  `allow | prompt | deny`.
- **Store & schema** — load/validate/merge, corrupt-file fallback, version
  handling, atomic-write behavior.
- **Import/export** — round-trip equality, merge-by-id dedupe, replace mode,
  malformed-bundle rejection.
- **URL normalization** — `workmac.local` → `https://workmac.local`,
  dedupe/validation.

Per the machine's CLAUDE.md rule, vitest runs with **`--maxWorkers=2`** (or forks
pool capped at 2) to avoid exhausting memory.

**Integration / smoke tests (a few)** — Electron launched via Playwright's
Electron support: app boots to dashboard; add-device → tile appears → persisted;
connect renders a view; `did-fail-load` (unreachable host) shows the recovery
overlay; back-to-dashboard works.

**Out of v1 automated scope (manual checklist):** real keystroke delivery to a
live KVM, actual self-signed-cert acceptance against a real device, the
auto-update download path.

## Section 7 — Packaging, CI & auto-update

**Packaging — `electron-builder` → AppImage.** Single executable, no install,
cross-distro. Config sets `linux.target: AppImage`, app id, icon, category. Door
left open for `.deb`/Flatpak later; v1 ships AppImage only.

**Auto-update — `electron-updater` against GitHub Releases.** First-class AppImage
support (swaps the running AppImage in place). Public repo → client needs no token,
reads the release feed directly. On launch and on an interval: check latest
Release → if newer, download in background → notify → apply on next quit (or
"restart now"). Failures non-fatal (Section 5). `electron-builder` generates the
`latest-linux.yml` feed `electron-updater` reads.

**CI — GitHub Actions, two workflows:**

- **CI** (push/PR): install, lint, run vitest (`--maxWorkers=2`). Keeps `main`
  green.
- **Release** (on `v*` tag): build the AppImage with `electron-builder` and
  publish it to a GitHub Release (`--publish` uploads the AppImage +
  `latest-linux.yml`). Tagging a version is the entire release process.

**Repo setup.** Public GitHub repo at **`darkharasho/glkvm-linux-wrapper`**
(name/owner to be confirmed at creation time — an outward-facing action done
during implementation). Standard Node/Electron `.gitignore` (present), **MIT**
license, README covering install (download AppImage, `chmod +x`, run) and usage.

---

## Proposed source layout

```
src/
  main/            # privileged services: windows, views, keybinding, certs, store, updater
    services/
      store.ts
      keybindings.ts
      certs.ts
      updater.ts
    windows.ts
    ipc.ts
    main.ts
  preload/
    preload.ts     # contextBridge API surface
  renderer/        # dashboard UI: tiles, dialogs, settings panel, import/export
  shared/          # types + pure logic shared/tested (normalize, schema, url)
test/              # vitest unit tests + Playwright electron smoke tests
.github/workflows/ # ci.yml, release.yml
electron-builder config
```

## Deferred / follow-ups (post-v1)

- Optional saved password + keyring-backed autofill (Section 4 "B").
- `.deb` / Flatpak targets.
- Live status on tiles (reachability ping).
- Per-key config UI refinements beyond the initial settings panel.
