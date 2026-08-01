interface OverlayOpts { state: 'loading' | 'error'; message?: string; onRetry?: () => void; onBack: () => void; }

export function showOverlay(root: HTMLElement, opts: OverlayOpts): void {
  hideOverlay(root);
  const el = document.createElement('div');
  el.id = 'conn-overlay';
  el.className = 'overlay';
  const box = document.createElement('div');
  box.className = 'box';
  el.appendChild(box);

  if (opts.state === 'loading') {
    const spinner = document.createElement('div');
    spinner.className = 'spinner';
    box.appendChild(spinner);
    const msg = document.createElement('p');
    msg.textContent = 'Connecting...';
    box.appendChild(msg);
  } else {
    const err = document.createElement('p');
    err.className = 'err';
    err.textContent = "Can't reach device";
    box.appendChild(err);
    const detail = document.createElement('p');
    detail.className = 'detail';
    detail.textContent = opts.message ?? '';
    box.appendChild(detail);
    const menu = document.createElement('menu');
    const retry = document.createElement('button');
    retry.id = 'retry';
    retry.className = 'pri';
    retry.textContent = 'Retry';
    const back = document.createElement('button');
    back.id = 'back';
    back.textContent = 'Back to dashboard';
    menu.appendChild(retry);
    menu.appendChild(back);
    box.appendChild(menu);
  }

  root.appendChild(el);
  if (opts.onRetry) el.querySelector('#retry')?.addEventListener('click', opts.onRetry);
  el.querySelector('#back')?.addEventListener('click', opts.onBack);
}

export function hideOverlay(root: HTMLElement): void {
  root.querySelector('#conn-overlay')?.remove();
}
