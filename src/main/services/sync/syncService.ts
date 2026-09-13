import type { Device, Settings } from '@shared/types';
import type { TrustStore } from '@shared/certs';
import {
  SYNC_FILE, SYNC_FORMAT, SYNC_REPO, canonicalJson, emptyDoc, isLive, parseSyncDoc,
  type ChangeEvent, type CryptoHeader, type EncryptedBlob, type Entry, type GithubUser,
  type PasswordsState, type SyncDoc, type SyncOverview, type SyncResult, type SyncStatus,
} from '@shared/sync/format';
import { mergeSync, type LocalSnapshot } from '@shared/sync/merge';
import { asRecord, githubApi, type FetchLike, type GithubResponse } from '../github/api';
import type { SealedFile } from '../sealedFile';
import type { SyncStateFile } from './stateFile';
import {
  MIN_PASSPHRASE_LENGTH, createHeader, decrypt, encrypt, parseKey, serializeKey, unlock, type SyncKey,
} from './crypto';

export const PUSH_DEBOUNCE_MS = 2000;
export const FOCUS_THROTTLE_MS = 60_000;
export const MAX_ATTEMPTS = 3;

export interface SyncDeps {
  fetch: FetchLike;
  auth: { configured(): boolean; getToken(): string | null; getUser(): GithubUser | null; signOut(): void };
  store: {
    getDevices(): Device[]; getSettings(): Settings; getTrustStore(): TrustStore;
    applySynced(next: { devices?: Device[]; settings?: Settings; certs?: TrustStore }): void;
  };
  secrets: { isAvailable(): boolean; ids(): string[]; get(id: string): string | null; replaceAll(passwords: Record<string, string>): void };
  keyFile: SealedFile;
  stateFile: SyncStateFile;
  logger: { info(msg: string): void; error(msg: string, err?: unknown): void };
  onOverview(overview: SyncOverview): void;
  onApplied(): void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface SyncService {
  overview(): SyncOverview;
  syncNow(): Promise<void>;
  scheduleSync(delayMs?: number): void;
  onFocus(): void;
  noteChange(e: ChangeEvent): void;
  setPassphrase(passphrase: string): Promise<SyncResult>;
  enterPassphrase(passphrase: string): Promise<SyncResult>;
  changePassphrase(current: string, next: string): Promise<SyncResult>;
  resetPassphrase(next: string): Promise<SyncResult>;
  forgetKey(): void;
  dispose(): void;
}

class SyncError extends Error {
  constructor(message: string, readonly kind: 'network' | 'auth' | 'invalid' | 'github') { super(message); }
}

export function createSyncService(deps: SyncDeps): SyncService {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let state = deps.stateFile.load();
  let key: SyncKey | null = parseKey(deps.keyFile.read());
  let lastCrypto: CryptoHeader | null | undefined;
  let status: SyncStatus = { state: 'idle' };
  let repoReady = false;
  let queue: Promise<unknown> = Promise.resolve();
  let pending: Promise<void> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastFocusSync = -Infinity;

  function passwordsState(): PasswordsState {
    if (!deps.secrets.isAvailable()) return 'unavailable';
    if (lastCrypto === undefined) return 'unknown';
    if (lastCrypto === null) return 'needs-set';
    return key && key.keyId === lastCrypto.keyId ? 'syncing' : 'needs-passphrase';
  }
  const overview = (): SyncOverview => ({
    user: deps.auth.getUser(), configured: deps.auth.configured(), sync: status, passwords: passwordsState(),
  });
  const publish = () => deps.onOverview(overview());
  const setStatus = (next: SyncStatus) => { status = next; publish(); };

  function exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = queue.then(fn, fn);
    queue = run.catch(() => undefined);
    return run;
  }

  function session(): { token: string; login: string } {
    const token = deps.auth.getToken();
    const user = deps.auth.getUser();
    if (!token || !user) throw new SyncError('Signed out of GitHub — sign in again', 'auth');
    return { token, login: user.login };
  }

  async function api(method: string, path: string, body?: unknown): Promise<GithubResponse> {
    const { token } = session();
    let res: GithubResponse;
    try { res = await githubApi(deps.fetch, token, method, path, body); }
    catch { throw new SyncError("Couldn't reach GitHub", 'network'); }
    if (res.status === 401) throw new SyncError('Signed out of GitHub — sign in again', 'auth');
    if (res.status >= 500) throw new SyncError("Couldn't reach GitHub", 'network');
    return res;
  }

