import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FetchLike } from '../../src/main/services/github/api';
import { createStore } from '../../src/main/services/store';
import { createSecretsStore, type SafeStorageLike } from '../../src/main/services/secrets';
import { createSealedFile } from '../../src/main/services/sealedFile';
import { createSyncStateFile } from '../../src/main/services/sync/stateFile';
import { createSyncService } from '../../src/main/services/sync/syncService';
import type { SyncOverview } from '../../src/shared/sync/format';

export const fakeSafe: SafeStorageLike = {
  isEncryptionAvailable: () => true,
  encryptString: (p) => Buffer.from('ENC:' + Buffer.from(p).toString('base64'), 'utf8'),
  decryptString: (c) => Buffer.from(c.toString('utf8').slice(4), 'base64').toString('utf8'),
};

/** In-memory stand-in for the parts of the GitHub API the sync service uses. */
export function fakeGithub() {
  const gh = {
    repoExists: false,
    repoPublic: false,
    file: null as { text: string; sha: string } | null,
    conflicts: 0,
    unauthorized: false,
    offline: false,
    puts: 0,
    shaCounter: 0,
    setRaw(text: string) { gh.file = { text, sha: `sha${++gh.shaCounter}` }; },
    doc(): Record<string, unknown> { return JSON.parse(gh.file!.text); },
  };
  const base = '/repos/octocat/glkvm-config';
  const fetch: FetchLike = async (url, init) => {
    if (gh.offline) throw new Error('offline');
    const method = init?.method ?? 'GET';
    const path = url.replace('https://api.github.com', '');
    const body = init?.body ? JSON.parse(init.body) : undefined;
    const reply = (status: number, data: unknown = {}) =>
      ({ status, json: async () => data, text: async () => JSON.stringify(data) });
    if (gh.unauthorized) return reply(401, { message: 'Bad credentials' });
    if (method === 'GET' && path === base) return gh.repoExists ? reply(200, { private: !gh.repoPublic }) : reply(404);
    if (method === 'POST' && path === '/user/repos') {
      if (gh.repoExists) return reply(422, { message: 'name already exists' });
      gh.repoExists = true;
      return reply(201, { private: body.private });
    }
    if (path === `${base}/contents/glkvm-sync.json`) {
      if (method === 'GET') {
        return gh.file ? reply(200, { content: Buffer.from(gh.file.text).toString('base64'), sha: gh.file.sha }) : reply(404);
      }
      if (method === 'PUT') {
        gh.puts++;
        if (gh.conflicts > 0) { gh.conflicts--; return reply(409, { message: 'conflict' }); }
        if ((gh.file?.sha ?? undefined) !== body.sha) return reply(gh.file ? 409 : 422, { message: 'sha mismatch' });
        gh.setRaw(Buffer.from(body.content, 'base64').toString('utf8'));
        return reply(gh.file!.sha === 'sha1' ? 201 : 200, { content: { sha: gh.file!.sha } });
      }
    }
    return reply(500, { message: `unhandled ${method} ${path}` });
  };
  return { gh, fetch };
}

export function machine(fetch: FetchLike) {
  const dir = mkdtempSync(join(tmpdir(), 'glkvm-sync-'));
  const store = createStore(dir);
  const secrets = createSecretsStore(dir, fakeSafe);
  let token: string | null = 'tok';
  const signOuts: number[] = [];
  const auth = {
    configured: () => true,
    getToken: () => token,
    getUser: () => (token ? { login: 'octocat', name: 'Mona', avatarUrl: '' } : null),
    signOut: () => { token = null; signOuts.push(1); },
  };
  const overviews: SyncOverview[] = [];
  let applied = 0;
  const service = createSyncService({
    fetch, auth, store, secrets,
    keyFile: createSealedFile(join(dir, 'sync-key.json'), fakeSafe),
    stateFile: createSyncStateFile(dir),
    logger: { info: () => {}, error: () => {} },
    onOverview: (o) => overviews.push(o),
    onApplied: () => { applied++; },
    sleep: async () => {},
  });
  store.onChange((e) => service.noteChange(e));
  secrets.onChange((e) => service.noteChange(e));
  return { dir, store, secrets, service, auth, signOuts, overviews, applied: () => applied };
}
