/**
 * Camada 1 — INTENT extraction.
 *
 * We do NOT add a second LLM call. The existing Oracle already ran the model and
 * produced a parsed signal; this turns that into a typed `GrokIntent`, mining the
 * official X handles + links from the narrative and QUARANTINING the model's CA
 * as an untrusted cross-check value (never propagated — invariant I1).
 */

import type { ParsedProject } from '../types';
import { BASE_CHAIN_ID, type GrokIntent } from './types';
import { firstModelEvmAddress } from './address';

const URL_RE = /https?:\/\/[^\s)<>"']+/gi;
// twitter.com/x.com handle in a URL (ignores intent/share/status sub-paths).
const X_URL_RE = /(?:twitter\.com|x\.com)\/(?!i\/|intent\/|share|home|hashtag\/|search)([A-Za-z0-9_]{1,15})/gi;
// "@handle" mentions (1–15 word chars, the X handle grammar).
const AT_HANDLE_RE = /(?<![A-Za-z0-9_@])@([A-Za-z0-9_]{2,15})\b/g;

function normHandle(h: string): string {
  return h.replace(/^@/, '').trim().toLowerCase();
}

/** Extract official X/Twitter handles from a signal's narrative text. */
export function extractXHandles(text: string): string[] {
  const out = new Set<string>();
  let m: RegExpExecArray | null;
  X_URL_RE.lastIndex = 0;
  while ((m = X_URL_RE.exec(text)) !== null) out.add(normHandle(m[1]));
  AT_HANDLE_RE.lastIndex = 0;
  while ((m = AT_HANDLE_RE.exec(text)) !== null) out.add(normHandle(m[1]));
  return [...out].filter((h) => h.length >= 2);
}

/** Extract handle from a single twitter/x URL, or null. */
export function xHandleFromUrl(url: string): string | null {
  const m = url.match(/(?:twitter\.com|x\.com)\/(?!i\/|intent\/|share|home|hashtag\/|search)([A-Za-z0-9_]{1,15})/i);
  return m ? normHandle(m[1]) : null;
}

function extractUrls(text: string): string[] {
  const out = new Set<string>();
  let m: RegExpExecArray | null;
  URL_RE.lastIndex = 0;
  while ((m = URL_RE.exec(text)) !== null) out.add(m[0].replace(/[.,)]+$/, ''));
  return [...out];
}

/**
 * Build a typed intent from an already-parsed Oracle signal. `p.ca` is taken as
 * the UNTRUSTED model CA (cross-check only); it is never used as the output CA.
 */
export function extractIntent(p: ParsedProject): GrokIntent {
  const text = p.fullText ?? '';
  const symbol = p.ticker && p.ticker !== 'UNKNOWN' ? p.ticker.replace(/^\$/, '').toUpperCase() : null;
  return {
    symbol,
    name: p.name && p.name !== 'Project' ? p.name : null,
    officialXHandles: extractXHandles(text),
    officialLinks: extractUrls(text),
    chainHint: BASE_CHAIN_ID,
    // The bot's ParsedProject has no `ca` field — the model's CA lives inside the
    // narrative. Pull it ONLY as an untrusted cross-check (never propagated, I1).
    modelCa: firstModelEvmAddress(text),
  };
}
