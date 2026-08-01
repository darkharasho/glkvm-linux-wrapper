import type { Device } from '@shared/types';
import { openDeviceDialog } from './deviceDialog';
import { osIcon } from './osicon';

export async function renderDashboard(root: HTMLElement): Promise<void> {
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
  (el.querySelector('.lbl') as HTMLElement).textContent = 'Idle';
  el.addEventListener('click', () => window.glkvm.connect(d.id));
  el.addEventListener('contextmenu', (e) => { e.preventDefault();
    openDeviceDialog({ device: d, onSave: async (i) => { await window.glkvm.updateDevice(d.id, i); await renderDashboard(root); } }); });
  return el;
}
