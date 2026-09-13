import { describe, it, expect, vi } from 'vitest';
import { createGithubAuth, pollForToken } from '../../src/main/services/github/auth';
import type { FetchLike } from '../../src/main/services/github/api';
import type { SealedFile } from '../../src/main/services/sealedFile';

type Reply = { status?: number; body: unknown } | Error;

function fakeFetch(routes: Record<string, Reply[]>) {
  const calls: Array<{ url: string; body?: string }> = [];
  const fn: FetchLike = async (url, init) => {
    calls.push({ url, body: init?.body });
    const queue = routes[url];
    const next = queue && (queue.length > 1 ? queue.shift()! : queue[0]);
    if (!next) throw new Error(`unexpected ${url}`);
    if (next instanceof Error) throw next;
    const text = JSON.stringify(next.body);
    return { status: next.status ?? 200, json: async () => next.body, text: async () => text };
  };
  return { fn, calls };
}

function memorySealed(): SealedFile & { value: string | null } {
  const s = {
    value: null as string | null,
    read: () => s.value,
    write: (v: string) => { s.value = v; },
    clear: () => { s.value = null; },
    persistent: () => true,
  };
  return s;
}

const DEVICE = 'https://github.com/login/device/code';
const TOKEN = 'https://github.com/login/oauth/access_token';
const USER = 'https://api.github.com/user';

describe('pollForToken', () => {
  it('keeps polling through pending, network errors and slow_down', async () => {
    const { fn } = fakeFetch({
      [TOKEN]: [
        { body: { error: 'authorization_pending' } }, new Error('offline'),
        { body: { error: 'slow_down' } }, { body: { access_token: 'tok' } },
      ],
    });
    const waits: number[] = [];
    let t = 0;
    const r = await pollForToken({
      fetch: fn, clientId: 'cid', deviceCode: 'dc', intervalSec: 5, expiresInSec: 900,
      sleep: async (ms) => { waits.push(ms); t += ms; }, now: () => t, isCancelled: () => false,
    });
    expect(r).toEqual({ token: 'tok' });
    expect(waits).toEqual([5000, 5000, 5000, 10000]);
  });

  it('reports denial, expiry and cancellation', async () => {
    const base = { clientId: 'cid', deviceCode: 'dc', intervalSec: 5, sleep: async () => {}, now: () => 0 };
    const denied = fakeFetch({ [TOKEN]: [{ body: { error: 'access_denied' } }] });
    expect(await pollForToken({ ...base, fetch: denied.fn, expiresInSec: 900, isCancelled: () => false }))
      .toEqual({ error: 'Sign-in was cancelled on GitHub.' });
    const expired = fakeFetch({ [TOKEN]: [{ body: { error: 'expired_token' } }] });
    expect(await pollForToken({ ...base, fetch: expired.fn, expiresInSec: 900, isCancelled: () => false }))
      .toEqual({ error: 'The sign-in code expired. Try again.' });
    expect(await pollForToken({ ...base, fetch: denied.fn, expiresInSec: 900, isCancelled: () => true }))
      .toEqual({ cancelled: true });
  });
});

describe('createGithubAuth', () => {
  it('signs in, stores the session sealed, and signs out', async () => {
    const { fn, calls } = fakeFetch({
      [DEVICE]: [{ body: { device_code: 'dc', user_code: 'ABCD-1234', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 5 } }],
      [TOKEN]: [{ body: { error: 'authorization_pending' } }, { body: { access_token: 'tok' } }],
      [USER]: [{ body: { login: 'octocat', name: 'Mona', avatar_url: 'https://avatars.githubusercontent.com/u/1' } }],
    });
    const sealed = memorySealed();
    const opened: string[] = [];
    const auth = createGithubAuth({ fetch: fn, sealed, clientId: 'cid', openExternal: (u) => opened.push(u), sleep: async () => {} });
    const changes: unknown[] = [];
    auth.onChange((u) => changes.push(u));

    const info = await auth.start();
    expect(info).toEqual({ userCode: 'ABCD-1234', verificationUri: 'https://github.com/login/device', expiresIn: 900 });
    expect(opened).toEqual(['https://github.com/login/device']);
    expect(calls[0].body).toContain('scope=repo+read%3Auser');

    await vi.waitFor(() => expect(auth.getUser()?.login).toBe('octocat'));
    expect(auth.getToken()).toBe('tok');
    expect(JSON.parse(sealed.value!)).toEqual({ token: 'tok', user: { login: 'octocat', name: 'Mona', avatarUrl: 'https://avatars.githubusercontent.com/u/1' } });

    const reloaded = createGithubAuth({ fetch: fn, sealed, clientId: 'cid', openExternal: () => {} });
    expect(reloaded.getToken()).toBe('tok');

    auth.signOut();
    expect(auth.getToken()).toBeNull();
    expect(sealed.value).toBeNull();
    expect(changes).toEqual([expect.objectContaining({ login: 'octocat' }), null]);
  });

  it('reports poll errors, ignores untrusted verification URLs, and refuses when unconfigured', async () => {
    const { fn } = fakeFetch({
      [DEVICE]: [{ body: { device_code: 'dc', user_code: 'X', verification_uri: 'https://evil.example/', expires_in: 900 } }],
      [TOKEN]: [{ body: { error: 'access_denied' } }],
    });
    const opened: string[] = [];
    const auth = createGithubAuth({ fetch: fn, sealed: memorySealed(), clientId: 'cid', openExternal: (u) => opened.push(u), sleep: async () => {} });
    const errors: string[] = [];
    auth.onError((m) => errors.push(m));
    await auth.start();
    expect(opened).toEqual(['https://github.com/login/device']);
    await vi.waitFor(() => expect(errors).toEqual(['Sign-in was cancelled on GitHub.']));

    const unconfigured = createGithubAuth({ fetch: fn, sealed: memorySealed(), clientId: '', openExternal: () => {} });
    expect(unconfigured.configured()).toBe(false);
    await expect(unconfigured.start()).rejects.toThrow('GitHub sign-in is not configured');
  });

  it('cancel stops a pending sign-in from completing', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const { fn } = fakeFetch({
      [DEVICE]: [{ body: { device_code: 'dc', user_code: 'X', verification_uri: 'https://github.com/login/device', expires_in: 900 } }],
      [TOKEN]: [{ body: { access_token: 'tok' } }],
      [USER]: [{ body: { login: 'octocat' } }],
    });
    const auth = createGithubAuth({ fetch: fn, sealed: memorySealed(), clientId: 'cid', openExternal: () => {}, sleep: () => gate });
    await auth.start();
    auth.cancel();
    release();
    await new Promise((r) => setTimeout(r, 10));
    expect(auth.getToken()).toBeNull();
  });
});
