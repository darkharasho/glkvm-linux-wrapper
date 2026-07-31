import { renderDashboard } from './dashboard';
import { openSettings } from './settingsPanel';

const root = document.querySelector('#app') as HTMLElement;
renderDashboard(root);
window.addEventListener('open-settings', () => openSettings(root, () => renderDashboard(root)));
window.glkvm.onNavigate((view) => { if (view === 'dashboard') renderDashboard(root); });
