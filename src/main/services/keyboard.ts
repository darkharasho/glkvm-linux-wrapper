import type { WebContents, Input, KeyboardInputEvent } from 'electron';
import { resolveAction, macCmdRemap, type KeyInput } from '@shared/keybindings';
import type { Settings, OsKind } from '@shared/types';

export type AppActionHandler = (action: string) => void;

export function attachKeyboard(
  wc: WebContents,
  getSettings: () => Settings,
  onAppAction: AppActionHandler,
  getTargetOs: () => OsKind,
): void {
  wc.on('before-input-event', (event, input: Input) => {
    if (input.type !== 'keyDown') return;
    const ki: KeyInput = {
      key: input.key, control: input.control, alt: input.alt, shift: input.shift, meta: input.meta,
    };
    const action = resolveAction(ki, getSettings().hotkeys);
    if (action === 'remote') {
      if (getTargetOs() === 'macos') {
        const remap = macCmdRemap(ki);
        if (remap) {
          event.preventDefault();  // swallow the raw Ctrl+<key>
          const modifiers = remap.modifiers as KeyboardInputEvent['modifiers'];
          wc.sendInputEvent({ type: 'keyDown', keyCode: remap.keyCode, modifiers });
          wc.sendInputEvent({ type: 'keyUp', keyCode: remap.keyCode, modifiers });
          return;
        }
      }
      return;                                       // let it reach the KVM page
    }
    event.preventDefault();                          // stop Chromium + the page
    if (action === 'release') { onAppAction('release'); return; }
    onAppAction(action.slice('local:'.length));      // e.g. 'back-to-dashboard'
  });
}
