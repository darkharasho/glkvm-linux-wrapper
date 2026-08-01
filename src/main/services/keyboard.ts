import type { WebContents, Input } from 'electron';
import { resolveAction, type KeyInput } from '@shared/keybindings';
import type { Settings, OsKind } from '@shared/types';

export type AppActionHandler = (action: string) => void;

export function attachKeyboard(
  wc: WebContents,
  getSettings: () => Settings,
  onAppAction: AppActionHandler,
  getTargetOs: () => OsKind,
): void {
  wc.on('before-input-event', (event, input: Input) => {
    // macOS target: swap the physical Control key for Command (Meta) at the key
    // level, so the KVM forwards Cmd+<key> instead of Ctrl+<key> (Ctrl+C -> Cmd+C,
    // Ctrl+Z -> Cmd+Z, and so on for every Ctrl chord).
    //
    // The GLKVM web UI forwards keys by tracking physical modifier KEY events, so
    // we must (a) present a *real* Meta key — a meta flag on a synthetic letter is
    // not enough — and (b) swallow the real Control key so it isn't forwarded as a
    // held Ctrl alongside our Cmd (which produced Ctrl+Cmd combos: copy worked but
    // undo did not). Verified against both flag-reading and key-tracking forwarder
    // models. Local hotkeys below still resolve because the OS keeps the control
    // flag set on the *other* key of the chord.
    if (
      getTargetOs() === 'macos' &&
      input.key === 'Control' &&
      (input.type === 'keyDown' || input.type === 'keyUp')
    ) {
      event.preventDefault();
      wc.sendInputEvent({ type: input.type, keyCode: 'Meta' });
      return;
    }

    if (input.type !== 'keyDown') return;
    const ki: KeyInput = {
      key: input.key, control: input.control, alt: input.alt, shift: input.shift, meta: input.meta,
    };
    const action = resolveAction(ki, getSettings().hotkeys);
    if (action === 'remote') return;                 // let it reach the KVM page
    event.preventDefault();                          // stop Chromium + the page
    if (action === 'release') { onAppAction('release'); return; }
    onAppAction(action.slice('local:'.length));      // e.g. 'back-to-dashboard'
  });
}
