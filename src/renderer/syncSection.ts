import type { SyncOverview, SyncResult } from '@shared/sync/format';

type FormKind = 'set' | 'enter' | 'change' | 'reset' | 'signout';

interface FormCopy { title: string; text?: string; fields: Array<'current' | 'passphrase' | 'confirm'>; submit: string; cancel: string; danger?: boolean; }

const FORMS: Record<FormKind, FormCopy> = {
  set: {
    title: 'Set a sync passphrase',
    text: "Saved passwords are encrypted with this before they're sent to GitHub. It can't be recovered — if you forget it you can reset it, and each computer keeps its own saved passwords.",
    fields: ['passphrase', 'confirm'], submit: 'Set passphrase', cancel: 'Skip for now',
  },
  enter: {
    title: 'Enter your sync passphrase',
    fields: ['passphrase'], submit: 'Unlock passwords', cancel: 'Cancel',
  },
  change: {
    title: 'Change sync passphrase',
    text: "Your other computers will ask for the new passphrase. Older copies in the repository's history stay protected only if the old passphrase was never exposed.",
    fields: ['current', 'passphrase', 'confirm'], submit: 'Change passphrase', cancel: 'Cancel',
  },
  reset: {
    title: 'Reset sync passphrase',
    text: 'This deletes the synced passwords from GitHub and sets a new passphrase. Each computer keeps the passwords it has saved; they sync again once that computer enters the new passphrase.',
    fields: ['passphrase', 'confirm'], submit: 'Reset passphrase', cancel: 'Cancel', danger: true,
  },
  signout: {
    title: 'Sign out of GitHub?',
    text: 'Sync stops on this computer. Your devices and saved passwords stay here, and the GitHub repository is not changed.',
    fields: [], submit: 'Sign out', cancel: 'Cancel', danger: true,
  },
};

const LABELS = { current: 'Current passphrase', passphrase: 'Passphrase', confirm: 'Confirm passphrase' };

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K, attrs: Record<string, string> = {}, ...children: Array<Node | string>
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  node.append(...children);
  return node;
}

function button(label: string, onClick: () => void, cls = ''): HTMLButtonElement {
  const b = h('button', cls ? { class: cls, type: 'button' } : { type: 'button' }, label);
  b.onclick = onClick;
  return b;
}

const row = (...children: Node[]) => h('div', { class: 'sync-row' }, ...children);

function note(kind: 'warn' | 'err', title: string, text: string): HTMLElement {
  return h('div', { class: `sync-note ${kind}` }, h('b', {}, title), text);
}

