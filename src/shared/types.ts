export type AppAction = 'back-to-dashboard' | 'next-device' | 'prev-device'
  | 'toggle-fullscreen' | 'open-settings' | 'quit';
export type HotkeyAction = 'remote' | 'release' | `local:${AppAction}`;
export interface HotkeyBinding { id: string; label: string; accelerator: string; action: HotkeyAction; editable: boolean; }
export type OsKind = 'macos' | 'windows' | 'linux' | 'generic';
export interface Device { id: string; name: string; address: string; url: string; color?: string; os: OsKind; createdAt: number; }
export interface Settings { version: number; general: { launchToLastDevice: boolean; captureIndicator: boolean; }; hotkeys: HotkeyBinding[]; }
export interface BackupBundle { version: number; devices: Device[]; settings: Settings; }
