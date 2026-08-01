import type { WebContentsView } from 'electron';
import { ipcMain } from 'electron';

export interface ModalSpec { kind: 'cert-trust' | 'import-choice' | 'alert' | 'update-ready'; [k: string]: unknown; }

export function createModalBridge(dashboard: WebContentsView, presentUI: () => () => void) {
  const pending = new Map<number, (v: string) => void>();
  let seq = 0;
  ipcMain.on('modal:done', (_e, { id, value }: { id: number; value: string }) => {
    const r = pending.get(id); if (r) { pending.delete(id); r(value); }
  });
  return {
    request(spec: ModalSpec): Promise<string> {
      const id = ++seq;
      const restore = presentUI();
      return new Promise<string>((resolve) => {
        pending.set(id, resolve);
        dashboard.webContents.send('modal:show', { id, ...spec });
      }).finally(restore);
    },
  };
}
