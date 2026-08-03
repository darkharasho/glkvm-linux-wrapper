import { app } from 'electron';
import { decideCert } from '@shared/certs';
import type { createStore } from './store';
type Store = ReturnType<typeof createStore>;

export interface CertLogger { info(msg: string): void; }

export function installCertHandler(
  store: Store,
  promptTrust: (host: string, fingerprint: string) => Promise<boolean>,
  logger?: CertLogger,
): void {
  app.on('certificate-error', (event, _wc, url, error, certificate, callback) => {
    const host = new URL(url).host;
    const knownHosts = store.getDevices().map(d => d.address);
    const decision = decideCert(host, certificate.fingerprint, store.getTrustStore(), knownHosts);
    logger?.info(`certificate-error host=${host} error=${error} decision=${decision}`);
    if (decision === 'allow') { event.preventDefault(); callback(true); return; }
    if (decision === 'deny') { callback(false); return; }
    // prompt
    event.preventDefault();
    promptTrust(host, certificate.fingerprint).then((trusted) => {
      logger?.info(`certificate-error host=${host} user=${trusted ? 'trust' : 'cancel'}`);
      if (trusted) store.trustCert(host, certificate.fingerprint);
      callback(trusted);
    });
  });
}