function relative(ts: number): string {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function statusPill(o: SyncOverview): HTMLElement {
  const { state, lastSynced } = o.sync;
  const text = state === 'syncing' ? 'Syncing…'
    : state === 'error' ? 'Sync failed'
    : state === 'synced' && lastSynced ? `Synced ${relative(lastSynced)}`
    : 'Not synced yet';
  return h('div', { class: `sync-pill ${state}` }, h('i'), text);
}

export function mountSyncSection(el: HTMLElement): () => void {
  let overview: SyncOverview | null = null;
  let signing: { userCode: string; expiresAt: number } | null = null;
  let authError = '';
  let formEl: HTMLElement | null = null;

  const offOverview = window.glkvm.onSyncOverview((o) => {
    overview = o;
    if (o.user) { signing = null; authError = ''; }
    render();
  });
  const offAuthError = window.glkvm.onGithubAuthError((message) => { signing = null; authError = message; render(); });
  const tick = window.setInterval(() => { if (signing || overview?.sync.state === 'synced') render(); }, 1000);
  void window.glkvm.syncOverview().then((o) => { overview = o; render(); });

  function closeForm(): void { formEl = null; render(); }

  function openForm(kind: FormKind): void {
    formEl = buildForm(kind);
    render();
    formEl.querySelector('input')?.focus();
  }

  function buildForm(kind: FormKind): HTMLElement {
    const copy = FORMS[kind];
    const box = h('div', { class: 'sync-form' }, h('h5', {}, copy.title));
    if (copy.text) box.append(h('p', { class: 's' }, copy.text));
    const inputs: Partial<Record<'current' | 'passphrase' | 'confirm', HTMLInputElement>> = {};
    for (const f of copy.fields) {
      const input = h('input', { type: 'password', autocomplete: 'off' });
      inputs[f] = input;
      box.append(h('div', { class: 'fld' }, h('label', {}, LABELS[f]), input));
    }
    const errorEl = h('div', { class: 'sync-error' });
    const submitBtn = button(copy.submit, () => void submit(), copy.danger ? 'danger' : 'pri');
    const cancelBtn = button(copy.cancel, closeForm);
    box.append(errorEl, row(cancelBtn, submitBtn));

    async function submit(): Promise<void> {
      const p = inputs.passphrase?.value ?? '';
      if (inputs.confirm && inputs.confirm.value !== p) { errorEl.textContent = "Passphrases don't match"; return; }
      submitBtn.disabled = true; cancelBtn.disabled = true; errorEl.textContent = '';
      let result: SyncResult;
      if (kind === 'set') result = await window.glkvm.syncSetPassphrase(p);
      else if (kind === 'enter') result = await window.glkvm.syncEnterPassphrase(p);
      else if (kind === 'change') result = await window.glkvm.syncChangePassphrase(inputs.current?.value ?? '', p);
      else if (kind === 'reset') result = await window.glkvm.syncResetPassphrase(p);
      else { await window.glkvm.githubSignOut(); result = { ok: true }; }
      for (const input of Object.values(inputs)) input.value = '';
      submitBtn.disabled = false; cancelBtn.disabled = false;
      if (result.ok) closeForm(); else errorEl.textContent = result.error;
    }

    box.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); void submit(); }
    });
    return box;
  }

  async function startAuth(btn: HTMLButtonElement): Promise<void> {
    authError = '';
    btn.disabled = true;
    const r = await window.glkvm.githubStartAuth();
    if (r.ok) signing = { userCode: r.userCode, expiresAt: Date.now() + r.expiresIn * 1000 };
    else authError = r.error;
    render();
  }

  function renderSignedOut(o: SyncOverview): void {
    if (signing) {
      const code = signing.userCode;
      const left = Math.max(0, Math.round((signing.expiresAt - Date.now()) / 1000));
      el.append(
        h('p', { class: 's' }, 'Enter this code on the GitHub page that opened in your browser.'),
        h('div', { class: 'sync-code' }, code),
        row(
          button('Copy code', () => { void navigator.clipboard.writeText(code); }),
          button('Open GitHub', () => { void window.glkvm.githubOpenVerification(); }),
          button('Cancel', () => { signing = null; void window.glkvm.githubCancelAuth(); render(); }),
        ),
        h('p', { class: 's small' }, `Waiting for approval… code expires in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`),
      );
      return;
    }
    el.append(h('p', { class: 's' }, 'Sync devices, settings, trusted certificates and saved passwords across your computers using a private GitHub repository.'));
    const error = authError || (o.sync.state === 'error' ? o.sync.error ?? '' : '');
    if (error) el.append(note('err', 'GitHub sign-in', error));
    if (!o.configured) {
      el.append(h('p', { class: 's small' }, "GitHub sign-in isn't configured in this build."));
      return;
    }
    const signIn = button('Sign in with GitHub', () => void startAuth(signIn), 'pri');
    el.append(row(signIn));
  }

  function renderSignedIn(o: SyncOverview): void {
    const user = o.user!;
    el.append(h('div', { class: 'sync-who' },
      h('div', { class: 'sync-av' }, user.login.slice(0, 1).toUpperCase()),
      h('div', {}, h('b', {}, user.name), h('span', {}, `github.com/${user.login}/glkvm-config`)),
      statusPill(o),
    ));
    if (o.sync.state === 'error' && o.sync.error) {
      el.append(note('err', "Sync didn't finish", `${o.sync.error}. Your local devices work normally.`));
    }
    if (o.passwords === 'needs-set') {
      el.append(note('warn', "Passwords aren't syncing yet", 'Set a sync passphrase to sync saved passwords. Devices, settings and certificates already sync.'));
    } else if (o.passwords === 'needs-passphrase') {
      el.append(note('warn', "Passwords aren't syncing on this computer", 'Devices, settings and certificates are up to date. Enter your sync passphrase to sync saved passwords.'));
    } else if (o.passwords === 'unavailable') {
      el.append(note('warn', "Passwords can't sync on this computer", 'This system has no secure storage for saved passwords.'));
    }
    if (formEl) { el.append(formEl); return; }
    const actions = [button('Sync now', () => { void window.glkvm.syncNow(); })];
    if (o.passwords === 'needs-set') actions.push(button('Set passphrase…', () => openForm('set'), 'pri'));
    if (o.passwords === 'needs-passphrase') {
      actions.push(button('Enter passphrase…', () => openForm('enter'), 'pri'), button('Forgot passphrase', () => openForm('reset')));
    }
    if (o.passwords === 'syncing') actions.push(button('Change passphrase…', () => openForm('change')));
    actions.push(button('Sign out', () => openForm('signout'), 'danger'));
    el.append(row(...actions));
  }

  function render(): void {
    el.replaceChildren();
    if (!overview) return;
    el.append(h('h4', {}, 'Sync'));
    if (overview.user) renderSignedIn(overview);
    else { formEl = null; renderSignedOut(overview); }
  }

  return () => {
    offOverview();
    offAuthError();
    window.clearInterval(tick);
  };
}
