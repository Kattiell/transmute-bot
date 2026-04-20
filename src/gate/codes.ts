import { createHash } from 'crypto';

const CODE_PREFIX = 'TXM';
const CODE_CHUNK_LEN = 4;
const CODE_CHUNKS = 2;
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function normalizeCode(raw: string): string | null {
  const cleaned = raw.trim().toUpperCase().replace(/\s+/g, '');
  const expected = new RegExp(`^${CODE_PREFIX}-[A-Z0-9]{${CODE_CHUNK_LEN}}-[A-Z0-9]{${CODE_CHUNK_LEN}}$`);
  if (!expected.test(cleaned)) return null;
  const body = cleaned.slice(CODE_PREFIX.length + 1).replace(/-/g, '');
  for (const ch of body) if (!ALPHABET.includes(ch)) return null;
  return cleaned;
}

export function hashCode(code: string): string {
  const cleaned = code.trim().toUpperCase().replace(/-/g, '');
  return createHash('sha256').update(cleaned).digest('hex');
}

export function maskCode(code: string): string {
  const body = code.slice(CODE_PREFIX.length + 1);
  return `${CODE_PREFIX}-••••-${body.slice(-CODE_CHUNK_LEN)}`;
}
