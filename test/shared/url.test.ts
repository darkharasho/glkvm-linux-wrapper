import { describe, it, expect } from 'vitest';
import { normalizeAddress, isValidAddress, toDeviceUrl } from '@shared/url';

describe('normalizeAddress', () => {
  it('strips scheme, path, and trailing slash', () => {
    expect(normalizeAddress('https://mypc.local/')).toBe('mypc.local');
    expect(normalizeAddress('http://MyPC.local/ui')).toBe('mypc.local');
    expect(normalizeAddress('  mypc.local  ')).toBe('mypc.local');
  });
  it('keeps an explicit port', () => {
    expect(normalizeAddress('mypc.local:8443')).toBe('mypc.local:8443');
  });
  it('rejects empty or whitespace input', () => {
    expect(() => normalizeAddress('   ')).toThrow();
  });
});

describe('isValidAddress', () => {
  it('is false for empty, true for a host', () => {
    expect(isValidAddress('')).toBe(false);
    expect(isValidAddress('mypc.local')).toBe(true);
  });
});

describe('toDeviceUrl', () => {
  it('always produces an https url', () => {
    expect(toDeviceUrl('mypc.local')).toBe('https://mypc.local');
  });
});
