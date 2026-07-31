import type { Settings, HotkeyBinding } from '@shared/types';
import { toAccelerator, type KeyInput } from '@shared/keybindings';

export async function openSettings(root: HTMLElement, onClose: () => void): Promise<void> {
  const settings = await window.glkvm.getSettings();
  const dlg = document.createElement('dialog');
  dlg.className = 'settings-panel';
  dlg.innerHTML = `
    <header><h2>Settings</h2><button id="close">Done</button></header>
    <section class="io"><button id="export">Export backup…</button><button id="import">Import backup…</button></section>
    <h3>Hotkeys</h3>
    <ul id="hotkeys"></ul>`;
  document.body.appendChild(dlg);
  dlg.showModal();

  const list = dlg.querySelector('#hotkeys') as HTMLElement;
  const draft: Settings = structuredClone(settings);
  for (const hk of draft.hotkeys) list.appendChild(renderRow(hk, draft));

  (dlg.querySelector('#export') as HTMLElement).onclick = () => window.glkvm.exportBackup();
  (dlg.querySelector('#import') as HTMLElement).onclick = async () => { await window.glkvm.importBackup(); dlg.close(); };
  (dlg.querySelector('#close') as HTMLElement).onclick = async () => {
    await window.glkvm.setSettings(draft);
    dlg.close();
  };
  dlg.addEventListener('close', () => { dlg.remove(); onClose(); });
}

const ACTION_OPTIONS: ReadonlyArray<{ value: HotkeyBinding['action']; label: string }> = [
  { value: 'remote', label: 'Send to remote' },
  { value: 'release', label: 'Release capture' },
  { value: 'local:back-to-dashboard', label: 'Back to dashboard' },
  { value: 'local:next-device', label: 'Next device' },
  { value: 'local:prev-device', label: 'Previous device' },
  { value: 'local:toggle-fullscreen', label: 'Toggle fullscreen' },
  { value: 'local:open-settings', label: 'Open settings' },
  { value: 'local:quit', label: 'Quit' },
];

function renderRow(hk: HotkeyBinding, draft: Settings): HTMLElement {
  const li = document.createElement('li');
  li.className = 'hotkey-row';
  const kbdAttrs = hk.editable ? ' tabindex="0"' : '';
  const optionsHtml = ACTION_OPTIONS
    .map(opt => `<option value="${escapeHtml(opt.value)}"${opt.value === hk.action ? ' selected' : ''}>${escapeHtml(opt.label)}</option>`)
    .join('');
  li.innerHTML = `<span class="label">${escapeHtml(hk.label)}</span>
    <select class="action"${hk.editable ? '' : ' disabled'}>${optionsHtml}</select>
    <kbd class="accel"${kbdAttrs}>${escapeHtml(hk.accelerator)}</kbd>`;
  const kbd = li.querySelector('.accel') as HTMLElement;
  const select = li.querySelector('.action') as HTMLSelectElement;

  if (hk.editable) {
    kbd.addEventListener('keydown', (e) => {
      e.preventDefault();
      const accel = captureAccelerator(e);
      if (!accel) return;
      hk.accelerator = accel;                 // mutate draft in place
      kbd.textContent = accel;
      draft.hotkeys = draft.hotkeys.map(h => h.id === hk.id ? hk : h);
    });
  }

  select.addEventListener('change', () => {
    hk.action = select.value as HotkeyBinding['action'];   // mutate draft in place
    draft.hotkeys = draft.hotkeys.map(h => h.id === hk.id ? hk : h);
  });

  return li;
}

function captureAccelerator(e: KeyboardEvent): string | null {
  if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return null; // modifier-only, wait for real key
  const input: KeyInput = { key: e.key, control: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, meta: e.metaKey };
  return toAccelerator(input);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}
