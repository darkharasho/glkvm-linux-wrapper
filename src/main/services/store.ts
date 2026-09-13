import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Device, Settings, BackupBundle, OsKind } from '@shared/types';
import { DEFAULT_SETTINGS, validateDevices, validateSettings, coerceOs } from '@shared/schema';
import { toDeviceUrl, normalizeAddress } from '@shared/url';
import { applyBackup, buildBackup } from '@shared/backup';
import type { TrustStore } from '@shared/certs';
import type { ChangeEvent } from '@shared/sync/format';

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

  const listeners: Array<(e: ChangeEvent) => void> = [];
  const emit = (e: ChangeEvent) => { for (const l of listeners) l(e); };

  return {
    onChange(listener: (e: ChangeEvent) => void) { listeners.push(listener); },
    getDevices: () => devices,
    addDevice(input: { name: string; address: string; color?: string; os?: OsKind }): Device {
      const address = normalizeAddress(input.address);
      const d: Device = {
        id: randomUUID(), name: input.name, address, url: toDeviceUrl(address),
        color: input.color, createdAt: Date.now(), os: coerceOs(input.os),
      };
      devices = [...devices, d];
      saveDevices();
      emit({ kind: 'device', id: d.id });
      return d;
    },
    updateDevice(id: string, patch: Partial<Pick<Device, 'name' | 'address' | 'color' | 'os'>>): Device | null {
      const i = devices.findIndex(d => d.id === id);
      if (i === -1) return null;
      const address = patch.address ? normalizeAddress(patch.address) : devices[i].address;
      const updated: Device = { ...devices[i], ...patch, address, url: toDeviceUrl(address), os: coerceOs(patch.os ?? devices[i].os) };
      if (JSON.stringify(updated) === JSON.stringify(devices[i])) return devices[i];
      devices = devices.map(d => d.id === id ? updated : d);
      saveDevices();
      emit({ kind: 'device', id });
      return updated;
    },
    removeDevice(id: string) {
      const existed = devices.some(d => d.id === id);
      devices = devices.filter(d => d.id !== id);
      saveDevices();
      if (existed) emit({ kind: 'device-removed', id });
    },
    getSettings: () => settings,
    setSettings(next: Settings) {
      const validated = validateSettings(next);
      if (JSON.stringify(validated) === JSON.stringify(settings)) return;
      settings = validated;
      saveSettings();
      emit({ kind: 'settings' });
    },
    getTrustStore: () => trust,
    trustCert(host: string, fingerprint: string) {
      if (trust[host] === fingerprint) return;
      trust = { ...trust, [host]: fingerprint };
      saveTrust();
      emit({ kind: 'cert', host });
    },
    untrustHost(host: string) {
      if (!(host in trust)) return;
      const next = { ...trust };
      delete next[host];
      trust = next;
      saveTrust();
      emit({ kind: 'cert-removed', host });
    },
    applyImport(bundle: BackupBundle, mode: 'merge' | 'replace') {
      const before = new Map(devices.map(d => [d.id, JSON.stringify(d)]));
      const settingsBefore = JSON.stringify(settings);
      const out = applyBackup({ devices, settings }, bundle, mode);
      devices = out.devices; settings = out.settings;
      saveDevices(); saveSettings();
      const after = new Set(devices.map(d => d.id));
      for (const d of devices) if (before.get(d.id) !== JSON.stringify(d)) emit({ kind: 'device', id: d.id });
      for (const id of before.keys()) if (!after.has(id)) emit({ kind: 'device-removed', id });
      if (JSON.stringify(settings) !== settingsBefore) emit({ kind: 'settings' });
    },
    exportBundle: (): BackupBundle => buildBackup(devices, settings),
    /** Sync-only: replace local data with merged results. Deliberately emits no change events. */
    applySynced(next: { devices?: Device[]; settings?: Settings; certs?: TrustStore }) {
      if (next.devices) { devices = validateDevices(next.devices); saveDevices(); }
      if (next.settings) { settings = validateSettings(next.settings); saveSettings(); }
      if (next.certs) { trust = { ...next.certs }; saveTrust(); }
    },
  };
}
