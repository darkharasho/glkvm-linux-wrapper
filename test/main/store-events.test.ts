import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../../src/main/services/store';
import { createSecretsStore, type SafeStorageLike } from '../../src/main/services/secrets';
import { DEFAULT_SETTINGS } from '../../src/shared/schema';
import type { ChangeEvent } from '../../src/shared/sync/format';

const safe: SafeStorageLike = {
  isEncryptionAvailable: () => true,
  encryptString: (p) => Buffer.from('ENC:' + p, 'utf8'),
  decryptString: (c) => c.toString('utf8').slice(4),
};

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'glkvm-ev-')); });

describe('store change events', () => {
  it('emits an event for every user-facing mutation', () => {
    const s = createStore(dir);
    const events: ChangeEvent[] = [];
    s.onChange(e => events.push(e));
    const d = s.addDevice({ name: 'Lab', address: 'kvm-a.local' });
    s.updateDevice(d.id, { name: 'Lab 2' });
    s.setSettings(DEFAULT_SETTINGS);
    s.trustCert('kvm-a.local', 'AB');
    s.untrustHost('kvm-a.local');
    s.untrustHost('never-trusted.local');
    s.removeDevice(d.id);
    s.removeDevice('missing');
    expect(events).toEqual([
      { kind: 'device', id: d.id }, { kind: 'device', id: d.id }, { kind: 'settings' },
      { kind: 'cert', host: 'kvm-a.local' }, { kind: 'cert-removed', host: 'kvm-a.local' },
      { kind: 'device-removed', id: d.id },
    ]);
  });

  it('emits for backup imports, including devices removed by replace', () => {
    const s = createStore(dir);
    const a = s.addDevice({ name: 'A', address: 'kvm-a.local' });
    const b = { ...a, id: 'b-id', address: 'kvm-b.local', url: 'https://kvm-b.local' };
    const events: ChangeEvent[] = [];
    s.onChange(e => events.push(e));
    s.applyImport({ version: 1, devices: [b], settings: DEFAULT_SETTINGS }, 'replace');
    expect(events).toEqual([
      { kind: 'device', id: 'b-id' }, { kind: 'device-removed', id: a.id }, { kind: 'settings' },
    ]);
  });

  it('applySynced persists without emitting', () => {
    const s = createStore(dir);
    const events: ChangeEvent[] = [];
    s.onChange(e => events.push(e));
    const dev = { id: 'x', name: 'X', address: 'kvm-x.local', url: 'https://kvm-x.local', os: 'linux' as const, createdAt: 1 };
    s.applySynced({ devices: [dev], certs: { 'kvm-x.local': 'CD' } });
    expect(events).toEqual([]);
    const reloaded = createStore(dir);
    expect(reloaded.getDevices()).toEqual([dev]);
    expect(reloaded.getTrustStore()).toEqual({ 'kvm-x.local': 'CD' });
  });
});

describe('secrets change events', () => {
  it('emits on set and clear, and replaceAll persists silently', () => {
    const s = createSecretsStore(dir, safe);
    const events: ChangeEvent[] = [];
    s.onChange(e => events.push(e));
    s.set('a', 'pw-a');
    s.clear('a');
    s.clear('missing');
    s.replaceAll({ b: 'pw-b', c: 'pw-c' });
    expect(events).toEqual([{ kind: 'secret', id: 'a' }, { kind: 'secret-removed', id: 'a' }]);
    const reloaded = createSecretsStore(dir, safe);
    expect(reloaded.ids().sort()).toEqual(['b', 'c']);
    expect(reloaded.get('b')).toBe('pw-b');
    reloaded.replaceAll({ c: 'pw-c2' });
    expect(reloaded.ids()).toEqual(['c']);
    expect(reloaded.get('c')).toBe('pw-c2');
  });
});
