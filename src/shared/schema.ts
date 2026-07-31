import type { Device, HotkeyBinding, Settings } from './types';

export const SCHEMA_VERSION = 1;

export const DEFAULT_HOTKEYS: HotkeyBinding[] = [
  { id: 'release',     label: 'Release keyboard capture', accelerator: 'Ctrl+Alt+Escape', action: 'release', editable: true },
  { id: 'dashboard',   label: 'Back to dashboard',        accelerator: 'Ctrl+Alt+D',      action: 'local:back-to-dashboard', editable: true },
  { id: 'next',        label: 'Next device',              accelerator: 'Ctrl+Alt+Right',  action: 'local:next-device', editable: true },
  { id: 'prev',        label: 'Previous device',          accelerator: 'Ctrl+Alt+Left',   action: 'local:prev-device', editable: true },
  { id: 'fullscreen',  label: 'Toggle fullscreen',        accelerator: 'F11',             action: 'local:toggle-fullscreen', editable: true },
  { id: 'settings',    label: 'Open settings',            accelerator: 'Ctrl+Alt+S',      action: 'local:open-settings', editable: true },
  { id: 'copy',        label: 'Copy (to remote)',         accelerator: 'Ctrl+C',          action: 'remote', editable: true },
  { id: 'paste',       label: 'Paste (to remote)',        accelerator: 'Ctrl+V',          action: 'remote', editable: true },
  { id: 'cut',         label: 'Cut (to remote)',          accelerator: 'Ctrl+X',          action: 'remote', editable: true },
];

export const DEFAULT_SETTINGS: Settings = {
  version: SCHEMA_VERSION,
  general: { launchToLastDevice: false, captureIndicator: true },
  hotkeys: DEFAULT_HOTKEYS,
};

function isDevice(v: unknown): v is Device {
  if (typeof v !== 'object' || v === null) return false;
  const d = v as Record<string, unknown>;
  return ['id', 'name', 'address', 'url'].every(k => typeof d[k] === 'string')
    && typeof d.createdAt === 'number';
}

export function validateDevices(raw: unknown): Device[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(isDevice) as Device[];
}

function isHotkey(v: unknown): v is HotkeyBinding {
  if (typeof v !== 'object' || v === null) return false;
  const h = v as Record<string, unknown>;
  return typeof h.id === 'string' && typeof h.accelerator === 'string'
    && typeof h.action === 'string' && typeof h.label === 'string'
    && typeof h.editable === 'boolean';
}

export function validateSettings(raw: unknown): Settings {
  const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const overrides = Array.isArray(r.hotkeys) ? r.hotkeys.filter(isHotkey) as HotkeyBinding[] : [];
  const byId = new Map(overrides.map(h => [h.id, h]));
  const hotkeys = DEFAULT_HOTKEYS.map(def => byId.get(def.id) ?? def);
  const general = (typeof r.general === 'object' && r.general !== null ? r.general : {}) as Record<string, unknown>;
  return {
    version: typeof r.version === 'number' ? r.version : SCHEMA_VERSION,
    general: {
      launchToLastDevice: general.launchToLastDevice === true,
      captureIndicator: general.captureIndicator !== false,
    },
    hotkeys,
  };
}
