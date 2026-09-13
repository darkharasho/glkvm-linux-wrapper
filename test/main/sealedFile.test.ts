import { describe, it, expect, beforeEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSealedFile } from '../../src/main/services/sealedFile';
import type { SafeStorageLike } from '../../src/main/services/secrets';

function fakeSafe(available = true): SafeStorageLike {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (p) => Buffer.from('ENC:' + Buffer.from(p).toString('base64'), 'utf8'),
    decryptString: (c) => {
      const s = c.toString('utf8');
      if (!s.startsWith('ENC:')) throw new Error('bad cipher');
      return Buffer.from(s.slice(4), 'base64').toString('utf8');
    },
  };
}

let file: string;
beforeEach(() => { file = join(mkdtempSync(join(tmpdir(), 'glkvm-sealed-')), 'value.json'); });

describe('sealed file', () => {
  it('persists only ciphertext and reads it back in a new instance', () => {
    createSealedFile(file, fakeSafe()).write('token-123');
    expect(readFileSync(file, 'utf8')).not.toContain('token-123');
    expect(createSealedFile(file, fakeSafe()).read()).toBe('token-123');
  });

  it('keeps the value in memory only when encryption is unavailable', () => {
    const s = createSealedFile(file, fakeSafe(false));
    s.write('token-123');
    expect(s.read()).toBe('token-123');
    expect(s.persistent()).toBe(false);
    expect(existsSync(file)).toBe(false);
  });

  it('clears the value and file, and returns null for corrupt files', () => {
    const s = createSealedFile(file, fakeSafe());
    s.write('token-123');
    s.clear();
    expect(s.read()).toBeNull();
    expect(existsSync(file)).toBe(false);
    writeFileSync(file, 'not encrypted');
    expect(createSealedFile(file, fakeSafe()).read()).toBeNull();
  });
});
