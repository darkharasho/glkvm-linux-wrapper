import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fakeGithub, machine } from './sync-fakes';

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('sync service cycle', () => {
  it('creates the private repo on first sync and pushes local data', async () => {
    const { gh, fetch } = fakeGithub();
    const a = machine(fetch);
    a.store.addDevice({ name: 'Lab', address: 'kvm-a.local' });
    await a.service.syncNow();
    expect(gh.repoExists).toBe(true);
    const doc = gh.doc() as { devices: Record<string, { data: { name: string } }> };
    expect(Object.values(doc.devices).map(e => e.data.name)).toEqual(['Lab']);
    expect(a.overviews.at(-1)?.sync.state).toBe('synced');
  });

  it('propagates additions, edits and deletions between two computers', async () => {
    const { fetch } = fakeGithub();
    const a = machine(fetch);
    const b = machine(fetch);
    const dev = a.store.addDevice({ name: 'Lab', address: 'kvm-a.local' });
    await a.service.syncNow();
    await b.service.syncNow();
    expect(b.store.getDevices().map(d => d.name)).toEqual(['Lab']);
    expect(b.applied()).toBe(1);

    vi.setSystemTime(Date.now() + 1000);
    b.store.updateDevice(dev.id, { name: 'Lab renamed' });
    await b.service.syncNow();
    await a.service.syncNow();
    expect(a.store.getDevices().map(d => d.name)).toEqual(['Lab renamed']);

    vi.setSystemTime(Date.now() + 1000);
    a.store.removeDevice(dev.id);
    await a.service.syncNow();
    await b.service.syncNow();
    expect(b.store.getDevices()).toEqual([]);
  });

  it('does not write when nothing changed', async () => {
    const { gh, fetch } = fakeGithub();
    const a = machine(fetch);
    await a.service.syncNow();
    const puts = gh.puts;
    await a.service.syncNow();
    expect(gh.puts).toBe(puts);
  });

  it('retries write conflicts and gives up after three attempts', async () => {
    const { gh, fetch } = fakeGithub();
    const a = machine(fetch);
    gh.conflicts = 2;
    await a.service.syncNow();
    expect(a.overviews.at(-1)?.sync.state).toBe('synced');

    a.store.addDevice({ name: 'Lab', address: 'kvm-a.local' });
    gh.conflicts = 3;
    await a.service.syncNow();
    expect(a.overviews.at(-1)?.sync).toMatchObject({ state: 'error' });
  });

  it('signs out locally on 401', async () => {
    const { gh, fetch } = fakeGithub();
    const a = machine(fetch);
    gh.unauthorized = true;
    await a.service.syncNow();
    expect(a.signOuts).toHaveLength(1);
    expect(a.overviews.at(-1)?.sync.error).toBe('Signed out of GitHub — sign in again');
  });

  it('refuses to sync into a public repository', async () => {
    const { gh, fetch } = fakeGithub();
    gh.repoExists = true;
    gh.repoPublic = true;
    const a = machine(fetch);
    a.store.addDevice({ name: 'Lab', address: 'kvm-a.local' });
    await a.service.syncNow();
    expect(gh.puts).toBe(0);
    expect(a.overviews.at(-1)?.sync).toMatchObject({
      state: 'error', error: 'Your glkvm-config repository is public. Make it private on GitHub to sync.',
    });

    gh.repoPublic = false;
    await a.service.syncNow();
    expect(gh.puts).toBe(1);
    expect(a.overviews.at(-1)?.sync.state).toBe('synced');
  });

  it('never overwrites an unreadable sync file', async () => {
    const { gh, fetch } = fakeGithub();
    gh.repoExists = true;
    gh.setRaw('{ not json');
    const a = machine(fetch);
    a.store.addDevice({ name: 'Lab', address: 'kvm-a.local' });
    await a.service.syncNow();
    expect(gh.puts).toBe(0);
    expect(gh.file?.text).toBe('{ not json');
    expect(a.overviews.at(-1)?.sync.error).toMatch(/unreadable/);
  });

  it('reports network failures without touching local data', async () => {
    const { gh, fetch } = fakeGithub();
    const a = machine(fetch);
    a.store.addDevice({ name: 'Lab', address: 'kvm-a.local' });
    gh.offline = true;
    await a.service.syncNow();
    expect(a.overviews.at(-1)?.sync.error).toBe("Couldn't reach GitHub");
    expect(a.store.getDevices()).toHaveLength(1);
  });

  it('debounces pushes after local changes and does not loop on applied data', async () => {
    const { gh, fetch } = fakeGithub();
    const a = machine(fetch);
    const b = machine(fetch);
    await a.service.syncNow();
    await b.service.syncNow();
    const putsBefore = gh.puts;

    a.store.addDevice({ name: 'One', address: 'kvm-1.local' });
    a.store.addDevice({ name: 'Two', address: 'kvm-2.local' });
    expect(gh.puts).toBe(putsBefore);
    await vi.advanceTimersByTimeAsync(2000);
    await vi.waitFor(() => expect(a.overviews.at(-1)?.sync.state).toBe('synced'));
    expect(gh.puts).toBe(putsBefore + 1);

    await b.service.syncNow();
    expect(b.store.getDevices()).toHaveLength(2);
    const putsAfterPull = gh.puts;
    await vi.advanceTimersByTimeAsync(5000);
    expect(gh.puts).toBe(putsAfterPull);
  });

  it('throttles focus syncs to once per minute', async () => {
    const { fetch } = fakeGithub();
    const a = machine(fetch);
    a.service.onFocus();
    a.service.onFocus();
    expect(a.overviews.filter(o => o.sync.state === 'syncing')).toHaveLength(1);
    await vi.waitFor(() => expect(a.overviews.at(-1)?.sync.state).toBe('synced'));
    a.service.onFocus();
    expect(a.overviews.filter(o => o.sync.state === 'syncing')).toHaveLength(1);
    vi.setSystemTime(Date.now() + 61_000);
    a.service.onFocus();
    expect(a.overviews.filter(o => o.sync.state === 'syncing')).toHaveLength(2);
    await vi.waitFor(() => expect(a.overviews.at(-1)?.sync.state).toBe('synced'));
  });

  it('leaves remote passwords untouched and reports needs-set without a passphrase', async () => {
    const { gh, fetch } = fakeGithub();
    gh.repoExists = true;
    gh.setRaw(JSON.stringify({
      format: 1, crypto: null, settings: null, devices: {}, certs: {},
      secrets: { d1: { updatedAt: 5, data: { iv: 'aXY=', tag: 'dGFn', ct: 'Y3Q=' } } },
    }));
    const a = machine(fetch);
    a.secrets.set('local-only', 'pw');
    await a.service.syncNow();
    expect((gh.doc() as { secrets: unknown }).secrets).toEqual({ d1: { updatedAt: 5, data: { iv: 'aXY=', tag: 'dGFn', ct: 'Y3Q=' } } });
    expect(a.overviews.at(-1)?.passwords).toBe('needs-set');
  });
});
