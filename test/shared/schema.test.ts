import { describe, it, expect } from 'vitest';
import { DEFAULT_HOTKEYS, DEFAULT_SETTINGS, validateDevices, validateSettings, coerceOs, OS_KINDS } from '@shared/schema';

describe('defaults', () => {
  it('ship a release hotkey and a back-to-dashboard local action', () => {
    expect(DEFAULT_HOTKEYS.some(h => h.action === 'release')).toBe(true);
    expect(DEFAULT_HOTKEYS.some(h => h.action === 'local:back-to-dashboard')).toBe(true);
  });
});

describe('validateDevices', () => {
  it('keeps well-formed devices and drops malformed ones', () => {
    const out = validateDevices([
      { id: 'a', name: 'Work', address: '192.168.1.42', url: 'https://192.168.1.42', createdAt: 1 },
      { id: 'b' }, // missing fields -> dropped
      'garbage',
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe('a');
  });
  it('returns [] for non-array input', () => {
    expect(validateDevices(null)).toEqual([]);
  });
  it('drops a device with an invalid (non-hex) color', () => {
    const out = validateDevices([
      { id: 'a', name: 'Work', address: 'example-host.local', url: 'https://example-host.local', createdAt: 1, color: 'url(https://evil.example/x.png)' },
      { id: 'b', name: 'Home', address: 'home.local', url: 'https://home.local', createdAt: 2, color: '#1f6feb' },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe('b');
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
  it('rejects incomplete hotkey overrides (missing editable) and falls back to defaults', () => {
    const incompleteOverride = {
      id: DEFAULT_HOTKEYS[0].id,
      accelerator: 'Ctrl+Alt+Q',
      action: 'release',
      label: 'Custom Release',
      // editable intentionally omitted
    };
    const s = validateSettings({ hotkeys: [incompleteOverride] });
    const fallback = s.hotkeys.find(h => h.id === DEFAULT_HOTKEYS[0].id)!;
    // Should fall back to default since override is incomplete
    expect(fallback.accelerator).toBe(DEFAULT_HOTKEYS[0].accelerator);
    expect(typeof fallback.editable).toBe('boolean');
    expect(fallback.editable).toBe(true);
  });
});

describe('os field', () => {
  it('defaults a device with no os to generic (back-compat)', () => {
    const [d] = validateDevices([
      { id: 'a', name: 'A', address: 'mypc.local', url: 'https://mypc.local', createdAt: 1 },
    ]);
    expect(d.os).toBe('generic');
  });
  it('keeps a valid os and repairs an invalid one', () => {
    const out = validateDevices([
      { id: 'a', name: 'A', address: 'mypc.local', url: 'https://mypc.local', createdAt: 1, os: 'macos' },
      { id: 'b', name: 'B', address: 'desktop.local', url: 'https://desktop.local', createdAt: 1, os: 'beos' },
    ]);
    expect(out[0].os).toBe('macos');
    expect(out[1].os).toBe('generic');
  });
  it('coerceOs guards the union', () => {
    expect(coerceOs('linux')).toBe('linux');
    expect(coerceOs(42)).toBe('generic');
    expect(OS_KINDS).toContain('windows');
  });
});
