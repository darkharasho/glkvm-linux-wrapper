import { asRecord, githubApi, postForm, type FetchLike } from './api';
import type { SealedFile } from '../sealedFile';
import type { GithubUser } from '@shared/sync/format';

export const GITHUB_CLIENT_ID = process.env.GLKVM_GH_CLIENT_ID || '';
export const GITHUB_SCOPES = 'repo read:user';
const DEFAULT_VERIFICATION_URI = 'https://github.com/login/device';
const EXPIRED = 'The sign-in code expired. Try again.';

export interface DeviceCodeInfo { userCode: string; verificationUri: string; expiresIn: number; }

export interface AuthDeps {
  fetch: FetchLike;
  sealed: SealedFile;
  clientId: string;
  openExternal(url: string): void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface GithubAuth {
  configured(): boolean;
  getUser(): GithubUser | null;
  getToken(): string | null;
  start(): Promise<DeviceCodeInfo>;
  openVerification(): void;
  cancel(): void;
  signOut(): void;
  onChange(cb: (user: GithubUser | null) => void): void;
  onError(cb: (message: string) => void): void;
}

type PollResult = { token: string } | { error: string } | { cancelled: true };

export async function pollForToken(opts: {
  fetch: FetchLike; clientId: string; deviceCode: string; intervalSec: number; expiresInSec: number;
  sleep: (ms: number) => Promise<void>; now: () => number; isCancelled: () => boolean;
}): Promise<PollResult> {
  let intervalMs = Math.max(opts.intervalSec, 5) * 1000;
  const deadline = opts.now() + opts.expiresInSec * 1000;
  for (;;) {
    await opts.sleep(intervalMs);
    if (opts.isCancelled()) return { cancelled: true };
    if (opts.now() >= deadline) return { error: EXPIRED };
    let res: Record<string, unknown>;
    try {
      res = await postForm(opts.fetch, 'https://github.com/login/oauth/access_token', {
        client_id: opts.clientId, device_code: opts.deviceCode, grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      });
    } catch {
      continue;
    }
    if (opts.isCancelled()) return { cancelled: true };
    if (typeof res.access_token === 'string') return { token: res.access_token };
    if (res.error === 'authorization_pending') continue;
    if (res.error === 'slow_down') { intervalMs += 5000; continue; }
    if (res.error === 'access_denied') return { error: 'Sign-in was cancelled on GitHub.' };
    if (res.error === 'expired_token') return { error: EXPIRED };
    return { error: typeof res.error_description === 'string' ? res.error_description : 'GitHub sign-in failed.' };
  }
}

interface Session { token: string; user: GithubUser; }

function parseSession(raw: string | null): Session | null {
  if (!raw) return null;
  try {
    const v = asRecord(JSON.parse(raw));
    const u = asRecord(v?.user);
    if (!v || !u || typeof v.token !== 'string' || typeof u.login !== 'string') return null;
    return {
      token: v.token,
      user: { login: u.login, name: typeof u.name === 'string' ? u.name : u.login, avatarUrl: typeof u.avatarUrl === 'string' ? u.avatarUrl : '' },
    };
  } catch {
    return null;
  }
}

export function createGithubAuth(deps: AuthDeps): GithubAuth {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;
  let session = parseSession(deps.sealed.read());
  let generation = 0;
  let verificationUri = DEFAULT_VERIFICATION_URI;
  const changeListeners: Array<(user: GithubUser | null) => void> = [];
  const errorListeners: Array<(message: string) => void> = [];

  const setSession = (next: Session | null) => {
    session = next;
    if (next) deps.sealed.write(JSON.stringify(next)); else deps.sealed.clear();
    for (const l of changeListeners) l(next?.user ?? null);
  };
  const fail = (message: string) => { for (const l of errorListeners) l(message); };

  return {
    configured: () => !!deps.clientId,
    getUser: () => session?.user ?? null,
    getToken: () => session?.token ?? null,
    async start() {
      if (!deps.clientId) throw new Error('GitHub sign-in is not configured');
      const gen = ++generation;
      let res: Record<string, unknown>;
      try {
        res = await postForm(deps.fetch, 'https://github.com/login/device/code', { client_id: deps.clientId, scope: GITHUB_SCOPES });
      } catch {
        throw new Error("Couldn't reach GitHub");
      }
      if (typeof res.device_code !== 'string' || typeof res.user_code !== 'string') {
        throw new Error(typeof res.error_description === 'string' ? res.error_description : 'GitHub sign-in failed.');
      }
      verificationUri = typeof res.verification_uri === 'string' && res.verification_uri.startsWith('https://github.com/')
        ? res.verification_uri : DEFAULT_VERIFICATION_URI;
      const expiresIn = typeof res.expires_in === 'number' ? res.expires_in : 900;
      deps.openExternal(verificationUri);

      void pollForToken({
        fetch: deps.fetch, clientId: deps.clientId, deviceCode: res.device_code,
        intervalSec: typeof res.interval === 'number' ? res.interval : 5, expiresInSec: expiresIn,
        sleep, now, isCancelled: () => gen !== generation,
      }).then(async (r) => {
        if ('cancelled' in r) return;
        if ('error' in r) { fail(r.error); return; }
        const profile = await githubApi(deps.fetch, r.token, 'GET', '/user').catch(() => null);
        if (gen !== generation) return;
        const u = profile?.status === 200 ? asRecord(profile.data) : null;
        if (!u || typeof u.login !== 'string') { fail("Signed in, but couldn't load your GitHub profile."); return; }
        setSession({
          token: r.token,
          user: {
            login: u.login,
            name: typeof u.name === 'string' && u.name ? u.name : u.login,
            avatarUrl: typeof u.avatar_url === 'string' ? u.avatar_url : '',
          },
        });
      });

      return { userCode: res.user_code, verificationUri, expiresIn };
    },
    openVerification: () => deps.openExternal(verificationUri),
    cancel: () => { generation++; },
    signOut: () => { generation++; setSession(null); },
    onChange: (cb) => { changeListeners.push(cb); },
    onError: (cb) => { errorListeners.push(cb); },
  };
}
