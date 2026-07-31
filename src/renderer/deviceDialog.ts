import type { Device } from '@shared/types';

interface DialogOpts { device?: Device; onSave: (input: { name: string; address: string; color?: string }) => Promise<void>; }

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

export function openDeviceDialog(opts: DialogOpts): void {
  const dlg = document.createElement('dialog');
  dlg.className = 'device-dialog';
  dlg.innerHTML = `
    <form method="dialog">
      <h2>${opts.device ? 'Edit device' : 'Add device'}</h2>
      <label>Name<input name="name" required value="${escapeHtml(opts.device?.name ?? '')}"></label>
      <label>Address<input name="address" required placeholder="workmac.local" value="${escapeHtml(opts.device?.address ?? '')}"></label>
      <label>Color<input name="color" type="color" value="${escapeHtml(opts.device?.color ?? '#1f6feb')}"></label>
      <menu><button value="cancel">Cancel</button><button id="save" value="save">Save</button></menu>
    </form>`;
  document.body.appendChild(dlg);
  dlg.showModal();
  dlg.addEventListener('close', async () => {
    if (dlg.returnValue === 'save') {
      const f = dlg.querySelector('form') as HTMLFormElement;
      const data = new FormData(f);
      await opts.onSave({ name: String(data.get('name')), address: String(data.get('address')), color: String(data.get('color')) });
    }
    dlg.remove();
  });
}
