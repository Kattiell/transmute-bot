/**
 * Telegram-HTML card rendered when someone posts a CA in a group or in the
 * bot DM (RickBurpBot-style auto-reply). Chain-agnostic: the caller passes the
 * ChainInfo (Base by default) that sets the branding line and explorer link.
 * All user/token-derived strings are escaped before they touch HTML parse
 * mode — token names and Telegram first names are attacker-controlled input.
 */

import { BASE_CHAIN, type ChainInfo } from '../chains';
import type { DexSnapshot } from '../dexscreener';
import type { TokenCall } from './tokencalls';

function esc(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function fmtUsdCompact(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '?';
  if (n >= 1_000_000_000) return `$${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  if (n >= 1) return `$${n.toFixed(2)}`;
  return `$${n.toFixed(6)}`;
}

export function fmtMultiplier(x: number | null): string {
  if (x === null || !Number.isFinite(x)) return '—';
  if (x >= 100) return `${x.toFixed(0)}x`;
  if (x >= 10) return `${x.toFixed(1)}x`;
  return `${x.toFixed(2)}x`;
}

export function fmtAge(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return 'just now';
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function pairAge(days: number | null): string {
  if (days === null || !Number.isFinite(days)) return '?';
  if (days < 1) return `${(days * 24).toFixed(1)}h`;
  if (days < 30) return `${days.toFixed(1)}d`;
  return `${Math.floor(days / 30)}mo ${Math.floor(days % 30)}d`;
}

export function callerHandle(call: {
  caller_username: string | null;
  caller_first_name: string | null;
}): string {
  if (call.caller_username) return `@${call.caller_username}`;
  if (call.caller_first_name) return call.caller_first_name;
  return 'anonymous seeker';
}

/** Best FDV the token is known to have reached since the call. */
export function reachedFdv(call: TokenCall, currentFdv: number | null): number | null {
  const candidates = [call.ath_fdv, currentFdv, call.fdv_at_call].filter(
    (n): n is number => n !== null && Number.isFinite(n),
  );
  return candidates.length > 0 ? Math.max(...candidates) : null;
}

export function callMultiplier(call: TokenCall, currentFdv: number | null): number | null {
  const reached = reachedFdv(call, currentFdv);
  if (!reached || !call.fdv_at_call || call.fdv_at_call <= 0) return null;
  return reached / call.fdv_at_call;
}

export function formatCaCard(opts: {
  snapshot: DexSnapshot;
  call: TokenCall;
  isNewCall: boolean;
  chain?: ChainInfo;
}): string {
  const { snapshot: snap, call, isNewCall, chain = BASE_CHAIN } = opts;
  const ticker = snap.symbol ? `$${snap.symbol.toUpperCase()}` : 'TOKEN';
  const handle = callerHandle(call);
  // Highest FDV seen since the call was first tracked; the field renders even
  // before a value exists so the card layout stays stable.
  const ath = reachedFdv(call, snap.fdvUsd);

  const lines = [
    `▣ <b>${esc(ticker)}</b> — <i>${esc(snap.name || 'Unknown')}</i>`,
    `${chain.emoji} ${esc(chain.label)} · 📈 <a href="${esc(snap.url)}">${esc(snap.sourceName ?? 'DexScreener')}</a> · 🔍 <a href="${esc(chain.explorerTokenUrl(snap.address.toLowerCase()))}">${esc(chain.explorerName)}</a>`,
    `<code>${esc(snap.address.toLowerCase())}</code>`,
    '',
    `💰 FDV: <b>${fmtUsdCompact(snap.fdvUsd)}</b>`,
    `👁️ ATH: <b>${ath === null ? '$???' : fmtUsdCompact(ath)}</b>`,
    `💧 LIQ: <b>${fmtUsdCompact(snap.liquidityUsd)}</b>`,
    `📊 VOL 24h: <b>${fmtUsdCompact(snap.volume24hUsd)}</b>`,
    `⏳ Pair age: <b>${pairAge(snap.pairAgeDays)}</b>`,
    '',
  ];

  if (isNewCall) {
    lines.push(`🟡 Called by <b>${esc(handle)}</b> @ <b>${fmtUsdCompact(call.fdv_at_call)}</b> · just now`);
  } else {
    const mult = callMultiplier(call, snap.fdvUsd);
    const reached = reachedFdv(call, snap.fdvUsd);
    lines.push(
      `🟡 First called by <b>${esc(handle)}</b> @ <b>${fmtUsdCompact(call.fdv_at_call)}</b> · ${esc(fmtAge(call.called_at))}`,
    );
    if (mult !== null) {
      lines.push(`🚀 Reached <b>${fmtUsdCompact(reached)}</b> (<b>${fmtMultiplier(mult)}</b>)`);
    }
  }

  lines.push('', `🎴 <i>/flex to mint the flexcard · DYOR — NFA</i>`);
  return lines.join('\n');
}

/** Plain-HTML fallback when flexcard image rendering fails. */
export function formatFlexFallback(opts: {
  call: TokenCall;
  currentFdv: number | null;
}): string {
  const { call, currentFdv } = opts;
  const ticker = call.ticker ? `$${call.ticker.toUpperCase()}` : 'TOKEN';
  const mult = callMultiplier(call, currentFdv);
  const reached = reachedFdv(call, currentFdv);
  return [
    `🎴 <b>FLEX — ${esc(ticker)}</b>`,
    '',
    `🟡 <b>${esc(callerHandle(call))}</b> called @ <b>${fmtUsdCompact(call.fdv_at_call)}</b> · ${esc(fmtAge(call.called_at))}`,
    `🚀 Reached <b>${fmtUsdCompact(reached)}</b>`,
    `✨ <b>${fmtMultiplier(mult)}</b>`,
    '',
    `<i>𓂀 Transmute Oracle · DYOR — NFA</i>`,
  ].join('\n');
}
