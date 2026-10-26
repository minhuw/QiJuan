import { scrypt, randomBytes, timingSafeEqual } from 'node:crypto';

/** Stored as `scrypt$N$r$p$salt$hash`, all generated with node:crypto scrypt. */
const N = 16384;
const R = 8;
const P = 1;
const KEYLEN = 32;

const STORED = /^scrypt\$(\d+)\$(\d+)\$(\d+)\$([A-Za-z0-9+/]+=*)\$([A-Za-z0-9+/]+=*)$/;

function derive(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, KEYLEN, { N, r: R, p: P }, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await derive(password, salt);
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${derived.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const match = STORED.exec(stored);
  if (!match) return false;
  const paramsN = Number(match[1]);
  const paramsR = Number(match[2]);
  const paramsP = Number(match[3]);
  if (paramsN !== N || paramsR !== R || paramsP !== P) return false;

  const salt = Buffer.from(match[4] ?? '', 'base64');
  const expected = Buffer.from(match[5] ?? '', 'base64');
  if (salt.length !== 16 || expected.length !== KEYLEN) return false;

  const derived = await derive(password, salt);
  if (derived.length !== expected.length) return false;
  return timingSafeEqual(derived, expected);
}
