import type { Device, Settings } from '../types';
import type { TrustStore } from '../certs';
import {
  MARKER_TTL_MS, canonicalJson, isLive, type Entry, type Stamped, type SyncState, type Tombstone,
} from './format';

export interface LocalSnapshot {
  devices: Device[];
  settings: Settings;
  certs: TrustStore;
  secrets: Record<string, string> | null;
}

export interface RemoteView {
  settings: Stamped<Settings> | null;
  devices: Record<string, Entry<Device>>;
  certs: Record<string, Entry<string>>;
  secrets: Record<string, Entry<string>> | null;
}

export interface MergeResult {
  remote: {
    settings: Stamped<Settings>;
    devices: Record<string, Entry<Device>>;
    certs: Record<string, Entry<string>>;
    secrets: Record<string, Entry<string>> | null;
  };
  local: LocalSnapshot;
  state: SyncState;
  changed: { devices: boolean; settings: boolean; certs: boolean; secrets: boolean };
}

interface Collection<T> {
  entries: Record<string, Entry<T>>;
  items: Record<string, T>;
  stamps: Record<string, number>;
  deleted: Record<string, number>;
}

const has = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);
const tombstone = (at: number): Tombstone => ({ updatedAt: at, deletedAt: at });

function setEntry<T>(c: Collection<T>, k: string, e: Entry<T>): void {
  c.entries[k] = e;
  delete c.items[k]; delete c.stamps[k]; delete c.deleted[k];
  if (isLive(e)) { c.items[k] = e.data; c.stamps[k] = e.updatedAt; }
  else c.deleted[k] = e.updatedAt;
}

function mergeCollection<T>(
  items: Record<string, T>, stamps: Record<string, number>, deleted: Record<string, number>,
  remote: Record<string, Entry<T>>,
): Collection<T> {
  const out: Collection<T> = { entries: {}, items: {}, stamps: {}, deleted: {} };
  const keys = new Set([...Object.keys(items), ...Object.keys(deleted), ...Object.keys(remote)]);
  for (const k of keys) {
    let mine: Entry<T> | undefined;
    if (has(items, k)) mine = { updatedAt: has(stamps, k) ? stamps[k] : 0, data: items[k] };
    else if (has(deleted, k)) mine = tombstone(deleted[k]);
    const theirs = has(remote, k) ? remote[k] : undefined;
    const winner = !mine ? theirs! : !theirs ? mine : mine.updatedAt > theirs.updatedAt ? mine : theirs;
    setEntry(out, k, winner);
  }
  return out;
}

function expire<T>(c: Collection<T>, cutoff: number): void {
  for (const [k, e] of Object.entries(c.entries)) {
    if (!isLive(e) && e.updatedAt < cutoff) { delete c.entries[k]; delete c.deleted[k]; }
  }
}

export function mergeSync(local: LocalSnapshot, state: SyncState, remote: RemoteView, now: number): MergeResult {
  const mySettings: Stamped<Settings> = { updatedAt: state.settings, data: local.settings };
  const settings = remote.settings && remote.settings.updatedAt >= mySettings.updatedAt ? remote.settings : mySettings;

  const devices = mergeCollection(
    Object.fromEntries(local.devices.map(d => [d.id, d])), state.devices, state.deleted.devices, remote.devices,
  );
  const certs = mergeCollection(local.certs, state.certs, state.deleted.certs, remote.certs);
  const secrets = local.secrets && remote.secrets
    ? mergeCollection(local.secrets, state.secrets, state.deleted.secrets, remote.secrets)
    : null;

  // Collapse duplicate addresses only when passwords are being merged too, so the dropped device's
  // password can move to the kept one. Without a key, duplicates wait for a machine that has one.
  if (secrets) {
    const byAddress = new Map<string, string>();
    for (const id of Object.keys(devices.items).sort()) {
      const address = devices.items[id].address;
      const otherId = byAddress.get(address);
      if (otherId === undefined) { byAddress.set(address, id); continue; }
      const [keep, drop] = devices.stamps[id] > devices.stamps[otherId] ? [id, otherId] : [otherId, id];
      const at = devices.stamps[keep];
      byAddress.set(address, keep);
      if (has(secrets.items, drop) && !has(secrets.items, keep)) {
        setEntry(secrets, keep, { updatedAt: at, data: secrets.items[drop] });
      }
      setEntry(devices, drop, tombstone(at));
    }
  }

  if (secrets) {
    for (const [id, e] of Object.entries(devices.entries)) {
      if (!isLive(e) && has(secrets.items, id) && secrets.stamps[id] <= e.updatedAt) {
        setEntry(secrets, id, tombstone(e.updatedAt));
      }
    }
  }

  const cutoff = now - MARKER_TTL_MS;
  expire(devices, cutoff);
  expire(certs, cutoff);
  if (secrets) expire(secrets, cutoff);

  const localIds = new Set(local.devices.map(d => d.id));
  const nextDevices = [
    ...local.devices.filter(d => has(devices.items, d.id)).map(d => devices.items[d.id]),
    ...Object.values(devices.items)
      .filter(d => !localIds.has(d.id))
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)),
  ];

  return {
    remote: { settings, devices: devices.entries, certs: certs.entries, secrets: secrets ? secrets.entries : null },
    local: { devices: nextDevices, settings: settings.data, certs: certs.items, secrets: secrets ? secrets.items : local.secrets },
    state: {
      settings: settings.updatedAt,
      devices: devices.stamps,
      certs: certs.stamps,
      secrets: secrets ? secrets.stamps : state.secrets,
      deleted: {
        devices: devices.deleted,
        certs: certs.deleted,
        secrets: secrets ? secrets.deleted : state.deleted.secrets,
      },
    },
    changed: {
      devices: canonicalJson(nextDevices) !== canonicalJson(local.devices),
      settings: canonicalJson(settings.data) !== canonicalJson(local.settings),
      certs: canonicalJson(certs.items) !== canonicalJson(local.certs),
      secrets: !!secrets && canonicalJson(secrets.items) !== canonicalJson(local.secrets),
    },
  };
}
