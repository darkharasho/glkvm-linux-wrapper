import type { WebContents, Input } from 'electron';
import { resolveAction, type KeyInput } from '@shared/keybindings';
import type { Settings } from '@shared/types';

export type AppActionHandler = (action: string) => void;

export function attachKeyboard(wc: WebContents, getSettings: () => Settings, onAppAction: AppActionHandler): void {
  wc.on('before-input-event', (event, input: Input) => {
    if (input.type !== 'keyDown') return;
    const ki: KeyInput = {
      key: input.key, control: input.control, alt: input.alt, shift: input.shift, meta: input.meta,
    };
    const action = resolveAction(ki, getSettings().hotkeys);
    if (action === 'remote') return;               // let it reach the KVM page
    event.preventDefault();                          // stop Chromium + the page
    if (action === 'release') { onAppAction('release'); return; }
    onAppAction(action.slice('local:'.length));      // e.g. 'back-to-dashboard'
  });
}
