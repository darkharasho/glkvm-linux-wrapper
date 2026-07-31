import { describe, it, expect } from 'vitest';
import { DEFAULT_HOTKEYS, DEFAULT_SETTINGS, validateDevices, validateSettings } from '@shared/schema';

describe('defaults', () => {
  it('ship a release hotkey and a back-to-dashboard local action', () => {
    expect(DEFAULT_HOTKEYS.some(h => h.action === 'release')).toBe(true);
    expect(DEFAULT_HOTKEYS.some(h => h.action === 'local:back-to-dashboard')).toBe(true);
  });
});

describe('validateDevices', () => {
  it('keeps well-formed devices and drops malformed ones', () => {
    const out = validateDevices([
      { id: 'a', name: 'Work', address: 'workmac.local', url: 'https://workmac.local', createdAt: 1 },
      { id: 'b' }, // missing fields -> dropped
      'garbage',
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe('a');
  });
  it('returns [] for non-array input', () => {
    expect(validateDevices(null)).toEqual([]);
  });
});

describe('validateSettings', () => {
  it('fills defaults for missing fields', () => {
    const s = validateSettings({});
    expect(s.version).toBe(DEFAULT_SETTINGS.version);
    expect(s.hotkeys.length).toBe(DEFAULT_HOTKEYS.length);
  });
  it('merges a user hotkey override by id', () => {
    const custom = { ...DEFAULT_HOTKEYS[0], accelerator: 'Ctrl+Alt+Q' };
    const s = validateSettings({ hotkeys: [custom] });
    const merged = s.hotkeys.find(h => h.id === custom.id)!;
    expect(merged.accelerator).toBe('Ctrl+Alt+Q');
  });
});
