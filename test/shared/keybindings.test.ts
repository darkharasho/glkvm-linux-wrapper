import { describe, it, expect } from 'vitest';
import { toAccelerator, resolveAction, macCmdRemap, type KeyInput } from '@shared/keybindings';
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

describe('macCmdRemap', () => {
  it('maps Ctrl+C to Cmd+C', () => {
    expect(macCmdRemap(key({ key: 'c', control: true }))).toEqual({ keyCode: 'c', modifiers: ['meta'] });
  });
  it('maps Ctrl+Shift+Z to Cmd+Shift+Z', () => {
    expect(macCmdRemap(key({ key: 'z', control: true, shift: true }))).toEqual({ keyCode: 'z', modifiers: ['meta', 'shift'] });
  });
  it('does not remap Ctrl+Alt+C', () => {
    expect(macCmdRemap(key({ key: 'c', control: true, alt: true }))).toBeNull();
  });
  it('does not remap an already-meta-held input', () => {
    expect(macCmdRemap(key({ key: 'c', control: false, meta: true }))).toBeNull();
  });
  it('does not remap Ctrl+Tab', () => {
    expect(macCmdRemap(key({ key: 'Tab', control: true }))).toBeNull();
  });
  it('does not remap Ctrl+1 (not in the editing-chord set)', () => {
    expect(macCmdRemap(key({ key: '1', control: true }))).toBeNull();
  });
});
