export type TrustStore = Record<string, string>;
export type CertDecision = 'allow' | 'prompt' | 'deny';

export function decideCert(
  host: string,
  fingerprint: string,
  store: TrustStore,
  knownHosts: string[],
): CertDecision {
  if (!knownHosts.includes(host)) return 'deny';
  const trusted = store[host];
  if (!trusted) return 'prompt';
  return trusted === fingerprint ? 'allow' : 'prompt';
}
