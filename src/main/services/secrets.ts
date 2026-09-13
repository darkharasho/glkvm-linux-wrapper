import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ChangeEvent } from '@shared/sync/format';

export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plain: string): Buffer;
  decryptString(cipher: Buffer): string;
}

export interface SecretsStore {
  isAvailable(): boolean;
  /** Encrypt + persist. Returns false (writing nothing) if encryption is unavailable. */
  set(deviceId: string, password: string): boolean;
  /** Decrypt. Returns null if absent or on decryption failure. Main-process only — never crosses IPC. */
  get(deviceId: string): string | null;
  has(deviceId: string): boolean;
  clear(deviceId: string): void;
  ids(): string[];
  onChange(listener: (e: ChangeEvent) => void): void;
  /** Sync-only: make the stored set exactly `passwords`. Emits no change events. No-op without encryption. */
  replaceAll(passwords: Record<string, string>): void;
}

// secrets.json maps deviceId -> base64(ciphertext). Only ciphertext is ever written.
type SecretsFile = Record<string, string>;

function writeJsonAtomic(file: string, data: unknown): void {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  renameSync(tmp, file);
}

export function createSecretsStore(baseDir: string, safe: SafeStorageLike): SecretsStore {
  const file = join(baseDir, 'secrets.json');

  let data: SecretsFile = {};
  if (existsSync(file)) {
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8'));
      if (raw && typeof raw === 'object') {
        for (const [k, v] of Object.entries(raw)) if (typeof v === 'string') data[k] = v;
      }
    } catch {
      try { renameSync(file, `${file}.bak`); } catch { /* ignore */ }
      data = {};
    }
  }

  const save = () => writeJsonAtomic(file, data);

  const listeners: Array<(e: ChangeEvent) => void> = [];
  const emit = (e: ChangeEvent) => { for (const l of listeners) l(e); };
  const decryptOrNull = (b64: string | undefined): string | null => {
    if (!b64) return null;
    try { return safe.decryptString(Buffer.from(b64, 'base64')); } catch { return null; }
  };

  return {
    isAvailable: () => safe.isEncryptionAvailable(),
    set(deviceId, password) {
      if (!safe.isEncryptionAvailable()) return false;
      data = { ...data, [deviceId]: safe.encryptString(password).toString('base64') };
      save();
      emit({ kind: 'secret', id: deviceId });
      return true;
    },
    get: (deviceId) => decryptOrNull(data[deviceId]),
    has: (deviceId) => typeof data[deviceId] === 'string' && data[deviceId].length > 0,
    clear(deviceId) {
      if (!(deviceId in data)) return;
      const next = { ...data };
      delete next[deviceId];
      data = next;
      save();
      emit({ kind: 'secret-removed', id: deviceId });
    },
    ids: () => Object.keys(data),
    onChange(listener) { listeners.push(listener); },
    replaceAll(passwords) {
      if (!safe.isEncryptionAvailable()) return;
      const next: SecretsFile = {};
      for (const [id, pw] of Object.entries(passwords)) {
        next[id] = decryptOrNull(data[id]) === pw ? data[id] : safe.encryptString(pw).toString('base64');
      }
      data = next;
      save();
    },
  };
}