  function githubError(action: string, res: GithubResponse): SyncError {
    const message = asRecord(res.data)?.message;
    return new SyncError(`GitHub error ${res.status} ${action}${typeof message === 'string' ? `: ${message}` : ''}`, 'github');
  }

  const repoPath = () => `/repos/${encodeURIComponent(session().login)}/${SYNC_REPO}`;
  const filePath = () => `${repoPath()}/contents/${SYNC_FILE}`;

  async function ensureRepo(): Promise<void> {
    if (repoReady) return;
    const res = await api('GET', repoPath());
    if (res.status === 404) {
      const created = await api('POST', '/user/repos', {
        name: SYNC_REPO, private: true, auto_init: true, description: 'GLKVM settings sync',
      });
      if (created.status !== 201 && created.status !== 422) throw githubError('creating the sync repository', created);
      await sleep(1500);
    } else if (res.status !== 200) {
      throw githubError('opening the sync repository', res);
    }
    repoReady = true;
  }

  async function fetchDoc(): Promise<{ doc: SyncDoc; sha: string | null }> {
    const res = await api('GET', filePath());
    if (res.status === 404) return { doc: emptyDoc(), sha: null };
    const d = asRecord(res.data);
    if (res.status !== 200 || !d || typeof d.content !== 'string' || typeof d.sha !== 'string') {
      throw githubError('reading the sync file', res);
    }
    try {
      return { doc: parseSyncDoc(Buffer.from(d.content, 'base64').toString('utf8')), sha: d.sha };
    } catch (e) {
      throw new SyncError(`Sync file in GitHub is unreadable (${(e as Error).message})`, 'invalid');
    }
  }

  /** Returns the new sha, or null when GitHub rejected the write because the file changed. */
  async function putDoc(doc: SyncDoc, sha: string | null, message: string): Promise<string | null> {
    const body: Record<string, unknown> = {
      message, content: Buffer.from(`${canonicalJson(doc)}\n`, 'utf8').toString('base64'),
    };
    if (sha) body.sha = sha;
    const res = await api('PUT', filePath(), body);
    if (res.status === 409 || res.status === 422) return null;
    const newSha = asRecord(asRecord(res.data)?.content)?.sha;
    if ((res.status !== 200 && res.status !== 201) || typeof newSha !== 'string') throw githubError('writing the sync file', res);
    return newSha;
  }

  const activeKey = (crypto: CryptoHeader | null): SyncKey | null =>
    deps.secrets.isAvailable() && crypto && key && key.keyId === crypto.keyId ? key : null;

