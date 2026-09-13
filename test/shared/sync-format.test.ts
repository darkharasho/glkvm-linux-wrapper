import { describe, it, expect } from 'vitest';
import {
  canonicalJson, emptyDoc, emptyState, parseSyncDoc, parseSyncState, isLive, SYNC_FORMAT,
} from '../../src/shared/sync/format';
import { DEFAULT_SETTINGS } from '../../src/shared/schema';

const device = (id: string, extra: Record<string, unknown> = {}) => ({
  id, name: 'Lab', address: 'kvm-a.local', url: 'https://kvm-a.local', os: 'linux', createdAt: 1, ...extra,
});
const blob = { iv: 'aXY=', tag: 'dGFn', ct: 'Y3Q=' };
const header = { keyId: 'k1', kdf: 'scrypt', salt: 'c2FsdA==', N: 32768, r: 8, p: 1, check: blob };

describe('canonicalJson', () => {
  it('is independent of object key order and drops undefined', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: undefined, e: [3, { z: 1, y: 2 }] } }))
      .toBe(canonicalJson({ a: { e: [3, { y: 2, z: 1 }], d: 2 }, b: 1 }));
  });
});

describe('parseSyncDoc', () => {
  it('round-trips a valid document', () => {
    const doc = {
      format: SYNC_FORMAT,
      crypto: header,
      settings: { updatedAt: 5, data: DEFAULT_SETTINGS },
      devices: { d1: { updatedAt: 3, data: device('d1') }, d2: { updatedAt: 4, deletedAt: 4 } },
      certs: { 'kvm-a.local': { updatedAt: 2, data: 'AB:CD' } },
      secrets: { d1: { updatedAt: 3, data: blob } },
    };
    const parsed = parseSyncDoc(JSON.stringify(doc));
    expect(canonicalJson(parsed)).toBe(canonicalJson(doc));
    expect(isLive(parsed.devices.d1)).toBe(true);
    expect(isLive(parsed.devices.d2)).toBe(false);
  });

  it('throws on invalid JSON, unknown format and a bad crypto header', () => {
    expect(() => parseSyncDoc('{nope')).toThrow();
    expect(() => parseSyncDoc(JSON.stringify({ ...emptyDoc(), format: 2 }))).toThrow();
    expect(() => parseSyncDoc(JSON.stringify({ ...emptyDoc(), crypto: { ...header, N: 1000 } }))).toThrow();
  });

  it('drops invalid entries but keeps the rest', () => {
    const parsed = parseSyncDoc(JSON.stringify({
      ...emptyDoc(),
      devices: {
        ok: { updatedAt: 1, data: device('ok') },
        badColor: { updatedAt: 1, data: device('badColor', { color: 'url(http://x)' }) },
        idMismatch: { updatedAt: 1, data: device('other') },
        noStamp: { data: device('noStamp') },
      },
      certs: { 'kvm-a.local': { updatedAt: 1, data: 42 } },
      secrets: { ok: { updatedAt: 1, data: { iv: '!!', tag: 'x', ct: 'y' } } },
    }));
    expect(Object.keys(parsed.devices)).toEqual(['ok']);
    expect(parsed.certs).toEqual({});
    expect(parsed.secrets).toEqual({});
  });
});

describe('parseSyncState', () => {
  it('returns an empty state for garbage and keeps valid stamps', () => {
    expect(parseSyncState('nope')).toEqual(emptyState());
    const s = parseSyncState({ settings: 7, devices: { a: 1, b: 'x' }, deleted: { certs: { h: 2 } } });
    expect(s.settings).toBe(7);
    expect(s.devices).toEqual({ a: 1 });
    expect(s.deleted.certs).toEqual({ h: 2 });
  });
});
