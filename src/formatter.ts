import type { ParsedProject } from './types';
import { extractField, extractConviction } from './parser';

/** Escape HTML special chars */
function esc(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Escape HTML then convert markdown (bold/italic/code/headings/lists) to Telegram HTML */
function escAndFormat(text: string): string {
  let out = esc(text);

  // Fenced code blocks ```lang\n...\n```
  out = out.replace(/```[a-zA-Z0-9_+-]*\n?([\s\S]*?)```/g, (_m, body: string) => `<pre>${body.replace(/\n+$/, '')}</pre>`);

  // Inline code `...`
  out = out.replace(/`([^`\n]+)`/g, '<code>$1</code>');

  // Bold-italic ***text*** -> <b><i>text</i></b>  (must run before ** and *)
  out = out.replace(/\*\*\*([\s\S]+?)\*\*\*/g, '<b><i>$1</i></b>');

  // Bold **text** — lazy, cross-line
  out = out.replace(/\*\*([\s\S]+?)\*\*/g, '<b>$1</b>');

  // Bold __text__ (Grok sometimes emits this)
  out = out.replace(/__([\s\S]+?)__/g, '<b>$1</b>');

  // Italic *text* — lazy, single line, require non-space boundaries so we don't eat lone asterisks
  out = out.replace(/(^|[^*])\*(?!\s)([^*\n]+?)(?<!\s)\*(?!\*)/g, '$1<i>$2</i>');

  // Italic _text_ — single-line, word-ish boundaries
  out = out.replace(/(^|[^_\w])_(?!\s)([^_\n]+?)(?<!\s)_(?!\w)/g, '$1<i>$2</i>');

  // Markdown headings "# ...", "## ..." -> bold line
  out = out.replace(/^\s{0,3}#{1,6}\s+(.+)$/gm, '<b>$1</b>');

  // Markdown bullets "- " / "* " at start of line -> "• "
  out = out.replace(/^\s{0,3}[-*]\s+/gm, '• ');

  // Strip leftover stray double-asterisks that didn't pair up, to avoid literal ** in output
  out = out.replace(/\*\*+/g, '');

  return out;
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

  let msg = '';

  // Header
  msg += `🔮 <b>Signal ${project.number} — ${esc(project.ticker)}</b>\n`;
  msg += `📌 <i>${esc(project.name)}</i>\n`;
  msg += '━━━━━━━━━━━━━━━\n\n';

  // Judgment box — always first, visual
  if (project.potential !== null || project.risk !== null || project.probability) {
    msg += `📊 <b>JUDGMENT</b>\n`;
    if (project.potential !== null) msg += `   Potential  <b>${project.potential}/10</b>  ${potentialBar(project.potential)}\n`;
    if (project.risk !== null) msg += `   Risk           <b>${project.risk}/10</b>  ${riskEmoji(project.risk)}\n`;
    if (project.probability) msg += `   10x Prob   <b>${esc(project.probability)}</b>\n`;
    if (conviction) msg += `   Conviction <b>${esc(conviction)}</b> ${convictionEmoji(conviction)}\n`;
    msg += '\n';
  }

  // Market data
  if (fdv || mcap || liq || vol) {
    msg += `💰 <b>MARKET DATA</b>\n`;
    if (fdv) msg += `   FDV: ${esc(fdv)}\n`;
    if (mcap) msg += `   MCap: ${esc(mcap)}\n`;
    if (liq) msg += `   Liquidity: ${esc(liq)}\n`;
    if (vol) msg += `   24h Vol: ${esc(vol)}\n`;
    msg += '\n';
  }

  // Thesis
  if (project.summary) {
    msg += `📜 <b>THESIS</b>\n${escAndFormat(project.summary)}\n\n`;
  }

  // Signals
  if (project.signals) {
    msg += `📡 <b>ON-CHAIN + SOCIAL</b>\n${escAndFormat(project.signals)}\n\n`;
  }

  // Risks
  if (risks) {
    msg += `⚠️ <b>RISKS</b>\n${escAndFormat(risks)}\n\n`;
  }

  // Links
  const links: string[] = [];
  if (ca) links.push(`📋 <code>${esc(ca)}</code>`);
  if (dexLink) links.push(`📈 <a href="${esc(dexLink)}">DexScreener</a>`);
  if (projectX) {
    const handle = projectX.replace(/^@/, '');
    links.push(`🐦 <a href="https://x.com/${esc(handle)}">@${esc(handle)}</a>`);
  }
  if (creatorX) {
    const handle = creatorX.replace(/^@/, '');
    links.push(`👤 <a href="https://x.com/${esc(handle)}">@${esc(handle)}</a>`);
  }
  if (links.length > 0) {
    msg += `🔗 <b>LINKS</b>\n` + links.join('\n') + '\n\n';
  }

  // Teaching
  if (teaching) {
    msg += `💡 <b>INSIGHT</b>\n<i>${escAndFormat(teaching)}</i>\n`;
  }

  return msg.trim();
}

export function formatWhispersReport(projects: ParsedProject[]): string[] {
  const messages: string[] = [];

  // Header
  let header = '𓂀 <b>TRANSMUTE ORACLE</b>\n';
  header += '<b>Hidden Microcaps — Base Chain</b>\n';
  header += `<i>${new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' })}</i>\n\n`;
  header += `Found <b>${projects.length}</b> signal${projects.length !== 1 ? 's' : ''} below $600K FDV`;
  messages.push(header);

  // Each card as a separate message
  for (const project of projects) {
    messages.push(formatProjectCard(project));
  }

  // Footer
  messages.push(
    '━━━━━━━━━━━━━━━\n' +
    '⚠️ <b>Sacred Warning</b>\n' +
    '<i>This is observation, not prophecy. Always DYOR - NFA.</i>\n\n' +
    '𓂀 <i>Transmute Oracle — Signal before attention</i>'
  );

  return messages;
}

/** Format generic reports (pulse, myths, pearls) with markdown-to-HTML conversion */
export function formatGenericReport(title: string, raw: string): string[] {
  const messages: string[] = [];

  let header = `𓂀 <b>${esc(title)}</b>\n`;
  header += `<i>${new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' })}</i>\n`;
  header += '━━━━━━━━━━━━━━━\n\n';

  // Convert markdown to HTML, then build content
  const formatted = escAndFormat(raw);
  const content = header + formatted;

  // Split into chunks respecting Telegram 4096 char limit
  const maxLen = 3900;
  let remaining = content;

  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      messages.push(remaining);
      break;
    }

    let breakIdx = remaining.lastIndexOf('\n', maxLen);
    if (breakIdx < maxLen * 0.5) breakIdx = maxLen;

    messages.push(remaining.slice(0, breakIdx));
    remaining = remaining.slice(breakIdx).trim();
  }

  messages.push(
    '━━━━━━━━━━━━━━━\n' +
    '⚠️ <b>Sacred Warning</b>\n' +
    '<i>This is observation, not prophecy. Always DYOR - NFA.</i>\n\n' +
    '𓂀 <i>Transmute Oracle</i>'
  );

  return messages;
}
