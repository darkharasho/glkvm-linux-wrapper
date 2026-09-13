import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import type { SafeStorageLike } from './secrets';

export interface SealedFile {
  read(): string | null;
  write(value: string): void;
  clear(): void;
  /** False when the OS keychain is unavailable and the value lives only for this session. */
  persistent(): boolean;
}

export function createSealedFile(file: string, safe: SafeStorageLike): SealedFile {
  let memory: string | null = null;
  return {
    persistent: () => safe.isEncryptionAvailable(),
    read() {
      if (memory !== null) return memory;
      if (!safe.isEncryptionAvailable() || !existsSync(file)) return null;
      try {
        memory = safe.decryptString(readFileSync(file));
        return memory;
      } catch {
        return null;
      }
    },
    write(value) {
      memory = value;
      if (!safe.isEncryptionAvailable()) return;
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, safe.encryptString(value));
      renameSync(tmp, file);
    },
    clear() {
      memory = null;
      rmSync(file, { force: true });
    },
  };
}
