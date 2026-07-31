import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger } from '../../src/main/services/logger';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'glkvm-log-')); });

describe('logger', () => {
  it('writes and rotates past the size cap', () => {
    const log = createLogger(dir, 1024); // tiny cap for the test
    for (let i = 0; i < 200; i++) log.info('x'.repeat(50));
    expect(existsSync(join(dir, 'app.log'))).toBe(true);
    expect(existsSync(join(dir, 'app.log.1'))).toBe(true);
    expect(statSync(join(dir, 'app.log')).size).toBeLessThan(2048);
  });
});
