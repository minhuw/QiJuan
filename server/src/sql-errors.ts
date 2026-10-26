export function isUniqueConstraint(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const code = 'code' in error ? String((error as { code: unknown }).code) : '';
  if (code === 'SQLITE_CONSTRAINT_UNIQUE') return true;
  const message = 'message' in error ? String((error as { message: unknown }).message) : '';
  return code === 'SQLITE_CONSTRAINT' && message.includes('UNIQUE');
}
