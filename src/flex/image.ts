/**
 * Flexcard PNG renderer for /flex.
 *
 * Strategy: compose an SVG (template art as background + dynamic call data as
 * crisp vector text) and rasterize it with @resvg/resvg-js. Text rendered this
 * way is always sharp and never garbled — unlike asking an image model to
 * paint typography. Venice AI's job is generating the 5 background templates
 * offline (scripts/generate-flex-templates.ts), not compositing at runtime.
 *
 * Fonts are bundled in assets/fonts (Chakra Petch, OFL license) and loaded
 * explicitly with loadSystemFonts: false — Vercel lambdas ship no usable
 * system fonts, so relying on them would render tofu in production.
 */

import * as fs from 'fs';
import * as path from 'path';
import { Resvg } from '@resvg/resvg-js';

export const FLEX_WIDTH = 1280;
export const FLEX_HEIGHT = 720;

export interface FlexCardData {
  /** Token ticker or short name shown in the headline, e.g. "FOLD". */
  ticker: string;
  fdvAtCall: number | null;
  reachedFdv: number | null;
  multiplier: number | null;
  /** e.g. "18d ago" */
  ageLabel: string;
  /** e.g. "@Chainrirffss" */
  caller: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Asset resolution — works from repo root (tsx/dev), dist/ (tsc build) and
// /var/task (Vercel lambda with includeFiles: assets/**).
// ─────────────────────────────────────────────────────────────────────────────

function findAssetsDir(): string | null {
  const candidates = [
    path.join(process.cwd(), 'assets'),
    path.join(__dirname, '..', '..', 'assets'),
    path.join(__dirname, '..', '..', '..', 'assets'),
  ];
  for (const dir of candidates) {
    try {
      if (fs.statSync(dir).isDirectory()) return dir;
    } catch {
      // keep looking
    }
  }
  return null;
}

function listFontFiles(): string[] {
  const assets = findAssetsDir();
  if (!assets) return [];
  const dir = path.join(assets, 'fonts');
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => /\.(ttf|otf)$/i.test(f))
      .map((f) => path.join(dir, f));
  } catch {
    return [];
  }
}

