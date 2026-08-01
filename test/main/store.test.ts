import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../../src/main/services/store';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'glkvm-')); });

describe('store', () => {
  it('adds a device with generated id/url and persists it', () => {
    const s = createStore(dir);
    const d = s.addDevice({ name: 'Work', address: 'https://mypc.local/' });
    expect(d.url).toBe('https://mypc.local');
    expect(d.id).toBeTruthy();
    const reloaded = createStore(dir);
    expect(reloaded.getDevices()).toHaveLength(1);
  });

  it('removes a device', () => {
    const s = createStore(dir);
    const d = s.addDevice({ name: 'Work', address: 'mypc.local' });
    s.removeDevice(d.id);
    expect(s.getDevices()).toHaveLength(0);
  });

  it('falls back to defaults and backs up a corrupt devices file', () => {
    writeFileSync(join(dir, 'devices.json'), '{ this is not valid');
    const s = createStore(dir);
    expect(s.getDevices()).toEqual([]);
    expect(existsSync(join(dir, 'devices.json.bak'))).toBe(true);
  });

  it('stores a trusted cert fingerprint', () => {
    const s = createStore(dir);
    s.trustCert('mypc.local', 'AA:BB');
    expect(createStore(dir).getTrustStore()['mypc.local']).toBe('AA:BB');
  });

  it('writes atomically (no leftover temp file)', () => {
    const s = createStore(dir);
    s.addDevice({ name: 'Work', address: 'mypc.local' });
    const leftovers = readFileSync(join(dir, 'devices.json'), 'utf8');
    expect(existsSync(join(dir, 'devices.json.tmp'))).toBe(false);
    expect(JSON.parse(leftovers)).toHaveLength(1);
  });

  it('persists os, defaulting to generic', () => {
    const s = createStore(dir);
    const a = s.addDevice({ name: 'A', address: 'mypc.local' });
    expect(a.os).toBe('generic');
    const b = s.addDevice({ name: 'B', address: 'desktop.local', os: 'linux' });
    expect(b.os).toBe('linux');
    expect(createStore(dir).getDevices().find(d => d.id === b.id)!.os).toBe('linux');
  });

  it('updates os', () => {
    const s = createStore(dir);
    const a = s.addDevice({ name: 'A', address: 'mypc.local' });
    s.updateDevice(a.id, { os: 'windows' });
    expect(s.getDevices()[0].os).toBe('windows');
  });
});
