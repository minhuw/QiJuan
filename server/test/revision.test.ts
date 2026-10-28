import { describe, expect, it } from 'vitest';
import { resolveRevision } from '../src/revision.js';

describe('resolveRevision', () => {
  it('prefers a stamped sha and otherwise says dev', () => {
    expect(resolveRevision({ QIJUAN_REVISION: 'ABCDEF1234567' }, '/missing')).toBe('abcdef1234567');
    expect(resolveRevision({ QIJUAN_REVISION: 'dev' }, '/missing')).toBe('dev');
    expect(resolveRevision({ QIJUAN_REVISION: 'latest' }, '/missing')).toBe('dev');
    expect(resolveRevision({}, '/missing')).toBe('dev');
  });
});
