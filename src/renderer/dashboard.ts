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
