import type { Device, OsKind, Settings } from '@shared/types';
import type { SyncOverview, SyncResult } from '@shared/sync/format';

export interface GlkvmApi {
  listDevices(): Promise<Device[]>;
  addDevice(input: { name: string; address: string; color?: string; os?: OsKind }): Promise<Device>;
  updateDevice(id: string, patch: Partial<Pick<Device, 'name' | 'address' | 'color' | 'os'>>): Promise<Device | null>;
  removeDevice(id: string): Promise<void>;
  setPassword(id: string, password: string): Promise<boolean>;
  hasPassword(id: string): Promise<boolean>;
  clearPassword(id: string): Promise<void>;
  secretsAvailable(): Promise<boolean>;
  listPasswordIds(): Promise<string[]>;
  getSettings(): Promise<Settings>;
  setSettings(next: Settings): Promise<void>;
  connect(id: string): Promise<void>;
  disconnect(): Promise<void>;
  exportBackup(): Promise<void>;   // opens save dialog in main
  importBackup(): Promise<void>;   // opens open dialog + merge/replace prompt in main
  onConnectionState(cb: (s: { deviceId: string | null; state: 'loading' | 'ready' | 'error'; message?: string }) => void): void;
  onConnectedDevices(cb: (ids: string[]) => void): void;
  onNavigate(cb: (view: 'dashboard' | 'device' | 'settings') => void): void;
  onModalShow(cb: (spec: { id: number; kind: string; [k: string]: unknown }) => void): void;
  modalDone(id: number, value: string): void;
  syncOverview(): Promise<SyncOverview>;
  githubStartAuth(): Promise<{ ok: true; userCode: string; verificationUri: string; expiresIn: number } | { ok: false; error: string }>;
  githubOpenVerification(): Promise<void>;
  githubCancelAuth(): Promise<void>;
  githubSignOut(): Promise<void>;
  syncNow(): Promise<void>;
  syncSetPassphrase(passphrase: string): Promise<SyncResult>;
  syncEnterPassphrase(passphrase: string): Promise<SyncResult>;
  syncChangePassphrase(current: string, next: string): Promise<SyncResult>;
  syncResetPassphrase(next: string): Promise<SyncResult>;
  /** Each on* subscription returns an unsubscribe function. */
  onSyncOverview(cb: (overview: SyncOverview) => void): () => void;
  onGithubAuthError(cb: (message: string) => void): () => void;
  onSyncApplied(cb: () => void): () => void;
}
declare global { interface Window { glkvm: GlkvmApi; } }
