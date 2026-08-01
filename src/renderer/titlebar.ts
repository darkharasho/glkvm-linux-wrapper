import type { RailState, WinControlAction } from '../preload/rail-api';

const bar = document.querySelector('#rail') as HTMLElement;

function controls(): string {
  return `<div class="ctrls no-drag">
    <button class="c" data-a="min" aria-label="Minimize">–</button>
    <button class="c" data-a="max" aria-label="Maximize">▢</button>
    <button class="c x" data-a="close" aria-label="Close">✕</button>
  </div>`;
}

function render(s: RailState): void {
  bar.innerHTML =
    s.mode === 'connected'
      ? `<div class="l no-drag">
           <button id="back" class="ghost">‹ Devices</button><span class="sep"></span>
           <span class="dev"></span>
           <span class="cap ${s.captureOn ? 'on' : ''}"><span class="dot"></span><span class="mono">CAPTURE ${s.captureOn ? 'ON' : 'OFF'}</span></span>
         </div>
         <div class="r no-drag"><button id="disc" class="ghost danger">Disconnect</button>${controls()}</div>`
      : `<div class="l"><span class="wm">GLKVM</span></div><div class="r no-drag">${controls()}</div>`;
  const dev = bar.querySelector('.dev');
  if (dev) dev.textContent = s.deviceName ?? '';
  wire();
}

function wire(): void {
  bar.querySelector('#back')?.addEventListener('click', () => window.rail.back());
  bar.querySelector('#disc')?.addEventListener('click', () => window.rail.disconnect());
  bar.querySelectorAll<HTMLElement>('.c').forEach((b) =>
    b.addEventListener('click', () => window.rail.control(b.dataset.a as WinControlAction))
  );
}

bar.addEventListener('dblclick', (e) => {
  const target = e.target as HTMLElement;
  if (target.closest('.no-drag')) return;
  window.rail.control('max');
});

window.rail.onState(render);
render({ mode: 'idle' });
