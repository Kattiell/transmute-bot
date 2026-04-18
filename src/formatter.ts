import type { ParsedProject } from './types';
import { extractField, extractConviction } from './parser';

function esc(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function riskEmoji(risk: number | null): string {
  if (risk === null) return '';
  if (risk <= 3) return '🟢';
  if (risk <= 6) return '🟡';
  return '🔴';
}

function potentialBar(potential: number | null): string {
  if (potential === null) return '';
  const filled = Math.min(potential, 10);
  return '▰'.repeat(filled) + '▱'.repeat(10 - filled);
}

function convictionEmoji(conviction: string): string {
  const c = conviction.toLowerCase();
  if (c === 'high') return '🔥';
  if (c === 'medium') return '⚡';
  return '💤';
}

export function formatProjectCard(project: ParsedProject): string {
  const conviction = extractConviction(project.fullText);
  const ca = extractField(project.fullText, 'contract address \\(ca\\)') || extractField(project.fullText, 'contract address') || extractField(project.fullText, 'CA');
  const dexLink = extractField(project.fullText, 'dexscreener link') || extractField(project.fullText, 'dexscreener');
  const projectX = extractField(project.fullText, 'project x') || extractField(project.fullText, 'project x \\(@\\)');
  const creatorX = extractField(project.fullText, 'creator x') || extractField(project.fullText, 'creator x \\(@\\)');
  const fdv = extractField(project.fullText, 'FDV \\(USD\\)') || extractField(project.fullText, 'FDV');
  const mcap = extractField(project.fullText, 'market cap \\(USD\\)') || extractField(project.fullText, 'market cap');
  const liq = extractField(project.fullText, 'liquidity \\(USD\\)') || extractField(project.fullText, 'liquidity');
  const vol = extractField(project.fullText, '24h volume \\(USD\\)') || extractField(project.fullText, '24h volume');
  const risks = extractField(project.fullText, 'risks');
  const teaching = extractField(project.fullText, 'teaching') || extractField(project.fullText, 'teaching \\(signal extraction insight\\)');

  let msg = `<b>𓂀 Signal ${project.number} — ${esc(project.ticker)}</b>\n`;
  msg += `<i>${esc(project.name)}</i>\n\n`;

  // Metrics row
  if (project.potential !== null || project.risk !== null || project.probability) {
    msg += `<b>Judgment</b>\n`;
    if (project.potential !== null) msg += `  Potential: <b>${project.potential}/10</b> ${potentialBar(project.potential)}\n`;
    if (project.risk !== null) msg += `  Risk: <b>${project.risk}/10</b> ${riskEmoji(project.risk)}\n`;
    if (project.probability) msg += `  10x Prob: <b>${esc(project.probability)}</b>\n`;
    if (conviction) msg += `  Conviction: <b>${esc(conviction)}</b> ${convictionEmoji(conviction)}\n`;
    msg += '\n';
  }

  // On-chain data
  if (fdv || mcap || liq || vol) {
    msg += `<b>Market Data</b>\n`;
    if (fdv) msg += `  FDV: ${esc(fdv)}\n`;
    if (mcap) msg += `  MCap: ${esc(mcap)}\n`;
    if (liq) msg += `  Liquidity: ${esc(liq)}\n`;
    if (vol) msg += `  24h Vol: ${esc(vol)}\n`;
    msg += '\n';
  }

  // Thesis / Summary
  if (project.summary) {
    msg += `<b>Thesis</b>\n${esc(project.summary)}\n\n`;
  }

  // Signals
  if (project.signals) {
    msg += `<b>On-chain + Social</b>\n${esc(project.signals)}\n\n`;
  }

  // Risks
  if (risks) {
    msg += `<b>Risks</b>\n${esc(risks)}\n\n`;
  }

  // Links
  const links: string[] = [];
  if (ca) links.push(`<code>${esc(ca)}</code>`);
  if (dexLink) links.push(`<a href="${esc(dexLink)}">DexScreener</a>`);
  if (projectX) {
    const handle = projectX.replace(/^@/, '');
    links.push(`<a href="https://x.com/${esc(handle)}">@${esc(handle)}</a>`);
  }
  if (creatorX) {
    const handle = creatorX.replace(/^@/, '');
    links.push(`Creator: <a href="https://x.com/${esc(handle)}">@${esc(handle)}</a>`);
  }
  if (links.length > 0) {
    msg += links.join(' | ') + '\n\n';
  }

  // Teaching
  if (teaching) {
    msg += `<b>💡 Insight:</b> <i>${esc(teaching)}</i>\n`;
  }

  msg += '━━━━━━━━━━━━━━━';

  return msg;
}

export function formatWhispersReport(projects: ParsedProject[]): string[] {
  const messages: string[] = [];

  // Header message
  let header = '<b>𓂀 TRANSMUTE ORACLE</b>\n';
  header += '<b>Hidden Microcaps — Base Chain</b>\n';
  header += `<i>${new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' })}</i>\n\n`;
  header += `Found <b>${projects.length}</b> signal${projects.length !== 1 ? 's' : ''} below $600K FDV\n`;
  header += '━━━━━━━━━━━━━━━';
  messages.push(header);

  // Each card as a separate message (Telegram has 4096 char limit)
  for (const project of projects) {
    messages.push(formatProjectCard(project));
  }

  // Footer
  let footer = '\n<b>⚠️ Sacred Warning</b>\n';
  footer += '<i>This is observation, not prophecy. Always DYOR - NFA.</i>\n\n';
  footer += '𓂀 <i>Transmute Oracle — Signal before attention</i>';
  messages.push(footer);

  return messages;
}

export function formatPulseReport(raw: string): string[] {
  const messages: string[] = [];
  const lines = raw.split('\n');
  let current = '';

  for (const line of lines) {
    const escaped = esc(line);
    if (current.length + escaped.length + 1 > 3800) {
      messages.push(current.trim());
      current = '';
    }
    current += escaped + '\n';
  }

  if (current.trim()) messages.push(current.trim());

  return messages;
}

export function formatGenericReport(title: string, raw: string): string[] {
  const messages: string[] = [];

  let header = `<b>𓂀 ${esc(title)}</b>\n`;
  header += `<i>${new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' })}</i>\n`;
  header += '━━━━━━━━━━━━━━━\n\n';

  const content = header + esc(raw);

  // Split into chunks respecting Telegram 4096 limit
  const maxLen = 3900;
  let remaining = content;

  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      messages.push(remaining);
      break;
    }

    // Find a good break point (newline)
    let breakIdx = remaining.lastIndexOf('\n', maxLen);
    if (breakIdx < maxLen * 0.5) breakIdx = maxLen;

    messages.push(remaining.slice(0, breakIdx));
    remaining = remaining.slice(breakIdx).trim();
  }

  messages.push('\n<b>⚠️ Sacred Warning</b>\n<i>This is observation, not prophecy. Always DYOR - NFA.</i>\n\n𓂀 <i>Transmute Oracle</i>');

  return messages;
}
