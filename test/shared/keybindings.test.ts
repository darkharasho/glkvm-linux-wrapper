import { describe, it, expect } from 'vitest';
import { toAccelerator, resolveAction, type KeyInput } from '@shared/keybindings';
import { DEFAULT_HOTKEYS } from '@shared/schema';

const key = (p: Partial<KeyInput>): KeyInput =>
  ({ key: 'a', control: false, alt: false, shift: false, meta: false, ...p });

describe('toAccelerator', () => {
  it('orders modifiers and title-cases the key', () => {
    expect(toAccelerator(key({ key: 'c', control: true }))).toBe('Ctrl+C');
    expect(toAccelerator(key({ key: 'Escape', control: true, alt: true }))).toBe('Ctrl+Alt+Escape');
    expect(toAccelerator(key({ key: 'ArrowRight', control: true, alt: true }))).toBe('Ctrl+Alt+Right');
  });
});

describe('resolveAction', () => {
  it('resolves configured combos to their action', () => {
    expect(resolveAction(key({ key: 'c', control: true }), DEFAULT_HOTKEYS)).toBe('remote');
    expect(resolveAction(key({ key: 'Escape', control: true, alt: true }), DEFAULT_HOTKEYS)).toBe('release');
    expect(resolveAction(key({ key: 'd', control: true, alt: true }), DEFAULT_HOTKEYS)).toBe('local:back-to-dashboard');
  });
  it('defaults unmatched keys to remote (never swallowed)', () => {
    expect(resolveAction(key({ key: 'q', control: true }), DEFAULT_HOTKEYS)).toBe('remote');
  });
});