  function localPasswords(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const id of deps.secrets.ids()) {
      const pw = deps.secrets.get(id);
      if (pw !== null) out[id] = pw;
    }
    return out;
  }

  function decryptEntries(k: SyncKey, entries: Record<string, Entry<EncryptedBlob>>) {
    const plain: Record<string, Entry<string>> = {};
    const unreadable: Record<string, Entry<EncryptedBlob>> = {};
    for (const [id, e] of Object.entries(entries)) {
      if (!isLive(e)) { plain[id] = e; continue; }
      try { plain[id] = { updatedAt: e.updatedAt, data: decrypt(k.key, e.data) }; }
      catch { unreadable[id] = e; deps.logger.error(`sync: couldn't decrypt the synced password for device ${id}`); }
    }
    return { plain, unreadable };
  }

  function encryptEntries(
    k: SyncKey, merged: Record<string, Entry<string>>, previousPlain: Record<string, Entry<string>>,
    previous: Record<string, Entry<EncryptedBlob>>, unreadable: Record<string, Entry<EncryptedBlob>>,
  ): Record<string, Entry<EncryptedBlob>> {
    const out: Record<string, Entry<EncryptedBlob>> = { ...unreadable };
    for (const [id, e] of Object.entries(merged)) {
      if (!isLive(e)) { out[id] = e; continue; }
      const prev = previousPlain[id];
      const unchanged = prev && isLive(prev) && prev.updatedAt === e.updatedAt && prev.data === e.data;
      out[id] = unchanged ? previous[id] : { updatedAt: e.updatedAt, data: encrypt(k.key, e.data) };
    }
    return out;
  }

  async function runCycle(): Promise<void> {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      await ensureRepo();
      const { doc, sha } = await fetchDoc();
      lastCrypto = doc.crypto;
      const k = activeKey(doc.crypto);
      const dec = k ? decryptEntries(k, doc.secrets) : null;
      const local: LocalSnapshot = {
        devices: deps.store.getDevices(), settings: deps.store.getSettings(), certs: deps.store.getTrustStore(),
        secrets: k ? localPasswords() : null,
      };
      const m = mergeSync(local, state, {
        settings: doc.settings, devices: doc.devices, certs: doc.certs, secrets: dec ? dec.plain : null,
      }, now());

      if (m.changed.devices || m.changed.settings || m.changed.certs) {
        deps.store.applySynced({
          devices: m.changed.devices ? m.local.devices : undefined,
          settings: m.changed.settings ? m.local.settings : undefined,
          certs: m.changed.certs ? m.local.certs : undefined,
        });
      }
      if (m.changed.secrets && m.local.secrets) deps.secrets.replaceAll(m.local.secrets);
      state = m.state;
      deps.stateFile.save(state);
      if (m.changed.devices || m.changed.settings || m.changed.certs || m.changed.secrets) deps.onApplied();

      const next: SyncDoc = {
        format: SYNC_FORMAT,
        crypto: doc.crypto,
        settings: m.remote.settings,
        devices: m.remote.devices,
        certs: m.remote.certs,
        secrets: k && dec && m.remote.secrets
          ? encryptEntries(k, m.remote.secrets, dec.plain, doc.secrets, dec.unreadable)
          : doc.secrets,
      };
      if (sha !== null && canonicalJson(next) === canonicalJson(doc)) return;
      if (await putDoc(next, sha, 'sync: update config') !== null) return;
      deps.logger.info(`sync: write conflict, retrying (attempt ${attempt})`);
    }
    throw new SyncError('Another computer kept syncing at the same time — try again', 'github');
  }

  function handleError(e: unknown, label: string): string {
    const err = e instanceof SyncError ? e : new SyncError('Sync failed unexpectedly', 'github');
    deps.logger.error(`sync: ${label} failed`, err.message);
    if (!(e instanceof SyncError)) deps.logger.error('sync: unexpected error', e);
    if (err.kind === 'auth') { repoReady = false; deps.auth.signOut(); }
    setStatus({ state: 'error', error: err.message, lastSynced: status.lastSynced });
    return err.message;
  }

  /** Runs `fn` with syncing/synced/error status handling. Call only inside `exclusive`. */
  async function tracked(label: string, fn: () => Promise<void>): Promise<boolean> {
    if (!deps.auth.getToken()) return false;
    if (status.state !== 'syncing') setStatus({ state: 'syncing', lastSynced: status.lastSynced });
    try {
      await fn();
      setStatus({ state: 'synced', lastSynced: now() });
      deps.logger.info(`sync: ${label} ok`);
      return true;
    } catch (e) {
      handleError(e, label);
      return false;
    }
  }

  function syncNow(): Promise<void> {
    if (pending) return pending;
    if (deps.auth.getToken()) setStatus({ state: 'syncing', lastSynced: status.lastSynced });
    pending = exclusive(async () => {
      pending = null;
      await tracked('sync', runCycle);
    });
    return pending;
  }

  function scheduleSync(delayMs = PUSH_DEBOUNCE_MS): void {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; void syncNow(); }, delayMs);
  }

  function noteChange(e: ChangeEvent): void {
    const t = now();
    const touch = (live: Record<string, number>, dead: Record<string, number>, id: string, removed: boolean) => {
      if (removed) { delete live[id]; dead[id] = t; } else { live[id] = t; delete dead[id]; }
    };
    switch (e.kind) {
      case 'settings': state.settings = t; break;
      case 'device': case 'device-removed':
        touch(state.devices, state.deleted.devices, e.id, e.kind === 'device-removed'); break;
      case 'cert': case 'cert-removed':
        touch(state.certs, state.deleted.certs, e.host, e.kind === 'cert-removed'); break;
      case 'secret': case 'secret-removed':
        touch(state.secrets, state.deleted.secrets, e.id, e.kind === 'secret-removed'); break;
    }
    deps.stateFile.save(state);
    if (deps.auth.getToken()) scheduleSync();
  }

  const failure = (error: string): SyncResult => ({ ok: false, error });
  const TOO_SHORT = failure(`Use at least ${MIN_PASSPHRASE_LENGTH} characters`);
  const CONFLICT = failure('Another computer synced at the same time — try again');

  function storeKey(k: SyncKey, header: CryptoHeader): void {
    key = k;
    deps.keyFile.write(serializeKey(k));
    lastCrypto = header;
  }

  function passphraseOp(label: string, fn: () => Promise<SyncResult>): Promise<SyncResult> {
    return exclusive(async () => {
      if (!deps.auth.getToken()) return failure('Sign in to GitHub first');
      if (!deps.secrets.isAvailable()) return failure("Saved passwords aren't available on this computer");
      try {
        const result = await fn();
        publish();
        return result;
      } catch (e) {
        return failure(handleError(e, label));
      }
    });
  }

  const setPassphrase = (passphrase: string) => passphraseOp('set passphrase', async () => {
    if (passphrase.length < MIN_PASSPHRASE_LENGTH) return TOO_SHORT;
    await ensureRepo();
    const { doc, sha } = await fetchDoc();
    lastCrypto = doc.crypto;
    if (doc.crypto) return failure('A sync passphrase is already set — enter it instead');
    const { header, key: k } = createHeader(passphrase);
    if (await putDoc({ ...doc, crypto: header, secrets: {} }, sha, 'sync: set passphrase') === null) return CONFLICT;
    storeKey(k, header);
    await tracked('sync', runCycle);
    return { ok: true };
  });

  const enterPassphrase = (passphrase: string) => passphraseOp('enter passphrase', async () => {
    await ensureRepo();
    const { doc } = await fetchDoc();
    lastCrypto = doc.crypto;
    if (!doc.crypto) return failure('No sync passphrase has been set yet');
    const k = unlock(passphrase, doc.crypto);
    if (!k) return failure('Incorrect passphrase');
    storeKey(k, doc.crypto);
    await tracked('sync', runCycle);
    return { ok: true };
  });

  const changePassphrase = (current: string, nextPassphrase: string) => passphraseOp('change passphrase', async () => {
    if (nextPassphrase.length < MIN_PASSPHRASE_LENGTH) return TOO_SHORT;
    await ensureRepo();
    const first = await fetchDoc();
    if (!first.doc.crypto) return failure('No sync passphrase has been set yet');
    const old = unlock(current, first.doc.crypto);
    if (!old) return failure('Current passphrase is incorrect');
    storeKey(old, first.doc.crypto);
    await runCycle();
    const { doc, sha } = await fetchDoc();
    if (!doc.crypto || doc.crypto.keyId !== old.keyId) return CONFLICT;
    const { header, key: k } = createHeader(nextPassphrase);
    const secrets: Record<string, Entry<EncryptedBlob>> = {};
    for (const [id, e] of Object.entries(doc.secrets)) {
      if (!isLive(e)) { secrets[id] = e; continue; }
      try { secrets[id] = { updatedAt: e.updatedAt, data: encrypt(k.key, decrypt(old.key, e.data)) }; }
      catch { deps.logger.error(`sync: dropped an unreadable synced password for device ${id} while changing passphrase`); }
    }
    if (await putDoc({ ...doc, crypto: header, secrets }, sha, 'sync: change passphrase') === null) return CONFLICT;
    storeKey(k, header);
    setStatus({ state: 'synced', lastSynced: now() });
    return { ok: true };
  });

  const resetPassphrase = (nextPassphrase: string) => passphraseOp('reset passphrase', async () => {
    if (nextPassphrase.length < MIN_PASSPHRASE_LENGTH) return TOO_SHORT;
    await ensureRepo();
    const { doc, sha } = await fetchDoc();
    const { header, key: k } = createHeader(nextPassphrase);
    const t = now();
    const secrets: Record<string, Entry<EncryptedBlob>> = {};
    for (const [id, pw] of Object.entries(localPasswords())) {
      secrets[id] = { updatedAt: state.secrets[id] ?? t, data: encrypt(k.key, pw) };
    }
    if (await putDoc({ ...doc, crypto: header, secrets }, sha, 'sync: reset passphrase') === null) return CONFLICT;
    storeKey(k, header);
    await tracked('sync', runCycle);
    return { ok: true };
  });

  return {
    overview,
    syncNow,
    scheduleSync,
    onFocus() {
      if (!deps.auth.getToken() || now() - lastFocusSync < FOCUS_THROTTLE_MS) return;
      lastFocusSync = now();
      void syncNow();
    },
    noteChange,
    setPassphrase,
    enterPassphrase,
    changePassphrase,
    resetPassphrase,
    forgetKey() {
      key = null;
      deps.keyFile.clear();
      repoReady = false;
      lastCrypto = undefined;
      publish();
    },
    dispose() {
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}
