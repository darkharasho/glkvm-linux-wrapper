import { app } from 'electron';
import { decideCert } from '@shared/certs';
import type { createStore } from './store';
type Store = ReturnType<typeof createStore>;

export function installCertHandler(store: Store, promptTrust: (host: string, fingerprint: string) => Promise<boolean>): void {
  app.on('certificate-error', (event, _wc, url, _error, certificate, callback) => {
    const host = new URL(url).host;
    const knownHosts = store.getDevices().map(d => d.address);
    const decision = decideCert(host, certificate.fingerprint, store.getTrustStore(), knownHosts);
    if (decision === 'allow') { event.preventDefault(); callback(true); return; }
    if (decision === 'deny') { callback(false); return; }
    // prompt
    event.preventDefault();
    promptTrust(host, certificate.fingerprint).then((trusted) => {
      if (trusted) store.trustCert(host, certificate.fingerprint);
      callback(trusted);
    });
  });
}
