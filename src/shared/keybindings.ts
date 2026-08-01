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
