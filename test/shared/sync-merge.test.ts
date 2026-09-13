import { describe, it, expect } from 'vitest';
import { mergeSync, type LocalSnapshot, type RemoteView } from '../../src/shared/sync/merge';
import { emptyState, MARKER_TTL_MS, type SyncState } from '../../src/shared/sync/format';
import { DEFAULT_SETTINGS } from '../../src/shared/schema';
import type { Device } from '../../src/shared/types';

const NOW = 1_000_000_000_000;
const dev = (id: string, address = `${id}.local`, name = id): Device =>
  ({ id, name, address, url: `https://${address}`, os: 'linux', createdAt: 1 });
const local = (p: Partial<LocalSnapshot> = {}): LocalSnapshot =>
  ({ devices: [], settings: DEFAULT_SETTINGS, certs: {}, secrets: null, ...p });
const remote = (p: Partial<RemoteView> = {}): RemoteView =>
  ({ settings: null, devices: {}, certs: {}, secrets: null, ...p });
const state = (p: Partial<SyncState> = {}): SyncState => ({ ...emptyState(), ...p });

describe('mergeSync', () => {
  it('keeps the newer edit on each side', () => {
    const m = mergeSync(
      local({ devices: [dev('a', 'a.local', 'Local A'), dev('b', 'b.local', 'Local B')] }),
      state({ devices: { a: 20, b: 5 } }),
      remote({ devices: { a: { updatedAt: 10, data: dev('a', 'a.local', 'Remote A') }, b: { updatedAt: 15, data: dev('b', 'b.local', 'Remote B') } } }),
      NOW,
    );
    expect(m.local.devices.map(d => d.name)).toEqual(['Local A', 'Remote B']);
    expect(m.remote.devices.a).toEqual({ updatedAt: 20, data: dev('a', 'a.local', 'Local A') });
    expect(m.state.devices).toEqual({ a: 20, b: 15 });
    expect(m.changed.devices).toBe(true);
  });

  it('lets remote win a tie', () => {
    const m = mergeSync(
      local({ devices: [dev('a', 'a.local', 'Local')] }), state({ devices: { a: 10 } }),
      remote({ devices: { a: { updatedAt: 10, data: dev('a', 'a.local', 'Remote') } } }), NOW,
    );
    expect(m.local.devices[0].name).toBe('Remote');
  });

  it('propagates deletions and lets a newer edit restore an item', () => {
    const deleted = mergeSync(
      local(), state({ deleted: { devices: { a: 30 }, certs: {}, secrets: {} } }),
      remote({ devices: { a: { updatedAt: 10, data: dev('a') } } }), NOW,
    );
    expect(deleted.remote.devices.a).toEqual({ updatedAt: 30, deletedAt: 30 });
    expect(deleted.local.devices).toEqual([]);

    const restored = mergeSync(
      local(), state({ deleted: { devices: { a: 30 }, certs: {}, secrets: {} } }),
      remote({ devices: { a: { updatedAt: 40, data: dev('a') } } }), NOW,
    );
    expect(restored.local.devices.map(d => d.id)).toEqual(['a']);
    expect(restored.state.deleted.devices).toEqual({});
  });

  it('on first join, remote wins shared items and local-only items are pushed', () => {
    const m = mergeSync(
      local({ devices: [dev('shared', 'shared.local', 'Local'), dev('mine')] }), state(),
      remote({ devices: { shared: { updatedAt: 5, data: dev('shared', 'shared.local', 'Remote') } } }), NOW,
    );
    expect(m.local.devices.map(d => d.name)).toEqual(['Remote', 'mine']);
    expect(m.remote.devices.mine).toEqual({ updatedAt: 0, data: dev('mine') });
  });

  it('collapses duplicate addresses to the newest and moves the password', () => {
    const m = mergeSync(
      local({ devices: [dev('old', 'kvm-a.local')], secrets: { old: 'pw-old' } }),
      state({ devices: { old: 10 }, secrets: { old: 10 } }),
      remote({ devices: { new: { updatedAt: 20, data: dev('new', 'kvm-a.local') } }, secrets: {} }),
      NOW,
    );
    expect(m.local.devices.map(d => d.id)).toEqual(['new']);
    expect(m.remote.devices.old).toEqual({ updatedAt: 20, deletedAt: 20 });
    expect(m.local.secrets).toEqual({ new: 'pw-old' });
  });

  it('tombstones the password of a deleted device', () => {
    const m = mergeSync(
      local({ secrets: { a: 'pw' } }),
      state({ secrets: { a: 5 }, deleted: { devices: { a: 30 }, certs: {}, secrets: {} } }),
      remote({ devices: { a: { updatedAt: 10, data: dev('a') } }, secrets: { a: { updatedAt: 5, data: 'pw' } } }),
      NOW,
    );
    expect(m.remote.secrets?.a).toEqual({ updatedAt: 30, deletedAt: 30 });
    expect(m.local.secrets).toEqual({});
  });

  it('passes secrets through when there is no key', () => {
    const st = state({ secrets: { a: 9 } });
    const m = mergeSync(local(), st, remote(), NOW);
    expect(m.remote.secrets).toBeNull();
    expect(m.state.secrets).toEqual({ a: 9 });
    expect(m.changed.secrets).toBe(false);
  });

  it('drops markers older than 90 days', () => {
    const old = NOW - MARKER_TTL_MS - 1;
    const m = mergeSync(local(), state(), remote({ certs: { 'kvm-a.local': { updatedAt: old, deletedAt: old } } }), NOW);
    expect(m.remote.certs).toEqual({});
  });

  it('merges settings as one item and reports no change when identical', () => {
    const newer = { ...DEFAULT_SETTINGS, general: { ...DEFAULT_SETTINGS.general, captureIndicator: false } };
    const m = mergeSync(local(), state({ settings: 1 }), remote({ settings: { updatedAt: 2, data: newer } }), NOW);
    expect(m.local.settings.general.captureIndicator).toBe(false);
    expect(m.changed.settings).toBe(true);

    const same = mergeSync(local(), state(), remote(), NOW);
    expect(same.remote.settings).toEqual({ updatedAt: 0, data: DEFAULT_SETTINGS });
    expect(same.changed).toEqual({ devices: false, settings: false, certs: false, secrets: false });
  });
});
