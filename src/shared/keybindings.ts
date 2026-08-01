import type { HotkeyBinding, HotkeyAction } from './types';

export interface KeyInput { key: string; control: boolean; alt: boolean; shift: boolean; meta: boolean; }

const KEY_ALIASES: Record<string, string> = {
  ArrowRight: 'Right', ArrowLeft: 'Left', ArrowUp: 'Up', ArrowDown: 'Down',
  Esc: 'Escape', ' ': 'Space',
};

function canonicalKey(key: string): string {
  if (KEY_ALIASES[key]) return KEY_ALIASES[key];
  if (key.length === 1) return key.toUpperCase();
  return key.charAt(0).toUpperCase() + key.slice(1);
}

export function toAccelerator(input: KeyInput): string {
  const parts: string[] = [];
  if (input.control) parts.push('Ctrl');
  if (input.alt) parts.push('Alt');
  if (input.shift) parts.push('Shift');
  if (input.meta) parts.push('Meta');
  parts.push(canonicalKey(input.key));
  return parts.join('+');
}

export function resolveAction(input: KeyInput, bindings: HotkeyBinding[]): HotkeyAction {
  const accel = toAccelerator(input);
  const match = bindings.find(b => b.accelerator === accel);
  return match ? match.action : 'remote';
}

/** For a macOS target, map a Ctrl+<key> chord to its Cmd(meta) equivalent so a
 *  Linux keyboard drives Mac shortcuts (Ctrl+C -> Cmd+C, Ctrl+Z -> Cmd+Z, etc).
 *  Applies to any single printable character key (letters, digits, punctuation),
 *  preserving Alt and Shift. Named keys (Tab, arrows, F-keys, Escape, Enter…) are
 *  left as Ctrl on purpose — they have distinct macOS meanings that a blanket swap
 *  would break. Returns the injected keyCode + modifiers, or null to pass through. */
export function macCmdRemap(input: KeyInput): { keyCode: string; modifiers: Array<'meta' | 'alt' | 'shift'> } | null {
  if (!input.control || input.meta) return null;   // must be a Ctrl chord not already using Cmd/Meta
  if (input.key.length !== 1) return null;         // single printable char only; named keys pass through as Ctrl
  const modifiers: Array<'meta' | 'alt' | 'shift'> = ['meta'];
  if (input.alt) modifiers.push('alt');
  if (input.shift) modifiers.push('shift');
  return { keyCode: input.key.toLowerCase(), modifiers };
}
