export function normalizeAddress(input: string): string {
  let s = input.trim();
  if (!s) throw new Error('Address is empty');
  s = s.replace(/^[a-z]+:\/\//i, '');   // strip scheme
  s = s.split('/')[0];                   // strip path
  s = s.replace(/\/+$/, '');             // strip trailing slash
  s = s.toLowerCase();
  if (!s) throw new Error('Address is empty after normalization');
  if (/\s/.test(s)) throw new Error('Address contains whitespace');
  return s;
}

export function isValidAddress(input: string): boolean {
  try { normalizeAddress(input); return true; } catch { return false; }
}

export function toDeviceUrl(address: string): string {
  return `https://${normalizeAddress(address)}`;
}
