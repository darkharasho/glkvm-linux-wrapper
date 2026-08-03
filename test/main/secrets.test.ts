import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSecretsStore, type SafeStorageLike } from '../../src/main/services/secrets';

// Fake safeStorage: "encrypts" by prefixing a tag so we can assert ciphertext != plaintext.
function fakeSafe(available = true): SafeStorageLike {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (p) => Buffer.from('ENC:' + p, 'utf8'),
    decryptString: (c) => {
      const s = c.toString('utf8');
      if (!s.startsWith('ENC:')) throw new Error('bad cipher');
      return s.slice(4);
    },
  };
}

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'glkvm-sec-')); });

describe('secrets store', () => {
  it('round-trips a password across reloads and stores only ciphertext', () => {
    const s = createSecretsStore(dir, fakeSafe());
    expect(s.set('dev1', 'hunter2')).toBe(true);
    expect(s.has('dev1')).toBe(true);
    expect(createSecretsStore(dir, fakeSafe()).get('dev1')).toBe('hunter2');
    const onDisk = readFileSync(join(dir, 'secrets.json'), 'utf8');
    expect(onDisk).not.toContain('hunter2'); // never plaintext
  });

  it('refuses to save and writes nothing when encryption is unavailable', () => {
    const s = createSecretsStore(dir, fakeSafe(false));
    expect(s.isAvailable()).toBe(false);
    expect(s.set('dev1', 'hunter2')).toBe(false);
    expect(existsSync(join(dir, 'secrets.json'))).toBe(false);
  });

  it('returns null on missing entry and on decryption failure', () => {
    const s = createSecretsStore(dir, fakeSafe());
    expect(s.get('nope')).toBeNull();
    // Corrupt cipher: decryptString throws -> get returns null, not crash.
    const bad = createSecretsStore(dir, {
      isEncryptionAvailable: () => true,
      encryptString: () => Buffer.from('not-tagged', 'utf8'),
      decryptString: fakeSafe().decryptString,
    });
    bad.set('dev1', 'x');
    expect(bad.get('dev1')).toBeNull();
  });

  it('clears a stored password', () => {
    const s = createSecretsStore(dir, fakeSafe());
    s.set('dev1', 'hunter2');
    s.clear('dev1');
    expect(s.has('dev1')).toBe(false);
    expect(createSecretsStore(dir, fakeSafe()).get('dev1')).toBeNull();
  });

  it('writes atomically (no leftover temp file)', () => {
    const s = createSecretsStore(dir, fakeSafe());
    s.set('dev1', 'hunter2');
    expect(existsSync(join(dir, 'secrets.json.tmp'))).toBe(false);
  });

  it('lists ids that have a stored secret', () => {
    const s = createSecretsStore(dir, fakeSafe());
    s.set('a', 'x'); s.set('b', 'y'); s.clear('a');
    expect(createSecretsStore(dir, fakeSafe()).ids().sort()).toEqual(['b']);
  });
});
