import type { Device, OsKind, Settings } from '@shared/types';

export interface GlkvmApi {
  listDevices(): Promise<Device[]>;
  addDevice(input: { name: string; address: string; color?: string; os?: OsKind }): Promise<Device>;
  updateDevice(id: string, patch: Partial<Pick<Device, 'name' | 'address' | 'color' | 'os'>>): Promise<Device | null>;
  removeDevice(id: string): Promise<void>;
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
}
declare global { interface Window { glkvm: GlkvmApi; } }
