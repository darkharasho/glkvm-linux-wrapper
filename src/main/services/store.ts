import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Device, Settings, BackupBundle } from '@shared/types';
import { DEFAULT_SETTINGS, validateDevices, validateSettings } from '@shared/schema';
import { toDeviceUrl, normalizeAddress } from '@shared/url';
import { applyBackup, buildBackup } from '@shared/backup';
import type { TrustStore } from '@shared/certs';

function readJson<T>(file: string, fallback: T, validate: (raw: unknown) => T): T {
  if (!existsSync(file)) return fallback;
  try {
    return validate(JSON.parse(readFileSync(file, 'utf8')));
  } catch {
    try { renameSync(file, `${file}.bak`); } catch { /* ignore */ }
    return fallback;
  }
}

function writeJsonAtomic(file: string, data: unknown): void {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  renameSync(tmp, file);
}

export function createStore(baseDir: string) {
  const devicesFile = join(baseDir, 'devices.json');
  const settingsFile = join(baseDir, 'settings.json');
  const certsFile = join(baseDir, 'trusted-certs.json');

  let devices = readJson<Device[]>(devicesFile, [], validateDevices);
  let settings = readJson<Settings>(settingsFile, DEFAULT_SETTINGS, validateSettings);
  let trust = readJson<TrustStore>(certsFile, {}, (r) => (typeof r === 'object' && r ? r as TrustStore : {}));

  const saveDevices = () => writeJsonAtomic(devicesFile, devices);
  const saveSettings = () => writeJsonAtomic(settingsFile, settings);
  const saveTrust = () => writeJsonAtomic(certsFile, trust);

  return {
    getDevices: () => devices,
    addDevice(input: { name: string; address: string; color?: string }): Device {
      const address = normalizeAddress(input.address);
      const d: Device = {
        id: randomUUID(), name: input.name, address, url: toDeviceUrl(address),
        color: input.color, createdAt: Date.now(),
      };
      devices = [...devices, d];
      saveDevices();
      return d;
    },
    updateDevice(id: string, patch: Partial<Pick<Device, 'name' | 'address' | 'color'>>): Device | null {
      const i = devices.findIndex(d => d.id === id);
      if (i === -1) return null;
      const address = patch.address ? normalizeAddress(patch.address) : devices[i].address;
      const updated: Device = { ...devices[i], ...patch, address, url: toDeviceUrl(address) };
      devices = devices.map(d => d.id === id ? updated : d);
      saveDevices();
      return updated;
    },
    removeDevice(id: string) { devices = devices.filter(d => d.id !== id); saveDevices(); },
    getSettings: () => settings,
    setSettings(next: Settings) { settings = validateSettings(next); saveSettings(); },
    getTrustStore: () => trust,
    trustCert(host: string, fingerprint: string) { trust = { ...trust, [host]: fingerprint }; saveTrust(); },
    applyImport(bundle: BackupBundle, mode: 'merge' | 'replace') {
      const out = applyBackup({ devices, settings }, bundle, mode);
      devices = out.devices; settings = out.settings;
      saveDevices(); saveSettings();
    },
    exportBundle: (): BackupBundle => buildBackup(devices, settings),
  };
}
