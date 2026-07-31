import { appendFileSync, existsSync, statSync, renameSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export function createLogger(logDir: string, maxBytes = 1_000_000) {
  mkdirSync(logDir, { recursive: true });
  const file = join(logDir, 'app.log');
  const write = (level: string, msg: string) => {
    if (existsSync(file) && statSync(file).size > maxBytes) renameSync(file, `${file}.1`);
    appendFileSync(file, `${new Date().toISOString()} [${level}] ${msg}\n`);
  };
  return {
    info: (msg: string) => write('INFO', msg),
    error: (msg: string, err?: unknown) => write('ERROR', err ? `${msg}: ${String(err)}` : msg),
  };
}
