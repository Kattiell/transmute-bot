/**
 * Address utilities — the cheapest, first line of defense for invariant I1.
 *
 * A hallucinated address almost always dies on format/checksum here, before any
 * network call. The canonical identity is the EIP-55 checksummed address.
 */

import { isAddress, getAddress } from 'viem';

const EVM_RE = /^0x[0-9a-fA-F]{40}$/;
// 0x + 40 hex anywhere (for scrubbing model text).
const EVM_ANYWHERE = /0x[0-9a-fA-F]{40}/g;
// base58 run long enough to look like a Solana mint (for scrubbing only; not resolved here).
const BASE58_ANYWHERE = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g;

/**
 * Format + checksum validation. If the string is MIXED-case it claims to be an
 * EIP-55 checksummed address, so the checksum MUST verify — this is exactly what
 * catches a model-hallucinated address. All-lowercase / all-uppercase is accepted
 * at the format level (tool APIs return lowercase canonical addresses).
 */
export function isValidEvmAddress(addr: string): boolean {
  const a = addr.trim();
  if (!EVM_RE.test(a)) return false;
  const hex = a.slice(2);
  const hasUpper = /[A-F]/.test(hex);
  const hasLower = /[a-f]/.test(hex);
  if (hasUpper && hasLower) {
    // Mixed-case → must be a valid EIP-55 checksum.
    return isAddress(a, { strict: true });
  }
  return true;
}

/** Normalize a format-valid address to its EIP-55 canonical form. Throws if invalid. */
export function toCanonicalAddress(addr: string): `0x${string}` {
  return getAddress(addr.trim());
}

/**
 * Solana mint placeholder — out of scope (Base/EVM only), kept so the surface is
 * extensible. Always returns false here so nothing Solana slips through as valid.
 */
export function isValidSolanaMint(_addr: string): boolean {
  return false;
}

/**
 * Defense-in-depth (I1): scrub anything address-shaped out of model-generated
 * text so a leaked CA can never be picked up downstream. Returns the cleaned
 * text and the list of stripped addresses (for leak logging).
 */
export function stripModelAddresses(text: string): { cleaned: string; stripped: string[] } {
  const stripped: string[] = [];
  let cleaned = text.replace(EVM_ANYWHERE, (m) => {
    stripped.push(m);
    return '[address-removed]';
  });
  cleaned = cleaned.replace(BASE58_ANYWHERE, (m) => {
    // Only treat as an address if it isn't obviously a normal word/number.
    if (/^[0-9]+$/.test(m)) return m;
    stripped.push(m);
    return '[address-removed]';
  });
  return { cleaned, stripped };
}

/** Pull the first EVM address out of model text (UNTRUSTED — cross-check only). */
export function firstModelEvmAddress(text: string): string | null {
  const m = text.match(/0x[0-9a-fA-F]{40}/);
  return m ? m[0] : null;
}

/** Compare two addresses by canonical identity (case-insensitive). */
export function sameAddress(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}
