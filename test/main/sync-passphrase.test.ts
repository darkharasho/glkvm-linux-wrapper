import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fakeGithub, machine } from './sync-fakes';

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

async function twoMachinesWithPassword() {
  const { gh, fetch } = fakeGithub();
  const a = machine(fetch);
  const b = machine(fetch);
  const dev = a.store.addDevice({ name: 'Lab', address: 'kvm-a.local' });
  a.secrets.set(dev.id, 'hunter2-secret');
  await a.service.syncNow();
  expect(await a.service.setPassphrase('correct horse battery')).toEqual({ ok: true });
  await b.service.syncNow();
  return { gh, a, b, dev };
}

describe('sync passphrase', () => {
  it('encrypts passwords before they reach GitHub', async () => {
    const { gh, a } = await twoMachinesWithPassword();
    expect(gh.file!.text).not.toContain('hunter2-secret');
    expect(a.service.overview().passwords).toBe('syncing');
  });

  it('rejects short passphrases and a second set', async () => {
    const { a } = await twoMachinesWithPassword();
    expect(await a.service.setPassphrase('short')).toEqual({ ok: false, error: 'Use at least 8 characters' });
    expect(await a.service.setPassphrase('another passphrase'))
      .toEqual({ ok: false, error: 'A sync passphrase is already set — enter it instead' });
  });

  it('unlocks passwords on another computer with the right passphrase', async () => {
    const { b, dev } = await twoMachinesWithPassword();
    expect(b.service.overview().passwords).toBe('needs-passphrase');
    expect(b.secrets.get(dev.id)).toBeNull();
    expect(await b.service.enterPassphrase('wrong passphrase')).toEqual({ ok: false, error: 'Incorrect passphrase' });
    expect(await b.service.enterPassphrase('correct horse battery')).toEqual({ ok: true });
    expect(b.secrets.get(dev.id)).toBe('hunter2-secret');
    expect(b.service.overview().passwords).toBe('syncing');
  });

  it('changing the passphrase re-locks other computers without touching their passwords', async () => {
    const { gh, a, b, dev } = await twoMachinesWithPassword();
    await b.service.enterPassphrase('correct horse battery');
    expect(await a.service.changePassphrase('wrong passphrase', 'new passphrase 42'))
      .toEqual({ ok: false, error: 'Current passphrase is incorrect' });
    expect(await a.service.changePassphrase('correct horse battery', 'new passphrase 42')).toEqual({ ok: true });
    expect(gh.file!.text).not.toContain('hunter2-secret');

    await b.service.syncNow();
    expect(b.service.overview().passwords).toBe('needs-passphrase');
    expect(b.secrets.get(dev.id)).toBe('hunter2-secret');
    expect(await b.service.enterPassphrase('correct horse battery')).toEqual({ ok: false, error: 'Incorrect passphrase' });
    expect(await b.service.enterPassphrase('new passphrase 42')).toEqual({ ok: true });
  });

  it('reset replaces synced passwords with this computer\'s and re-locks others', async () => {
    const { gh, a, b, dev } = await twoMachinesWithPassword();
    const other = b.store.addDevice({ name: 'Other', address: 'kvm-b.local' });
    b.secrets.set(other.id, 'b-only-password');
    expect(await b.service.resetPassphrase('fresh passphrase 1')).toEqual({ ok: true });
    const secrets = (gh.doc() as { secrets: Record<string, unknown> }).secrets;
    expect(Object.keys(secrets)).toEqual([other.id]);

    await a.service.syncNow();
    expect(a.service.overview().passwords).toBe('needs-passphrase');
    expect(await a.service.enterPassphrase('fresh passphrase 1')).toEqual({ ok: true });
    expect(a.secrets.get(other.id)).toBe('b-only-password');
    const after = (gh.doc() as { secrets: Record<string, unknown> }).secrets;
    expect(Object.keys(after).sort()).toEqual([dev.id, other.id].sort());
  });

  it('requires sign-in', async () => {
    const { fetch } = fakeGithub();
    const a = machine(fetch);
    a.auth.signOut();
    expect(await a.service.setPassphrase('correct horse battery')).toEqual({ ok: false, error: 'Sign in to GitHub first' });
  });
});
