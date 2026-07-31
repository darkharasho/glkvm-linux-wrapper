import { describe, it, expect } from 'vitest';
import { ping } from '@shared/sanity';

describe('sanity', () => {
  it('proves the toolchain and @shared alias resolve', () => {
    expect(ping()).toBe('pong');
  });
});
