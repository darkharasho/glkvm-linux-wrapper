import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/inter/700.css';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
import { renderDashboard } from './dashboard';
import { openSettings } from './settingsPanel';
import { showOverlay, hideOverlay } from './overlay';
import { openModal } from './modal';

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

const root = document.querySelector('#app') as HTMLElement;
renderDashboard(root);
window.addEventListener('open-settings', () => openSettings(root, () => renderDashboard(root)));
window.glkvm.onNavigate((view) => { if (view === 'dashboard') renderDashboard(root); });

let lastDeviceId: string | null = null;
window.glkvm.onConnectionState((s) => {
  lastDeviceId = s.deviceId;
  if (s.state === 'loading') showOverlay(root, { state: 'loading', onBack: () => window.glkvm.disconnect() });
  else if (s.state === 'error') showOverlay(root, {
    state: 'error', message: s.message,
    onRetry: () => lastDeviceId && window.glkvm.connect(lastDeviceId),
    onBack: () => window.glkvm.disconnect(),
  });
  else hideOverlay(root);
});

window.glkvm.onModalShow(async (spec) => {
  let value = 'cancel';
  if (spec.kind === 'cert-trust') {
    value = await openModal({
      title: 'Trust this device?',
      subtitle: `${spec.host} is using a self-signed certificate. Trust it only if you recognize this device.`,
      bodyHtml: `<div class="fp"><span class="k">SHA-256</span><br>${escapeHtml(String(spec.fingerprint))}</div>`,
      buttons: [{ label: 'Cancel', value: 'cancel' }, { label: 'Trust device', value: 'trust', primary: true }],
    });
  } else if (spec.kind === 'import-choice') {
    value = await openModal({
      title: 'Import devices & settings',
      subtitle: 'Merge with your current setup, or replace everything?',
      buttons: [{ label: 'Cancel', value: 'cancel' }, { label: 'Merge', value: 'merge' }, { label: 'Replace', value: 'replace', primary: true }],
    });
  } else if (spec.kind === 'alert') {
    value = await openModal({
      title: 'Import failed',
      subtitle: String(spec.message),
      buttons: [{ label: 'OK', value: 'ok', primary: true }],
    });
  } else if (spec.kind === 'update-ready') {
    value = await openModal({
      title: 'Update ready',
      subtitle: `GLKVM ${spec.version} is ready to install.`,
      buttons: [{ label: 'Later', value: 'later' }, { label: 'Restart now', value: 'restart', primary: true }],
    });
  }
  window.glkvm.modalDone(spec.id, value);
});
