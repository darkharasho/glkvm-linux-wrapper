import { renderDashboard } from './dashboard';
import { openSettings } from './settingsPanel';
import { showOverlay, hideOverlay } from './overlay';

const root = document.querySelector('#app') as HTMLElement;
renderDashboard(root);
window.addEventListener('open-settings', () => openSettings(root, () => renderDashboard(root)));
window.glkvm.onNavigate((view) => { if (view === 'dashboard') renderDashboard(root); });

let lastDeviceId: string | null = null;
window.glkvm.onConnectionState((s) => {
  lastDeviceId = s.deviceId;
  if (s.state === 'loading') showOverlay(root, { state: 'loading', onRetry: () => {}, onBack: () => window.glkvm.disconnect() });
  else if (s.state === 'error') showOverlay(root, {
    state: 'error', message: s.message,
    onRetry: () => lastDeviceId && window.glkvm.connect(lastDeviceId),
    onBack: () => window.glkvm.disconnect(),
  });
  else hideOverlay(root);
});
