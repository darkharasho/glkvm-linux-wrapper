import { describe, it, expect } from 'vitest';
import { buildBackup, parseBackup, mergeDevices, applyBackup } from '@shared/backup';
import { DEFAULT_SETTINGS } from '@shared/schema';
import type { Device } from '@shared/types';

const dev = (id: string, address: string): Device =>
  ({ id, name: id, address, url: `https://${address}`, createdAt: 1 });

describe('backup round-trip', () => {
  it('parses what it builds', () => {
    const bundle = buildBackup([dev('a', 'a.local')], DEFAULT_SETTINGS);
    const parsed = parseBackup(JSON.stringify(bundle));
    expect(parsed.devices[0].id).toBe('a');
  });
  it('rejects malformed json', () => {
    expect(() => parseBackup('not json')).toThrow('Invalid backup file');
    expect(() => parseBackup('{}')).toThrow('Invalid backup file');
  });
});

describe('mergeDevices', () => {
  it('dedupes by id and by address', () => {
    const merged = mergeDevices([dev('a', 'a.local')], [dev('a', 'a.local'), dev('b', 'a.local'), dev('c', 'c.local')]);
    // 'a' (same id) replaced, 'b' collides on address with 'a', 'c' is new
    expect(merged.map(d => d.address).sort()).toEqual(['a.local', 'c.local']);
  });
});

describe('applyBackup', () => {
  it('merge keeps existing devices and replaces settings', () => {
    const current = { devices: [dev('a', 'a.local')], settings: DEFAULT_SETTINGS };
    const bundle = buildBackup([dev('b', 'b.local')], DEFAULT_SETTINGS);
    const out = applyBackup(current, bundle, 'merge');
    expect(out.devices).toHaveLength(2);
  });
  it('replace overwrites devices', () => {
    const current = { devices: [dev('a', 'a.local')], settings: DEFAULT_SETTINGS };
    const bundle = buildBackup([dev('b', 'b.local')], DEFAULT_SETTINGS);
    const out = applyBackup(current, bundle, 'replace');
    expect(out.devices).toHaveLength(1);
    expect(out.devices[0].id).toBe('b');
  });
});
