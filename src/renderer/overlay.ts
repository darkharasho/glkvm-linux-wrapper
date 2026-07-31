interface OverlayOpts { state: 'loading' | 'error'; message?: string; onRetry?: () => void; onBack: () => void; }

export function showOverlay(root: HTMLElement, opts: OverlayOpts): void {
  hideOverlay(root);
  const el = document.createElement('div');
  el.id = 'conn-overlay';
  el.className = `overlay ${opts.state}`;
  el.innerHTML = opts.state === 'loading'
    ? `<div class="spinner"></div><p>Connecting…</p>`
    : `<p class="err">Can’t reach device</p><p class="detail"></p>
       <menu><button id="retry">Retry</button><button id="back">Back to dashboard</button></menu>`;
  if (opts.state === 'error') {
    const detail = el.querySelector('.detail');
    if (detail) detail.textContent = opts.message ?? '';
  }
  root.appendChild(el);
  if (opts.onRetry) el.querySelector('#retry')?.addEventListener('click', opts.onRetry);
  el.querySelector('#back')?.addEventListener('click', opts.onBack);
}

export function hideOverlay(root: HTMLElement): void {
  root.querySelector('#conn-overlay')?.remove();
}
