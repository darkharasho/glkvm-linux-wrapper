import { describe, it, expect } from 'vitest';
import {
  createHeader, decrypt, encrypt, parseKey, serializeKey, unlock, KDF_PARAMS,
} from '../../src/main/services/sync/crypto';

const FAST = { N: 1024, r: 8, p: 1 };

describe('sync crypto', () => {
  it('round-trips with the right key and rejects tampering', () => {
    const { key } = createHeader('correct horse', FAST);
    const blob = encrypt(key.key, 'hunter2');
    expect(blob.ct).not.toContain('hunter2');
    expect(decrypt(key.key, blob)).toBe('hunter2');
    const flipped = Buffer.from(blob.ct, 'base64');
    flipped[0] ^= 1;
    expect(() => decrypt(key.key, { ...blob, ct: flipped.toString('base64') })).toThrow();
    expect(() => decrypt(key.key, { ...blob, tag: Buffer.from('short').toString('base64') })).toThrow();
  });

  it('unlocks with the right passphrase only', () => {
    const { header, key } = createHeader('correct horse', FAST);
    const unlocked = unlock('correct horse', header);
    expect(unlocked?.keyId).toBe(header.keyId);
    expect(unlocked?.key.equals(key.key)).toBe(true);
    expect(unlock('wrong horse', header)).toBeNull();
  });

  it('gives a new salt and keyId every time', () => {
    const a = createHeader('same passphrase', FAST);
    const b = createHeader('same passphrase', FAST);
    expect(a.header.salt).not.toBe(b.header.salt);
    expect(a.header.keyId).not.toBe(b.header.keyId);
    expect(() => decrypt(b.key.key, encrypt(a.key.key, 'x'))).toThrow();
  });

  it('uses the spec parameters by default', () => {
    const { header } = createHeader('correct horse');
    expect({ N: header.N, r: header.r, p: header.p }).toEqual(KDF_PARAMS);
    expect(Buffer.from(header.salt, 'base64')).toHaveLength(16);
  });

  it('serializes keys and rejects malformed ones', () => {
    const { key } = createHeader('correct horse', FAST);
    const back = parseKey(serializeKey(key));
    expect(back?.keyId).toBe(key.keyId);
    expect(back?.key.equals(key.key)).toBe(true);
    expect(parseKey(null)).toBeNull();
    expect(parseKey('{"keyId":"x","key":"c2hvcnQ="}')).toBeNull();
    expect(parseKey('garbage')).toBeNull();
  });
});
