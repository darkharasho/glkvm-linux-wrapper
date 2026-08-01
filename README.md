# glkvm-linux-wrapper

A cross-platform (Linux-first) Electron desktop app that wraps the GL.iNet KVM (GLVKM) web control interface, giving Linux users the native app experience GL.iNet doesn't ship. It presents your GL.iNet KVM devices as a dashboard of tiles, gives you native keyboard passthrough for shortcuts like copy/paste/Esc, and runs as a dedicated windowed app instead of a browser tab.

## Features

- **Dashboard of device tiles** — add each KVM by its local address (e.g. `mypc.local`) and launch it with a click instead of hunting for a browser tab.
- **Native keyboard passthrough** — full input capture while connected, so shortcuts go to the remote machine instead of your desktop. Every hotkey is configurable per-action in Settings, plus a dedicated release hotkey to hand keyboard control back to your desktop on demand.
- **Persistent per-device sessions** — each device gets its own isolated, persistent session, so you log in once and stay logged in across app restarts.
- **Self-signed certificate trust** — GLVKM devices typically serve over HTTPS with a self-signed cert; the app prompts you to trust it once per device instead of failing the connection.
- **Auto-updating AppImage** — the packaged Linux build checks GitHub Releases and updates itself.
- **Frameless window** — a custom titlebar provides its own window controls (minimize/maximize/close) and drag region instead of the OS chrome.

## Install (Linux)

1. Download the latest `GLKVM-*.AppImage` from the [Releases](../../releases) page.
2. Make it executable:
   ```bash
   chmod +x GLKVM-*.AppImage
   ```
3. Run it:
   ```bash
   ./GLKVM-*.AppImage
   ```

Installers for other platforms are also available on the [Releases](../../releases) page: Windows (`GLKVM-*-Setup.exe`) and macOS (`.dmg`). The macOS build is signed and notarized when signing secrets are configured for the release; otherwise it's unsigned — right-click the app and choose Open on first launch to bypass Gatekeeper.

## First run / usage

1. On first launch you'll see an empty dashboard. Add a device using its local address (e.g. `mypc.local`).
2. Click a tile to connect. If the device serves a self-signed certificate, you'll get a one-time prompt to trust it for that device.
3. Log in to the GLVKM web interface as usual. The session persists per device, so you won't need to log in again on future launches.
4. While connected, keyboard input is fully captured and sent to the remote machine so shortcuts like copy/paste/Esc work as expected on the remote side.
5. Use the release hotkey (default **Ctrl+Alt+Escape**) to drop keyboard capture and return control to your desktop.
6. Use the back-to-dashboard hotkey (default **Ctrl+Alt+D**) to return to the device dashboard without leaving the app.
7. Open **Settings** to customize hotkeys per action, or to export/import your devices and settings as a backup file.

## Development

```bash
npm install       # install dependencies
npm run dev        # run the app in dev mode
npm test           # run unit tests (vitest)
npm run test:smoke # run Electron smoke tests (Playwright — requires a display)
npm run dist        # build the Linux AppImage
```

## License

MIT — see [LICENSE](./LICENSE).
