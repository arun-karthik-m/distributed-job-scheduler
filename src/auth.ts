// Password hashing with the Node stdlib (scrypt) — no bcrypt dependency needed.
import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';

export function hashPassword(pw: string): string {
  const salt = randomBytes(16);
  const key = scryptSync(pw, salt, 64);
  return `${salt.toString('hex')}:${key.toString('hex')}`;
}

export function verifyPassword(pw: string, stored: string): boolean {
  const [saltHex, keyHex] = stored.split(':');
  if (!saltHex || !keyHex) return false;
  const key = Buffer.from(keyHex, 'hex');
  const test = scryptSync(pw, Buffer.from(saltHex, 'hex'), 64);
  return key.length === test.length && timingSafeEqual(key, test);
}
