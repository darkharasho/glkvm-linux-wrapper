import type { Device } from '@shared/types';
import { openDeviceDialog } from './deviceDialog';
import { osIcon, keyIcon } from './osicon';

let connectedIds = new Set<string>();
let mountedRoot: HTMLElement | null = null;

export async function renderDashboard(root: HTMLElement): Promise<void> {
  mountedRoot = root;
  const devices = await window.glkvm.listDevices();
  const secretIds = new Set(await window.glkvm.listPasswordIds());
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
  for (const d of devices) list.appendChild(rowFor(root, d, secretIds.has(d.id)));

  (root.querySelector('#add-btn') as HTMLElement).onclick = async () => {
    const secretsAvailable = await window.glkvm.secretsAvailable();
    openDeviceDialog({
      secretsAvailable,
      // eslint-disable-next-line @typescript-eslint/no-unused-vars -- new devices never have a saved password to clear
      onSave: async ({ password, clearPassword, ...dev }) => {
        const d = await window.glkvm.addDevice(dev);
        if (password) await window.glkvm.setPassword(d.id, password);
        await renderDashboard(root);
      },
    });
  };
  (root.querySelector('#settings-btn') as HTMLElement).onclick = () =>
    window.dispatchEvent(new CustomEvent('open-settings'));
}

/** Updates the live "Connected"/"Idle" status set and, if the dashboard is currently mounted,
 * patches each row's status pill in place (no full re-render). */
export function setConnectedDevices(ids: string[]): void {
  connectedIds = new Set(ids);
  if (!mountedRoot) return;
  const list = mountedRoot.querySelector('#list');
  if (!list) return;
  list.querySelectorAll<HTMLElement>('.row').forEach((row) => {
    const id = row.dataset.id;
    if (!id) return;
    applyStatus(row, connectedIds.has(id));
  });
}

function applyStatus(row: HTMLElement, connected: boolean): void {
  const st = row.querySelector('.st') as HTMLElement | null;
  const lbl = row.querySelector('.lbl') as HTMLElement | null;
  if (st) st.classList.toggle('on', connected);
  if (lbl) lbl.textContent = connected ? 'Connected' : 'Idle';
}

function rowFor(root: HTMLElement, d: Device, hasSecret: boolean): HTMLElement {
  const el = document.createElement('button');
  el.className = 'row'; el.dataset.id = d.id;
  el.innerHTML = `
    <span class="av">${osIcon(d.os)}</span>
    <span class="meta"><span class="nm"></span><span class="addr mono"></span></span>
    <span class="st"><span class="dot"></span><span class="lbl"></span></span>
    <span class="chev">›</span>`;
  (el.querySelector('.nm') as HTMLElement).textContent = d.name;
  (el.querySelector('.addr') as HTMLElement).textContent = d.address;
  if (hasSecret) {
    // Inline next to the name (not on its own line), so the row stays compact.
    const key = document.createElement('span');
    key.className = 'keymark';
    key.title = 'Autofill armed';
    key.innerHTML = keyIcon();
    (el.querySelector('.nm') as HTMLElement).appendChild(key);
  }
  applyStatus(el, connectedIds.has(d.id));
  el.addEventListener('click', () => window.glkvm.connect(d.id));
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
      onDelete: async () => {
        await window.glkvm.removeDevice(d.id);
        await renderDashboard(root);
      },
    });
  });
  return el;
}