function listTemplateFiles(): string[] {
  const assets = findAssetsDir();
  if (!assets) return [];
  const dir = path.join(assets, 'flex-templates');
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => /\.(png|jpe?g)$/i.test(f))
      .map((f) => path.join(dir, f));
  } catch {
    return [];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Text safety — everything here ends up inside SVG markup
// ─────────────────────────────────────────────────────────────────────────────

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Keep only glyphs the bundled font actually has (printable Latin). Emoji or
 * exotic unicode in token names would render as tofu boxes in the card.
 */
function displaySafe(s: string, maxLen: number, fallback: string): string {
  const cleaned = s
    .replace(/[^\x20-\x7E]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLen);
  return cleaned.length > 0 ? cleaned : fallback;
}

/** "54.5K" / "1.23M" — flexcard numbers, no $ sign (matches the reference art). */
export function fmtNum(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '???';
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toFixed(0);
}

function fmtMult(x: number | null): string {
  if (x === null || !Number.isFinite(x)) return '?x';
  if (x >= 100) return `${x.toFixed(0)}x`;
  if (x >= 10) return `${x.toFixed(1)}x`;
  return `${x.toFixed(2)}x`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Backgrounds
// ─────────────────────────────────────────────────────────────────────────────

interface Palette {
  base: string;
  glowA: string;
  glowB: string;
  grid: string;
}

// Five procedural fallback palettes, used until Venice templates exist in
// assets/flex-templates. Each renders a distinct dark cyber-esoteric mood.
const PALETTES: Palette[] = [
  { base: '#07070d', glowA: '#3b0764', glowB: '#155e75', grid: '#a78bfa' }, // violet/teal
  { base: '#050a08', glowA: '#14532d', glowB: '#713f12', grid: '#4ade80' }, // emerald/amber
  { base: '#0a0610', glowA: '#701a75', glowB: '#1e1b4b', grid: '#e879f9' }, // fuchsia/indigo
  { base: '#0a0808', glowA: '#7f1d1d', glowB: '#78350f', grid: '#fb923c' }, // ember
  { base: '#04080f', glowA: '#0c4a6e', glowB: '#312e81', grid: '#38bdf8' }, // abyss blue
];

function proceduralBackground(variant: number): string {
  const p = PALETTES[Math.abs(variant) % PALETTES.length];
  const gridLines: string[] = [];
  for (let x = 0; x <= FLEX_WIDTH; x += 80) {
    gridLines.push(
      `<line x1="${x}" y1="0" x2="${x}" y2="${FLEX_HEIGHT}" stroke="${p.grid}" stroke-opacity="0.06" stroke-width="1"/>`,
    );
  }
  for (let y = 0; y <= FLEX_HEIGHT; y += 80) {
    gridLines.push(
      `<line x1="0" y1="${y}" x2="${FLEX_WIDTH}" y2="${y}" stroke="${p.grid}" stroke-opacity="0.06" stroke-width="1"/>`,
    );
  }
  return `
    <rect width="${FLEX_WIDTH}" height="${FLEX_HEIGHT}" fill="${p.base}"/>
    <circle cx="1020" cy="160" r="420" fill="${p.glowA}" fill-opacity="0.45" filter="url(#blurBig)"/>
    <circle cx="220" cy="640" r="380" fill="${p.glowB}" fill-opacity="0.40" filter="url(#blurBig)"/>
    ${gridLines.join('\n')}
    <circle cx="1060" cy="360" r="210" fill="none" stroke="${p.grid}" stroke-opacity="0.18" stroke-width="2"/>
    <circle cx="1060" cy="360" r="160" fill="none" stroke="${p.grid}" stroke-opacity="0.12" stroke-width="1.5"/>
    <polygon points="1060,212 1188,434 932,434" fill="none" stroke="${p.grid}" stroke-opacity="0.15" stroke-width="2"/>
  `;
}

function templateBackground(file: string): string {
  const ext = path.extname(file).toLowerCase();
  const mime = ext === '.png' ? 'image/png' : 'image/jpeg';
  const b64 = fs.readFileSync(file).toString('base64');
  return `<image href="data:${mime};base64,${b64}" x="0" y="0" width="${FLEX_WIDTH}" height="${FLEX_HEIGHT}" preserveAspectRatio="xMidYMid slice"/>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Renderer
// ─────────────────────────────────────────────────────────────────────────────

export async function renderFlexCard(data: FlexCardData): Promise<Buffer> {
  const ticker = xmlEscape(displaySafe(data.ticker.toUpperCase(), 14, 'TOKEN'));
  const caller = xmlEscape(displaySafe(data.caller, 26, 'anonymous'));
  const ageLabel = xmlEscape(displaySafe(data.ageLabel, 16, 'now'));
  const callFdv = xmlEscape(fmtNum(data.fdvAtCall));
  const reached = xmlEscape(fmtNum(data.reachedFdv));
  const mult = xmlEscape(fmtMult(data.multiplier));

  // Long multipliers ("1420x") shrink so they never collide with the headline.
  const multSize = mult.length <= 5 ? 200 : mult.length <= 7 ? 160 : 124;

  const templates = listTemplateFiles();
  const variant = Math.floor(Math.random() * Math.max(templates.length, PALETTES.length));
  const background =
    templates.length > 0
      ? templateBackground(templates[variant % templates.length])
      : proceduralBackground(variant);

  const svg = `<svg width="${FLEX_WIDTH}" height="${FLEX_HEIGHT}" viewBox="0 0 ${FLEX_WIDTH} ${FLEX_HEIGHT}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <filter id="blurBig" x="-80%" y="-80%" width="260%" height="260%">
      <feGaussianBlur stdDeviation="90"/>
    </filter>
    <filter id="glow" x="-60%" y="-60%" width="220%" height="220%">
      <feGaussianBlur stdDeviation="16" result="b"/>
      <feMerge>
        <feMergeNode in="b"/>
        <feMergeNode in="SourceGraphic"/>
      </feMerge>
    </filter>
    <filter id="textShadow" x="-30%" y="-30%" width="160%" height="160%">
      <feDropShadow dx="0" dy="3" stdDeviation="6" flood-color="#000000" flood-opacity="0.85"/>
    </filter>
    <linearGradient id="scrim" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#000000" stop-opacity="0.78"/>
      <stop offset="0.55" stop-color="#000000" stop-opacity="0.38"/>
      <stop offset="1" stop-color="#000000" stop-opacity="0.08"/>
    </linearGradient>
    <linearGradient id="bottomScrim" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#000000" stop-opacity="0"/>
      <stop offset="1" stop-color="#000000" stop-opacity="0.7"/>
    </linearGradient>
  </defs>

  ${background}

  <rect width="${FLEX_WIDTH}" height="${FLEX_HEIGHT}" fill="url(#scrim)"/>
  <rect y="${FLEX_HEIGHT - 200}" width="${FLEX_WIDTH}" height="200" fill="url(#bottomScrim)"/>
  <rect x="0" y="0" width="${FLEX_WIDTH}" height="6" fill="#a3e635" fill-opacity="0.9"/>

  <text x="72" y="150" font-family="Chakra Petch" font-weight="600" font-size="64"
        fill="#ffffff" filter="url(#textShadow)">${ticker} @ ${callFdv}</text>
  <text x="72" y="212" font-family="Chakra Petch" font-weight="500" font-size="36"
        fill="#cbd5e1" filter="url(#textShadow)">${ageLabel} · ${caller}</text>

  <text x="72" y="480" font-family="Chakra Petch" font-weight="700" font-size="${multSize}"
        fill="#a3e635" filter="url(#glow)">${mult}</text>

  <text x="72" y="612" font-family="Chakra Petch" font-weight="600" font-size="48"
        fill="#fde68a" filter="url(#textShadow)">Reached ${reached}</text>

  <text x="${FLEX_WIDTH - 64}" y="${FLEX_HEIGHT - 48}" text-anchor="end"
        font-family="Chakra Petch" font-weight="500" font-size="28" letter-spacing="6"
        fill="#d4af37" fill-opacity="0.95" filter="url(#textShadow)">TRANSMUTE ORACLE</text>
</svg>`;

  const fontFiles = listFontFiles();
  const resvg = new Resvg(svg, {
    background: '#07070d',
    fitTo: { mode: 'width', value: FLEX_WIDTH },
    font:
      fontFiles.length > 0
        ? {
            fontFiles,
            loadSystemFonts: false,
            defaultFontFamily: 'Chakra Petch',
          }
        : {
            // Dev fallback only — production must bundle assets/fonts.
            loadSystemFonts: true,
          },
  });
  return resvg.render().asPng();
}
