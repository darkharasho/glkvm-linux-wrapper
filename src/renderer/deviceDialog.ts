import type { Device, OsKind } from '@shared/types';
import { OS_KINDS } from '@shared/schema';
import { openModal } from './modal';
import { osIcon } from './osicon';

interface DialogOpts {
  device?: Device;
  onSave: (input: { name: string; address: string; color?: string; os: OsKind }) => Promise<void>;
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

  openModal({
    title: opts.device ? 'Edit device' : 'Add device',
    subtitle: "Point it at the device's local address.",
    buttons: [
      { label: 'Cancel', value: 'cancel' },
      { label: opts.device ? 'Save' : 'Add device', value: 'save', primary: true },
    ],
    render: (body) => {
      body.innerHTML = `
        <div class="fld"><label>Name</label><input name="name" placeholder="Design Mac"></div>
        <div class="fld"><label>Address</label><input name="address" class="mono" placeholder="mypc.local"></div>
        <div class="fld"><label>System</label><div class="seg" id="os"></div></div>
        <div class="fld"><label>Accent</label><div class="swatches" id="sw"></div></div>`;

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
    },
  }).then(async (v) => {
    if (v !== 'save') return;
    if (!name.trim() || !address.trim()) {
      runDialog(opts, name, address, os, color);
      return;
    }
    try {
      await opts.onSave({ name, address, color, os });
    } catch {
      runDialog(opts, name, address, os, color);
    }
  });
}
