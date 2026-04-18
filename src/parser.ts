import type { ParsedProject } from './types';

function stripBold(text: string): string {
  return text.replace(/\*{1,2}([^*]+)\*{1,2}/g, '$1');
}

function extractTicker(raw: string): string {
  const text = stripBold(raw);

  const tickerField = text.match(/^[\s]*ticker\s*[:=]\s*\$?([A-Z0-9]{1,10})/im);
  if (tickerField) return `$${tickerField[1].toUpperCase()}`;

  const nameTickerLine = text.match(/name\s*\+?\s*ticker\s*[:=]\s*[^($\n]*[\(]?\$?([A-Z][A-Z0-9]{1,10})\)?/i);
  if (nameTickerLine) return `$${nameTickerLine[1].toUpperCase()}`;

  const dollarMatch = raw.match(/\$([A-Z][A-Z0-9]{1,10})/);
  if (dollarMatch) return `$${dollarMatch[1]}`;

  const nameMatch = text.match(/(?:name|project)\s*[:=]\s*([A-Za-z0-9]+)/i);
  if (nameMatch) return nameMatch[1].toUpperCase();

  return 'UNKNOWN';
}

function extractName(raw: string): string {
  const text = stripBold(raw);

  const nameOnly = text.match(/^[\s]*name\s*[:=]\s*([^\n($]+)/im);
  if (nameOnly) {
    const name = nameOnly[1].replace(/\$[A-Z0-9]+/gi, '').trim();
    if (name.length > 0 && name.length < 80) return name;
  }

  const nameTickerMatch = text.match(/name\s*\+?\s*ticker\s*[:=]\s*([^\n(]+)/i);
  if (nameTickerMatch) {
    const name = nameTickerMatch[1].replace(/\$[A-Z0-9]+/gi, '').replace(/\(.*\)/, '').trim();
    if (name.length > 0) return name;
  }

  const lines = text.split('\n').filter((l) => l.trim());
  for (const line of lines.slice(0, 5)) {
    const cleaned = line.replace(/^𓂀\s*(?:signal|project)\s*\d+\s*/i, '').replace(/^\d+\s*[.:)\-]\s*/, '').trim();
    if (cleaned.length > 2 && cleaned.length < 80 && !/^(contract|CA\s*[:=]|project\s*@|creator|current|FDV|thesis|narrative|on.chain|oracular|judgment|potential|risk|10x)/i.test(cleaned)) {
      return cleaned.replace(/\$[A-Z0-9]+/gi, '').replace(/\(.*\)/, '').trim() || cleaned;
    }
  }

  return 'Project';
}

function extractSummary(raw: string): string {
  const stripped = stripBold(raw);

  const thesisMatch = stripped.match(/thesis\s*[:=]\s*([\s\S]+?)(?:\n\n|\n[-]?\s*narrative|\n[-]?\s*creator|\n[-]?\s*on.chain)/i);
  if (thesisMatch) {
    const rawMatch = raw.match(/thesis\s*[:=]\s*([\s\S]+?)(?:\n\n|\n[-]?\s*narrative|\n[-]?\s*creator|\n[-]?\s*on.chain)/i);
    const thesis = (rawMatch || thesisMatch)[1].trim().replace(/\n/g, ' ');
    return thesis.length > 200 ? thesis.slice(0, 197) + '...' : thesis;
  }

  const oracularMatch = stripped.match(/oracular\s*analysis\s*[:=]?\s*([\s\S]+?)(?:\n\n|\n[-]?\s*judgment)/i);
  if (oracularMatch) {
    const rawMatch = raw.match(/oracular\s*analysis\s*[:=]?\s*([\s\S]+?)(?:\n\n|\n[-]?\s*judgment)/i);
    const analysis = (rawMatch || oracularMatch)[1].trim().replace(/\n/g, ' ');
    return analysis.length > 200 ? analysis.slice(0, 197) + '...' : analysis;
  }

  const lines = raw.split('\n').filter((l) => l.trim() && !l.match(/^(𓂀|name|ticker|contract|@|CA|FDV|project\s*@|creator\s*@)/i));
  const paragraph = lines.slice(0, 3).join(' ').trim();
  return paragraph.length > 200 ? paragraph.slice(0, 197) + '...' : paragraph;
}

function extractSignals(raw: string): string {
  const stripped = stripBold(raw);
  const match = stripped.match(/on.chain\s*\+?\s*(?:social|x)\s*signals?\s*[:=]?\s*([\s\S]+?)(?:\n\n|\n📈|\njudgment|\nrisks?\s*[:=]|\n𓂀|\nteaching|\nwallet\s*intelligence)/i);
  if (match) {
    const rawMatch = raw.match(/on.chain\s*\+?\s*(?:social|x)\s*signals?\s*[:=]?\s*([\s\S]+?)(?:\n\n|\n📈|\njudgment|\nrisks?\s*[:=]|\n𓂀|\nteaching|\nwallet\s*intelligence)/i);
    const signals = (rawMatch || match)[1].trim().replace(/\n/g, ' ');
    return signals.length > 300 ? signals.slice(0, 297) + '...' : signals;
  }
  return '';
}

function extractPotential(raw: string): number | null {
  const text = stripBold(raw);
  const match = text.match(/potential\s*(?:\([\d\s–\-\/]+\))?\s*[:=]\s*(\d{1,2})\s*(?:\/\s*10)?/i);
  return match ? parseInt(match[1]) : null;
}

function extractRisk(raw: string): number | null {
  const text = stripBold(raw);
  const match = text.match(/risk\s*(?:\([\d\s–\-\/]+\))?\s*[:=]\s*(\d{1,2})\s*(?:\/\s*10)?/i);
  return match ? parseInt(match[1]) : null;
}

function extractProbability(raw: string): string {
  const text = stripBold(raw);
  const match = text.match(/10x\s*probability\s*[^:\n]*[:=]\s*(\d{1,3}\s*%)/i);
  return match ? match[1].trim() : '';
}

function extractConviction(raw: string): string {
  const text = stripBold(raw);
  const match = text.match(/conviction\s*[:=]\s*(low|medium|high)/i);
  return match ? match[1] : '';
}

function extractField(raw: string, fieldName: string): string {
  const text = stripBold(raw);
  const regex = new RegExp(`${fieldName}\\s*[:=]\\s*([^\\n]+)`, 'i');
  const match = text.match(regex);
  return match ? match[1].trim() : '';
}

/**
 * Try to split raw text using a list of regex patterns.
 * Returns the split that yields the most sections (>1).
 * NOTE: ---+ is intentionally excluded because Grok uses --- between
 * sub-sections within each token, causing too many false splits.
 */
function bestSplit(raw: string): string[] {
  const patterns = [
    /🟦\s*SIGNAL\s*/i,                              // 🟦 SIGNAL N
    /𓂀\s*\*{0,2}\s*(?:Signal|Project)\s*/i,         // 𓂀 Signal/Project N
    /SIGNAL\s+\d+\s*☿?/i,                            // SIGNAL 1 ☿
    /━{5,}/,                                          // ━━━━━ horizontal rule
    /#{2,3}\s*(?:Signal|Project|Token)\s*/i,          // ## Signal N
    /\*{2}(?:Signal|Project|Token)\s+\d+\*{2}/i,     // **Signal 1**
  ];

  let best: string[] = [raw];
  for (const pattern of patterns) {
    const parts = raw.split(pattern);
    if (parts.length > best.length) {
      best = parts;
    }
  }
  return best;
}

function parseSection(text: string, num: number): ParsedProject | null {
  const cleaned = text.replace(/^\d+\s*\*{0,2}\s*☿?\s*/, '').trim();
  if (!cleaned || cleaned.length < 30) return null;
  if (/no\s+verified|could\s+not\s+find|unable\s+to\s+verify/i.test(cleaned)) return null;

  const ticker = extractTicker(cleaned);
  if (ticker === 'UNKNOWN') return null;

  return {
    number: num,
    ticker,
    name: extractName(cleaned),
    summary: extractSummary(cleaned),
    signals: extractSignals(cleaned),
    potential: extractPotential(cleaned),
    risk: extractRisk(cleaned),
    probability: extractProbability(cleaned),
    fullText: cleaned,
  };
}

export function parseOracleOutput(raw: string): ParsedProject[] {
  console.log(`[parser] Raw length: ${raw.length}`);
  console.log(`[parser] Raw preview: ${raw.slice(0, 300)}`);

  const projects: ParsedProject[] = [];
  const seenTickers = new Set<string>();

  // Strategy 1: Split by best matching delimiter
  const parts = bestSplit(raw);
  console.log(`[parser] Best split: ${parts.length} parts`);

  for (let i = 1; i < parts.length && projects.length < 5; i++) {
    const project = parseSection(parts[i].trim(), i);
    if (!project) {
      console.log(`[parser] Part ${i}: skipped`);
      continue;
    }
    if (seenTickers.has(project.ticker.toUpperCase())) continue;
    seenTickers.add(project.ticker.toUpperCase());
    projects.push({ ...project, number: projects.length + 1 });
    console.log(`[parser] Part ${i}: OK -> ${project.ticker}`);
  }

  // Strategy 2: Brute-force — find all $TICKER occurrences
  if (projects.length === 0 && raw.length > 100) {
    console.log(`[parser] Split failed, trying brute-force ticker scan...`);

    const tickerRegex = /\$([A-Z][A-Z0-9]{1,10})/g;
    const allTickers: { ticker: string; index: number }[] = [];
    let match;
    while ((match = tickerRegex.exec(raw)) !== null) {
      const t = `$${match[1]}`;
      if (!allTickers.some((x) => x.ticker === t)) {
        allTickers.push({ ticker: t, index: match.index });
      }
    }

    console.log(`[parser] Found ${allTickers.length} unique tickers: ${allTickers.map((t) => t.ticker).join(', ')}`);

    for (const { ticker, index } of allTickers) {
      if (projects.length >= 5) break;
      if (seenTickers.has(ticker.toUpperCase())) continue;

      // Grab ~1500 chars around the ticker mention as context
      const start = Math.max(0, index - 200);
      const end = Math.min(raw.length, index + 1300);
      const context = raw.slice(start, end);

      // Verify this context has meaningful project data (not just a mention)
      if (extractPotential(context) === null && extractRisk(context) === null) {
        console.log(`[parser] Brute-force: ${ticker} skipped (no scores)`);
        continue;
      }

      seenTickers.add(ticker.toUpperCase());
      projects.push({
        number: projects.length + 1,
        ticker,
        name: extractName(context),
        summary: extractSummary(context),
        signals: extractSignals(context),
        potential: extractPotential(context),
        risk: extractRisk(context),
        probability: extractProbability(context),
        fullText: context.trim(),
      });
      console.log(`[parser] Brute-force: OK -> ${ticker}`);
    }
  }

  // Strategy 3: Even more relaxed — accept tickers without scores
  if (projects.length === 0 && raw.length > 100) {
    console.log(`[parser] Trying relaxed brute-force (no score requirement)...`);

    const tickerRegex = /\$([A-Z][A-Z0-9]{1,10})/g;
    const allTickers: { ticker: string; index: number }[] = [];
    let match;
    while ((match = tickerRegex.exec(raw)) !== null) {
      const t = `$${match[1]}`;
      if (!allTickers.some((x) => x.ticker === t)) {
        allTickers.push({ ticker: t, index: match.index });
      }
    }

    for (const { ticker, index } of allTickers) {
      if (projects.length >= 5) break;
      if (seenTickers.has(ticker.toUpperCase())) continue;

      const start = Math.max(0, index - 200);
      const end = Math.min(raw.length, index + 1300);
      const context = raw.slice(start, end);

      // At minimum, need a Name or Thesis field
      const hasContent = /(?:name|thesis|narrative|oracular)\s*[:=]/i.test(context);
      if (!hasContent) continue;

      seenTickers.add(ticker.toUpperCase());
      projects.push({
        number: projects.length + 1,
        ticker,
        name: extractName(context),
        summary: extractSummary(context),
        signals: extractSignals(context),
        potential: extractPotential(context),
        risk: extractRisk(context),
        probability: extractProbability(context),
        fullText: context.trim(),
      });
      console.log(`[parser] Relaxed: OK -> ${ticker}`);
    }
  }

  console.log(`[parser] Final result: ${projects.length} projects`);
  return projects;
}

export { extractField, extractConviction };
