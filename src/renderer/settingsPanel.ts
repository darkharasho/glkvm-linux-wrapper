import type { Settings, HotkeyBinding } from '@shared/types';

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

function renderRow(hk: HotkeyBinding, draft: Settings): HTMLElement {
  const li = document.createElement('li');
  li.className = 'hotkey-row';
  li.innerHTML = `<span class="label">${hk.label}</span>
    <kbd class="accel" tabindex="0">${hk.accelerator}</kbd>`;
  const kbd = li.querySelector('.accel') as HTMLElement;
  kbd.addEventListener('keydown', (e) => {
    e.preventDefault();
    const accel = captureAccelerator(e);
    if (!accel) return;
    hk.accelerator = accel;                 // mutate draft in place
    kbd.textContent = accel;
    draft.hotkeys = draft.hotkeys.map(h => h.id === hk.id ? hk : h);
  });
  return li;
}

function captureAccelerator(e: KeyboardEvent): string | null {
  const parts: string[] = [];
  if (e.ctrlKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  if (e.metaKey) parts.push('Meta');
  const k = e.key;
  if (['Control', 'Alt', 'Shift', 'Meta'].includes(k)) return null; // modifier-only, wait for real key
  const alias: Record<string, string> = { ArrowRight: 'Right', ArrowLeft: 'Left', ArrowUp: 'Up', ArrowDown: 'Down' };
  parts.push(alias[k] ?? (k.length === 1 ? k.toUpperCase() : k));
  return parts.join('+');
}
