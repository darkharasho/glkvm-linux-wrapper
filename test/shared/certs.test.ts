import { describe, it, expect } from 'vitest';
import { decideCert, type TrustStore } from '@shared/certs';

const known = ['mypc.local'];

describe('decideCert', () => {
  it('denies hosts that are not saved devices', () => {
    expect(decideCert('evil.example', 'AA', {}, known)).toBe('deny');
  });
  it('prompts on first sight of a known host', () => {
    expect(decideCert('mypc.local', 'AA', {}, known)).toBe('prompt');
  });
  it('allows when the fingerprint matches the stored one', () => {
    const store: TrustStore = { 'mypc.local': 'AA' };
    expect(decideCert('mypc.local', 'AA', store, known)).toBe('allow');
  });
  it('re-prompts when the fingerprint changed', () => {
    const store: TrustStore = { 'mypc.local': 'AA' };
    expect(decideCert('mypc.local', 'BB', store, known)).toBe('prompt');
  });
});
