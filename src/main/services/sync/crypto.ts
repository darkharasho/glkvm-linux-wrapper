import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import type { CryptoHeader, EncryptedBlob } from '@shared/sync/format';

export const CHECK_PLAINTEXT = 'glkvm-sync-check';
export const KDF_PARAMS = { N: 1 << 15, r: 8, p: 1 };
export const MIN_PASSPHRASE_LENGTH = 8;
const KEY_BYTES = 32;

export interface SyncKey { keyId: string; key: Buffer; }

function deriveKey(passphrase: string, h: { salt: string; N: number; r: number; p: number }): Buffer {
  return scryptSync(passphrase.normalize('NFC'), Buffer.from(h.salt, 'base64'), KEY_BYTES, {
    N: h.N, r: h.r, p: h.p, maxmem: 256 * 1024 * 1024,
  });
}

export function encrypt(key: Buffer, plaintext: string): EncryptedBlob {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ct: ct.toString('base64') };
}

export function decrypt(key: Buffer, blob: EncryptedBlob): string {
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(blob.iv, 'base64'), { authTagLength: 16 });
  decipher.setAuthTag(Buffer.from(blob.tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(blob.ct, 'base64')), decipher.final()]).toString('utf8');
}

export function createHeader(passphrase: string, kdf = KDF_PARAMS): { header: CryptoHeader; key: SyncKey } {
  const salt = randomBytes(16).toString('base64');
  const keyId = randomBytes(12).toString('hex');
  const key = deriveKey(passphrase, { salt, ...kdf });
  return {
    header: { keyId, kdf: 'scrypt', salt, ...kdf, check: encrypt(key, CHECK_PLAINTEXT) },
    key: { keyId, key },
  };
}

export function unlock(passphrase: string, header: CryptoHeader): SyncKey | null {
  const key = deriveKey(passphrase, header);
  try {
    return decrypt(key, header.check) === CHECK_PLAINTEXT ? { keyId: header.keyId, key } : null;
  } catch {
    return null;
  }
}

export function serializeKey(k: SyncKey): string {
  return JSON.stringify({ keyId: k.keyId, key: k.key.toString('base64') });
}

export function parseKey(raw: string | null): SyncKey | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as { keyId?: unknown; key?: unknown };
    if (typeof v.keyId !== 'string' || typeof v.key !== 'string') return null;
    const key = Buffer.from(v.key, 'base64');
    return key.length === KEY_BYTES ? { keyId: v.keyId, key } : null;
  } catch {
    return null;
  }
}
