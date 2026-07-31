import { describe, it, expect } from 'vitest';
import { normalizeAddress, isValidAddress, toDeviceUrl } from '@shared/url';

describe('normalizeAddress', () => {
  it('strips scheme, path, and trailing slash', () => {
    expect(normalizeAddress('https://workmac.local/')).toBe('workmac.local');
    expect(normalizeAddress('http://WorkMac.local/ui')).toBe('workmac.local');
    expect(normalizeAddress('  workmac.local  ')).toBe('workmac.local');
  });
  it('keeps an explicit port', () => {
    expect(normalizeAddress('workmac.local:8443')).toBe('workmac.local:8443');
  });
  it('rejects empty or whitespace input', () => {
    expect(() => normalizeAddress('   ')).toThrow();
  });
});

describe('isValidAddress', () => {
  it('is false for empty, true for a host', () => {
    expect(isValidAddress('')).toBe(false);
    expect(isValidAddress('workmac.local')).toBe(true);
  });
});

describe('toDeviceUrl', () => {
  it('always produces an https url', () => {
    expect(toDeviceUrl('workmac.local')).toBe('https://workmac.local');
  });
});
