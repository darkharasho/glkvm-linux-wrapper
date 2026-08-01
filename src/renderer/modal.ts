export interface ModalButton { label: string; value: string; primary?: boolean; danger?: boolean; }
export interface ModalOpts {
  title: string; subtitle?: string; bodyHtml?: string;
  buttons: ModalButton[]; render?: (body: HTMLElement) => void;
}

export function openModal(opts: ModalOpts): Promise<string> {
  return new Promise((resolve) => {
    const scrim = document.createElement('div');
    scrim.className = 'scrim';
    const modal = document.createElement('div');
    modal.className = 'modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.innerHTML = `
      <div class="mh"><h3></h3>${opts.subtitle ? '<div class="s"></div>' : ''}</div>
      <div class="mb"></div>
      <div class="mf"></div>`;
    (modal.querySelector('h3') as HTMLElement).textContent = opts.title;
    if (opts.subtitle) (modal.querySelector('.s') as HTMLElement).textContent = opts.subtitle;
    const body = modal.querySelector('.mb') as HTMLElement;
    if (opts.bodyHtml) body.innerHTML = opts.bodyHtml;   // caller-escaped / trusted markup only
    opts.render?.(body);

    const foot = modal.querySelector('.mf') as HTMLElement;
    let primaryBtn: HTMLButtonElement | null = null;
    for (const b of opts.buttons) {
      const el = document.createElement('button');
      el.textContent = b.label;
      if (b.primary) { el.className = 'pri'; primaryBtn = el; }
      if (b.danger) el.className = 'danger';
      el.addEventListener('click', () => finish(b.value));
      foot.appendChild(el);
    }

    function finish(v: string) { document.removeEventListener('keydown', onKey); scrim.remove(); resolve(v); }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') finish('cancel');
      if (e.key === 'Tab') { /* trap */
        const f = modal.querySelectorAll<HTMLElement>('button, input, [tabindex]');
        if (!f.length) return;
        const first = f[0], last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) { last.focus(); e.preventDefault(); }
        else if (!e.shiftKey && document.activeElement === last) { first.focus(); e.preventDefault(); }
      }
    }
    scrim.addEventListener('mousedown', (e) => { if (e.target === scrim) finish('cancel'); });
    document.addEventListener('keydown', onKey);
    scrim.appendChild(modal);
    document.body.appendChild(scrim);
    (primaryBtn ?? modal.querySelector('button, input') as HTMLElement)?.focus();
  });
}
