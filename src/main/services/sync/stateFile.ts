import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { emptyState, parseSyncState, type SyncState } from '@shared/sync/format';

export interface SyncStateFile {
  load(): SyncState;
  save(state: SyncState): void;
}

export function createSyncStateFile(dir: string): SyncStateFile {
  const file = join(dir, 'sync-state.json');
  return {
    load() {
      if (!existsSync(file)) return emptyState();
      try { return parseSyncState(JSON.parse(readFileSync(file, 'utf8'))); } catch { return emptyState(); }
    },
    save(state) {
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, JSON.stringify(state), 'utf8');
      renameSync(tmp, file);
    },
  };
}
