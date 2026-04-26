/**
 * Telegram-HTML formatters for the Call Now broadcast and the /gods leaderboard.
 *
 * Visual style takes cues from the Altcoinist Signals card (call alert) and the
 * RickBurpBot /groupburp leaderboard (Pantheon).
 */

import type { OracleCall } from './calls';

function esc(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function fmtUsd(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return 'unknown';
  if (n >= 1_000_000_000) return `$${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  if (n >= 1) return `$${n.toFixed(2)}`;
  return `$${n.toFixed(6)}`;
}

function fmtMultiplier(x: number | null): string {
  if (x === null || !Number.isFinite(x)) return '—';
  if (x >= 100) return `${x.toFixed(0)}x`;
  if (x >= 10) return `${x.toFixed(1)}x`;
  return `${x.toFixed(2)}x`;
}

function callerHandle(call: { caller_username: string | null; caller_first_name: string | null }): string {
  if (call.caller_username) return `@${call.caller_username}`;
  if (call.caller_first_name) return call.caller_first_name;
  return 'anonymous seeker';
}

function ageStr(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Call alert (broadcast on approval)
// ─────────────────────────────────────────────────────────────────────────────

export function formatCallAlert(call: OracleCall): string {
  const handle = callerHandle(call);
  const ticker = call.ticker ? `$${call.ticker.toUpperCase()}` : 'TOKEN';
  const name = call.name ?? '';
  const fdv = fmtUsd(call.fdv_at_call);

  const dexLink = call.dexscreener_url
    ? `<a href="${esc(call.dexscreener_url)}">DEX</a>`
    : 'DEX';

  return [
    `𓂀 <b>TRANSMUTE ORACLE — Pantheon Call</b>`,
    `By ${esc(handle)} · ☿ PANTHEON`,
    '',
    `▣ <b>${esc(ticker)}</b>${name ? ` <i>${esc(name)}</i>` : ''} · 📦 Base · 📈 ${dexLink}`,
    `<code>${esc(call.contract_address)}</code>`,
    '',
    `🟢 <b>Called:</b> @${esc(fdv)} FDV`,
    '',
    `📜 <i>${esc(call.thesis)}</i>`,
    '',
    '━━━━━━━━━━━━━━━',
    '⚠️ <b>Sacred Warning</b>',
    '<i>This is observation, not prophecy. Always DYOR — NFA.</i>',
  ].join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// /gods leaderboard
// ─────────────────────────────────────────────────────────────────────────────

interface CallerStat {
  callerTelegramId: number;
  handle: string;
  callCount: number;
  avgMultiplier: number;
  bestMultiplier: number;
}

interface CallStat {
  call: OracleCall;
  multiplier: number;
}

function multiplier(call: OracleCall): number | null {
  if (!call.fdv_at_call || !call.ath_fdv) return null;
  if (call.fdv_at_call <= 0) return null;
  return call.ath_fdv / call.fdv_at_call;
}

function starRating(avgMult: number): string {
  if (avgMult >= 10) return '★★★★★';
  if (avgMult >= 5) return '★★★★';
  if (avgMult >= 2.5) return '★★★';
  if (avgMult >= 1.5) return '★★';
  if (avgMult >= 1) return '★';
  return '☆';
}

export interface PantheonStats {
  callCount: number;
  oldestApprovedAt: string | null;
  avgMultiplier: number;
  topThreeAvg: number;
  medianMultiplier: number;
  hit2xRate: number;
  hit5xRate: number;
  topCallers: CallerStat[];
  topCalls: CallStat[];
}

export function computePantheonStats(calls: OracleCall[]): PantheonStats {
  const stats: CallStat[] = calls
    .map((c) => ({ call: c, multiplier: multiplier(c) }))
    .filter((s): s is CallStat => s.multiplier !== null);

  const multipliers = stats.map((s) => s.multiplier);
  const callCount = calls.length;

  const sortedMultipliers = [...multipliers].sort((a, b) => a - b);
  const avgMultiplier =
    multipliers.length > 0 ? multipliers.reduce((a, b) => a + b, 0) / multipliers.length : 0;
  const medianMultiplier =
    sortedMultipliers.length === 0
      ? 0
      : sortedMultipliers[Math.floor(sortedMultipliers.length / 2)];

  const top3 = [...multipliers].sort((a, b) => b - a).slice(0, 3);
  const topThreeAvg = top3.length > 0 ? top3.reduce((a, b) => a + b, 0) / top3.length : 0;

  const hit2x = multipliers.filter((m) => m >= 2).length;
  const hit5x = multipliers.filter((m) => m >= 5).length;
  const total = multipliers.length || 1;

  // Group by caller
  const byCaller = new Map<number, { count: number; sum: number; best: number; handle: string }>();
  for (const { call, multiplier: m } of stats) {
    const handle = callerHandle(call);
    const key = call.caller_telegram_id;
    const cur = byCaller.get(key);
    if (cur) {
      cur.count += 1;
      cur.sum += m;
      cur.best = Math.max(cur.best, m);
    } else {
      byCaller.set(key, { count: 1, sum: m, best: m, handle });
    }
  }
  const topCallers: CallerStat[] = Array.from(byCaller.entries())
    .map(([id, v]) => ({
      callerTelegramId: id,
      handle: v.handle,
      callCount: v.count,
      avgMultiplier: v.sum / v.count,
      bestMultiplier: v.best,
    }))
    .sort((a, b) => b.avgMultiplier - a.avgMultiplier || b.bestMultiplier - a.bestMultiplier)
    .slice(0, 5);

  const topCalls = [...stats]
    .sort((a, b) => (b.multiplier ?? 0) - (a.multiplier ?? 0))
    .slice(0, 5);

  const oldestApprovedAt =
    calls.length === 0
      ? null
      : calls.reduce((acc, c) => (c.approved_at < acc ? c.approved_at : acc), calls[0].approved_at);

  return {
    callCount,
    oldestApprovedAt,
    avgMultiplier,
    topThreeAvg,
    medianMultiplier,
    hit2xRate: hit2x / total,
    hit5xRate: hit5x / total,
    topCallers,
    topCalls,
  };
}

const MEDAL_BY_RANK: Record<number, string> = { 0: '🥇', 1: '🥈', 2: '🥉' };

export function formatPantheonLeaderboard(opts: {
  calls: OracleCall[];
  windowLabel: string;
}): string {
  const stats = computePantheonStats(opts.calls);

  if (stats.callCount === 0) {
    return [
      `𓂀 <b>TRANSMUTE ORACLE — PANTHEON ${esc(opts.windowLabel)}</b>`,
      '',
      '<i>The temple is empty. No approved calls in this window yet.</i>',
      '',
      `Submit one with /callnow.`,
    ].join('\n');
  }

  const oldestLabel = stats.oldestApprovedAt ? ageStr(stats.oldestApprovedAt) : 'unknown';

  const headerLines = [
    `𓂀 <b>TRANSMUTE ORACLE — PANTHEON ${esc(opts.windowLabel)}</b>`,
    '',
    `🪙 Calls: <b>${stats.callCount}</b>  —  📅 Oldest: <b>${esc(oldestLabel)}</b>`,
    `💎 Avg ATH: <b>${fmtMultiplier(stats.avgMultiplier)}</b>  —  📈 Top 3: <b>${fmtMultiplier(stats.topThreeAvg)}</b>`,
    `〰 Median: <b>${fmtMultiplier(stats.medianMultiplier)}</b>`,
    `🎯 Hit 2x: <b>${(stats.hit2xRate * 100).toFixed(0)}%</b>  —  Hit 5x: <b>${(stats.hit5xRate * 100).toFixed(0)}%</b>`,
    '',
    '━━━━━━━━━━━━━━━',
    '🏆 <b>TOP CALLERS</b>',
  ];

  const callerLines = stats.topCallers.map((c, idx) => {
    const medal = MEDAL_BY_RANK[idx] ?? `${idx + 1}.`;
    return [
      `${medal} ${esc(c.handle)} ${starRating(c.avgMultiplier)}`,
      `   <i>${c.callCount} call${c.callCount !== 1 ? 's' : ''} — avg ${fmtMultiplier(c.avgMultiplier)} (best ${fmtMultiplier(c.bestMultiplier)})</i>`,
    ].join('\n');
  });

  const callsHeader = ['', '━━━━━━━━━━━━━━━', '🔥 <b>TOP CALLS</b>', ''];

  const callLines = stats.topCalls.map((s, idx) => {
    const medal = MEDAL_BY_RANK[idx] ?? `${idx + 1}.`;
    const ticker = s.call.ticker ? `$${s.call.ticker.toUpperCase()}` : 'TOKEN';
    const handle = callerHandle(s.call);
    return [
      `${medal} <b>${esc(ticker)}</b> by ${esc(handle)}`,
      `   <i>Called @ ${fmtUsd(s.call.fdv_at_call)} → ATH ${fmtUsd(s.call.ath_fdv)} (${fmtMultiplier(s.multiplier)})</i>`,
    ].join('\n');
  });

  const footer = [
    '',
    '━━━━━━━━━━━━━━━',
    '𓂀 <i>Signal before attention. Submit yours with /callnow.</i>',
  ];

  return [...headerLines, '', ...callerLines, ...callsHeader, ...callLines, ...footer].join('\n');
}

export function formatAdminReviewMessage(submission: {
  id: number;
  caller_username: string | null;
  caller_first_name: string | null;
  contract_address: string;
  ticker: string | null;
  name: string | null;
  thesis: string;
  fdv_at_submit: number | null;
  liquidity_at_submit: number | null;
}): string {
  const handle = callerHandle({
    caller_username: submission.caller_username,
    caller_first_name: submission.caller_first_name,
  });
  const ticker = submission.ticker ? `$${submission.ticker.toUpperCase()}` : '(no ticker)';
  return [
    `𓂀 <b>NEW CALL — Submission #${submission.id}</b>`,
    '',
    `From: <b>${esc(handle)}</b>`,
    `Token: <b>${esc(ticker)}</b>${submission.name ? ` <i>(${esc(submission.name)})</i>` : ''}`,
    `CA: <code>${esc(submission.contract_address)}</code>`,
    `FDV: <b>${fmtUsd(submission.fdv_at_submit)}</b>  —  Liquidity: <b>${fmtUsd(submission.liquidity_at_submit)}</b>`,
    '',
    `📜 <b>Thesis</b>`,
    `<i>${esc(submission.thesis)}</i>`,
    '',
    `<i>Approve to broadcast. Reject to discard.</i>`,
  ].join('\n');
}
