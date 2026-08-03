import type { Device, OsKind } from '@shared/types';
import { OS_KINDS } from '@shared/schema';
import { openModal } from './modal';
import { osIcon } from './osicon';

interface DialogOpts {
  device?: Device;
  hasSavedPassword?: boolean;
  secretsAvailable?: boolean;
  onSave: (input: {
    name: string; address: string; color?: string; os: OsKind;
    password?: string;        // new/replacement plaintext, if the user typed one
    clearPassword?: boolean;  // user cleared an existing saved password
  }) => Promise<void>;
  onDelete?: () => Promise<void>;  // edit mode only — remove the device (+ its cert & password)
}

const SWATCHES = ['#34d399', '#e5e7eb', '#f4a13a', '#a78bfa', '#f472b6'];

export function openDeviceDialog(opts: DialogOpts): void {
  const name0 = opts.device?.name ?? '';
  const address0 = opts.device?.address ?? '';
  const os0: OsKind = opts.device?.os ?? 'generic';
  const color0 = opts.device?.color ?? '#34d399';
  runDialog(opts, name0, address0, os0, color0);
}

function runDialog(opts: DialogOpts, name0: string, address0: string, os0: OsKind, color0: string): void {
  let name = name0;
  let address = address0;
  let os: OsKind = os0;
  let color = color0;
  let password: string | undefined;              // set only if the user types one
  let clearedSaved = false;                       // user hit "Clear" on an existing saved password
  const available = opts.secretsAvailable !== false;

  openModal({
    title: opts.device ? 'Edit device' : 'Add device',
    subtitle: "Point it at the device's local address.",
    buttons: [
      ...(opts.device ? [{ label: 'Delete', value: 'delete', danger: true }] : []),
      { label: 'Cancel', value: 'cancel' },
      { label: opts.device ? 'Save' : 'Add device', value: 'save', primary: true },
    ],
    render: (body) => {
      body.innerHTML = `
        <div class="fld"><label>Name</label><input name="name" placeholder="Design Mac"></div>
        <div class="fld"><label>Address</label><input name="address" class="mono" placeholder="mypc.local"></div>
        <div class="fld"><label>System</label><div class="seg" id="os"></div></div>
        <div class="fld"><label>Accent</label><div class="swatches" id="sw"></div></div>
        <div class="fld"><label>Login password</label><div id="pw"></div></div>`;

      const nameInput = body.querySelector('[name=name]') as HTMLInputElement;
      const addressInput = body.querySelector('[name=address]') as HTMLInputElement;
      nameInput.value = name;
      addressInput.value = address;
      nameInput.addEventListener('input', () => { name = nameInput.value; });
      addressInput.addEventListener('input', () => { address = addressInput.value; });

      const seg = body.querySelector('#os') as HTMLElement;
      OS_KINDS.forEach((k) => {
        const b = document.createElement('span');
        b.className = 'os' + (k === os ? ' sel' : '');
        b.innerHTML = osIcon(k);
        b.onclick = () => {
          os = k;
          seg.querySelectorAll('.os').forEach((n, i) => n.classList.toggle('sel', OS_KINDS[i] === k));
        };
        seg.appendChild(b);
      });

      const sw = body.querySelector('#sw') as HTMLElement;
      SWATCHES.forEach((c) => {
        const s = document.createElement('span');
        s.className = 'sw' + (c === color ? ' sel' : '');
        s.style.background = c;
        s.onclick = () => {
          color = c;
          sw.querySelectorAll('.sw').forEach((n, i) => n.classList.toggle('sel', SWATCHES[i] === c));
        };
        sw.appendChild(s);
      });

      const pw = body.querySelector('#pw') as HTMLElement;
      const renderPw = () => {
        if (!available) {
          pw.innerHTML = `<div class="hint">Secure storage unavailable — autofill disabled.</div>`;
          return;
        }
        if (opts.hasSavedPassword && !clearedSaved && password === undefined) {
          pw.innerHTML = `<div class="saved">Password saved <button type="button" class="link" id="pw-clear">Clear</button></div>`;
          (pw.querySelector('#pw-clear') as HTMLElement).onclick = () => { clearedSaved = true; renderPw(); };
        } else {
          pw.innerHTML = `<input name="password" type="password" placeholder="Optional — used for autofill">`;
          const inp = pw.querySelector('[name=password]') as HTMLInputElement;
          inp.value = password ?? '';
          inp.addEventListener('input', () => { password = inp.value || undefined; });
        }
      };
      renderPw();
    },
  }).then(async (v) => {
    if (v === 'delete') {
      const confirm = await openModal({
        title: `Delete ${name0 || 'this device'}?`,
        subtitle: 'This removes the device and forgets its trusted certificate and saved password. It cannot be undone.',
        buttons: [{ label: 'Cancel', value: 'cancel' }, { label: 'Delete', value: 'delete', danger: true }],
      });
      if (confirm === 'delete') {
        try { await opts.onDelete?.(); }
        catch { runDialog(opts, name, address, os, color); }
      } else {
        runDialog(opts, name, address, os, color);
      }
      return;
    }
    if (v !== 'save') return;
    if (!name.trim() || !address.trim()) {
      runDialog(opts, name, address, os, color);
      return;
    }
    try {
      await opts.onSave({
        name, address, color, os,
        password,
        clearPassword: clearedSaved && !password,
      });
    } catch {
      runDialog(opts, name, address, os, color);
    }
  });
}
