import type { Device, Settings } from '../types';
import { validateDevices, validateSettings } from '../schema';

export const SYNC_FORMAT = 1;
export const SYNC_REPO = 'glkvm-config';
export const SYNC_FILE = 'glkvm-sync.json';
export const MARKER_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const MAX_SCRYPT_N = 1 << 17;

export interface EncryptedBlob { iv: string; tag: string; ct: string; }
export interface CryptoHeader {
  keyId: string; kdf: 'scrypt'; salt: string; N: number; r: number; p: number; check: EncryptedBlob;
}
export interface Stamped<T> { updatedAt: number; data: T; }
export interface Tombstone { updatedAt: number; deletedAt: number; }
export type Entry<T> = Stamped<T> | Tombstone;

export interface SyncDoc {
  format: typeof SYNC_FORMAT;
  crypto: CryptoHeader | null;
  settings: Stamped<Settings> | null;
  devices: Record<string, Entry<Device>>;
  certs: Record<string, Entry<string>>;
  secrets: Record<string, Entry<EncryptedBlob>>;
}

export interface SyncState {
  settings: number;
  devices: Record<string, number>;
  certs: Record<string, number>;
  secrets: Record<string, number>;
  deleted: { devices: Record<string, number>; certs: Record<string, number>; secrets: Record<string, number> };
}

export type ChangeEvent =
  | { kind: 'device'; id: string } | { kind: 'device-removed'; id: string }
  | { kind: 'settings' }
  | { kind: 'cert'; host: string } | { kind: 'cert-removed'; host: string }
  | { kind: 'secret'; id: string } | { kind: 'secret-removed'; id: string };

export interface GithubUser { login: string; name: string; avatarUrl: string; }
export interface SyncStatus { state: 'idle' | 'syncing' | 'synced' | 'error'; lastSynced?: number; error?: string; }
export type PasswordsState = 'unknown' | 'syncing' | 'needs-set' | 'needs-passphrase' | 'unavailable';
export interface SyncOverview { user: GithubUser | null; configured: boolean; sync: SyncStatus; passwords: PasswordsState; }
export type SyncResult = { ok: true } | { ok: false; error: string };

export function isLive<T>(e: Entry<T>): e is Stamped<T> {
  return 'data' in e;
}

export function emptyDoc(): SyncDoc {
  return { format: SYNC_FORMAT, crypto: null, settings: null, devices: {}, certs: {}, secrets: {} };
}

export function emptyState(): SyncState {
  return { settings: 0, devices: {}, certs: {}, secrets: {}, deleted: { devices: {}, certs: {}, secrets: {} } };
}

/** JSON with object keys sorted, so equal data always serializes identically. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v).sort()) {
      const x = (v as Record<string, unknown>)[k];
      if (x !== undefined) out[k] = sortKeys(x);
    }
    return out;
  }
  return v;
}

const obj = (v: unknown): Record<string, unknown> | null =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : null;
const isTime = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const isB64 = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9+/]*={0,2}$/.test(v);

function parseBlob(v: unknown): EncryptedBlob | null {
  const b = obj(v);
  return b && isB64(b.iv) && isB64(b.tag) && isB64(b.ct) ? { iv: b.iv, tag: b.tag, ct: b.ct } : null;
}

function parseCrypto(v: unknown): CryptoHeader | null {
  const c = obj(v);
  if (!c) return null;
  const check = parseBlob(c.check);
  const { N, r, p } = c;
  const okN = typeof N === 'number' && Number.isInteger(N) && N >= 2 && N <= MAX_SCRYPT_N && (N & (N - 1)) === 0;
  const okR = typeof r === 'number' && Number.isInteger(r) && r >= 1 && r <= 8;
  const okP = typeof p === 'number' && Number.isInteger(p) && p >= 1 && p <= 2;
  if (typeof c.keyId !== 'string' || !c.keyId || c.kdf !== 'scrypt' || !isB64(c.salt) || !okN || !okR || !okP || !check) {
    return null;
  }
  return { keyId: c.keyId, kdf: 'scrypt', salt: c.salt, N: N as number, r: r as number, p: p as number, check };
}

function parseEntries<T>(raw: unknown, parseData: (key: string, data: unknown) => T | null): Record<string, Entry<T>> {
  const out: Record<string, Entry<T>> = {};
  const r = obj(raw);
  if (!r) return out;
  for (const [k, v] of Object.entries(r)) {
    const e = obj(v);
    if (!e || !isTime(e.updatedAt)) continue;
    if ('deletedAt' in e) {
      if (isTime(e.deletedAt)) out[k] = { updatedAt: e.updatedAt, deletedAt: e.deletedAt };
      continue;
    }
    const data = parseData(k, e.data);
    if (data !== null) out[k] = { updatedAt: e.updatedAt, data };
  }
  return out;
}

export function parseSyncDoc(json: string): SyncDoc {
  let raw: unknown;
  try { raw = JSON.parse(json); } catch { throw new Error('not valid JSON'); }
  const r = obj(raw);
  if (!r || r.format !== SYNC_FORMAT) throw new Error('unsupported format');
  let crypto: CryptoHeader | null = null;
  if (r.crypto !== null && r.crypto !== undefined) {
    crypto = parseCrypto(r.crypto);
    if (!crypto) throw new Error('invalid encryption header');
  }
  const s = obj(r.settings);
  const settings = s && isTime(s.updatedAt) && obj(s.data)
    ? { updatedAt: s.updatedAt, data: validateSettings(s.data) }
    : null;
  return {
    format: SYNC_FORMAT,
    crypto,
    settings,
    devices: parseEntries<Device>(r.devices, (id, d) => {
      const [dev] = validateDevices([d]);
      return dev && dev.id === id ? dev : null;
    }),
    certs: parseEntries<string>(r.certs, (_host, d) => (typeof d === 'string' && d ? d : null)),
    secrets: parseEntries<EncryptedBlob>(r.secrets, (_id, d) => parseBlob(d)),
  };
}

function timeMap(v: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  const r = obj(v);
  if (r) for (const [k, x] of Object.entries(r)) if (isTime(x)) out[k] = x;
  return out;
}

export function parseSyncState(raw: unknown): SyncState {
  const r = obj(raw) ?? {};
  const d = obj(r.deleted) ?? {};
  return {
    settings: isTime(r.settings) ? r.settings : 0,
    devices: timeMap(r.devices),
    certs: timeMap(r.certs),
    secrets: timeMap(r.secrets),
    deleted: { devices: timeMap(d.devices), certs: timeMap(d.certs), secrets: timeMap(d.secrets) },
  };
}
