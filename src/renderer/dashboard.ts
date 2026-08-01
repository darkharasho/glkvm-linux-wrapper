import type { Device } from '@shared/types';
import { openDeviceDialog } from './deviceDialog';
import { osIcon } from './osicon';

let connectedIds = new Set<string>();
let mountedRoot: HTMLElement | null = null;

export async function renderDashboard(root: HTMLElement): Promise<void> {
  mountedRoot = root;
  const devices = await window.glkvm.listDevices();
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
  for (const d of devices) list.appendChild(rowFor(root, d));

  (root.querySelector('#add-btn') as HTMLElement).onclick = () =>
    openDeviceDialog({ onSave: async (i) => { await window.glkvm.addDevice(i); await renderDashboard(root); } });
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

function rowFor(root: HTMLElement, d: Device): HTMLElement {
  const el = document.createElement('button');
  el.className = 'row'; el.dataset.id = d.id;
  el.innerHTML = `
    <span class="av">${osIcon(d.os)}</span>
    <span class="meta"><span class="nm"></span><span class="addr mono"></span></span>
    <span class="st"><span class="dot"></span><span class="lbl"></span></span>
    <span class="chev">›</span>`;
  (el.querySelector('.nm') as HTMLElement).textContent = d.name;
  (el.querySelector('.addr') as HTMLElement).textContent = d.address;
  applyStatus(el, connectedIds.has(d.id));
  el.addEventListener('click', () => window.glkvm.connect(d.id));
  el.addEventListener('contextmenu', (e) => { e.preventDefault();
    openDeviceDialog({ device: d, onSave: async (i) => { await window.glkvm.updateDevice(d.id, i); await renderDashboard(root); } }); });
  return el;
}
