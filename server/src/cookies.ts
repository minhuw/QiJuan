export const SESSION_COOKIE = 'qijuan_session';
export const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    if (trimmed.slice(0, eq) !== name) continue;
    const raw = trimmed.slice(eq + 1);
    if (raw.length === 0 || raw.length > 200) return undefined;
    try {
      return decodeURIComponent(raw);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** httpOnly and SameSite=Lax always; Secure only when the caller says the request is HTTPS. */
export function serializeSessionCookie(value: string, secure: boolean, maxAge: number): string {
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(value)}`,
    'HttpOnly',
    'SameSite=Lax',
    'Path=/',
    `Max-Age=${maxAge}`,
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export function clearSessionCookie(secure: boolean): string {
  return serializeSessionCookie('', secure, 0);
}
