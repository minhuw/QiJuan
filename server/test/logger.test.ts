import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { createLogger, redactOptions } from '../src/logger.js';

describe('log redaction', () => {
  it('redacts secrets, cookies, passwords, and recovery passwords', () => {
    const lines: string[] = [];
    const log = createLogger({
      write(chunk) {
        lines.push(String(chunk));
      },
    });
    log.info(
      {
        sessionSecret: 'sekrit-value',
        password: 'pw-value',
        passwordHash: 'hash-value',
        recoveryPassword: 'rec-value',
        cookie: 'cookie-value',
        req: {
          headers: {
            cookie: 'sid-value',
            authorization: 'Bearer auth-value',
          },
        },
        nested: { recoveryPassword: 'nested-rec' },
        token: 'qjt-plain-token',
        tokenHash: 'hash-of-opds-token',
      },
      'hello',
    );

    const out = lines.join('');
    expect(out).toContain('[Redacted]');
    expect(out).toContain('hello');
    for (const secret of [
      'sekrit-value',
      'pw-value',
      'hash-value',
      'rec-value',
      'cookie-value',
      'sid-value',
      'auth-value',
      'nested-rec',
      'qjt-plain-token',
      'hash-of-opds-token',
    ]) {
      expect(out).not.toContain(secret);
    }
    expect(redactOptions.censor).toBe('[Redacted]');
  });

  it('uses the same censor as a standalone pino instance', () => {
    const lines: string[] = [];
    const log = pino({ redact: redactOptions }, {
      write(chunk) {
        lines.push(String(chunk));
      },
    });
    log.info({ secret: 'hidden-secret' }, 'check');
    expect(lines.join('')).not.toContain('hidden-secret');
  });
});
