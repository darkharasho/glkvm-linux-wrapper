import type { Device, Settings, BackupBundle } from './types';
import { SCHEMA_VERSION, validateDevices, validateSettings } from './schema';

export function buildBackup(devices: Device[], settings: Settings): BackupBundle {
  return { version: SCHEMA_VERSION, devices, settings };
}

export function parseBackup(json: string): BackupBundle {
  let raw: unknown;
  try { raw = JSON.parse(json); } catch { throw new Error('Invalid backup file'); }
  if (typeof raw !== 'object' || raw === null) throw new Error('Invalid backup file');
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.devices) || typeof r.settings !== 'object' || r.settings === null) {
    throw new Error('Invalid backup file');
  }
  return {
    version: typeof r.version === 'number' ? r.version : SCHEMA_VERSION,
    devices: validateDevices(r.devices),
    settings: validateSettings(r.settings),
  };
}

export function mergeDevices(current: Device[], incoming: Device[]): Device[] {
  const byId = new Map(current.map(d => [d.id, d]));
  for (const d of incoming) byId.set(d.id, d);
  // collapse address collisions, keeping the last writer
  const byAddress = new Map<string, Device>();
  for (const d of byId.values()) byAddress.set(d.address, d);
  return [...byAddress.values()];
}

export function applyBackup(
  current: { devices: Device[]; settings: Settings },
  bundle: BackupBundle,
  mode: 'merge' | 'replace',
): { devices: Device[]; settings: Settings } {
  if (mode === 'replace') return { devices: bundle.devices, settings: bundle.settings };
  return { devices: mergeDevices(current.devices, bundle.devices), settings: bundle.settings };
}
