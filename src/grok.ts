import { ORACLE_PROMPT } from './prompts';

// Venice.ai inference (OpenAI-compatible). Routes through Venice instead of
// xAI directly; the `grok-4-3` model keeps behavior (native web + X search)
// close to the original Grok path. Mirror of nous-app's src/lib/api/grok.ts.
const VENICE_API_URL = `${process.env.VENICE_BASE_URL || 'https://api.venice.ai/api/v1'}/chat/completions`;
const VENICE_MODEL = process.env.VENICE_MODEL || 'grok-4-3';
// /invoke uses grok-4-20 (native realtime X search for @ verification), scoped
// separately from VENICE_MODEL (mirror of nous-app).
const ORACLE_INVOKE_MODEL = process.env.VENICE_ORACLE_MODEL || 'grok-4-20';

function extractTextFromGrokResponse(data: Record<string, unknown>): string {
  const texts: string[] = [];

  // Strategy 1: Responses API format
  if (data.output && Array.isArray(data.output)) {
    for (const block of data.output) {
      const b = block as Record<string, unknown>;
      if (b.type === 'message' && Array.isArray(b.content)) {
        for (const c of b.content as Record<string, unknown>[]) {
          if (typeof c.text === 'string' && c.text.trim()) texts.push(c.text);
        }
      }
      if (typeof b.text === 'string' && b.text.trim()) texts.push(b.text);
      if (typeof b.content === 'string' && b.content.trim()) texts.push(b.content);
    }
  }

  // Strategy 2: Chat Completions format
  if (texts.length === 0 && data.choices && Array.isArray(data.choices)) {
    for (const choice of data.choices as Record<string, unknown>[]) {
      const msg = choice.message as Record<string, unknown> | undefined;
      if (msg && typeof msg.content === 'string') texts.push(msg.content);
    }
  }

  // Strategy 3 & 4: Direct fields
  if (texts.length === 0 && typeof data.content === 'string') texts.push(data.content);
  if (texts.length === 0 && typeof data.text === 'string') texts.push(data.text);

  if (texts.length > 0) return texts.join('\n\n');

  console.error('[grok] Could not extract text. Keys:', Object.keys(data));
  return JSON.stringify(data, null, 2);
}

/**
 * Single chokepoint for every Grok call from this bot. The bot's callers
 * (invokeOracle, invokeOracleWithPrompt — Oracle /invoke, Pulse, Myths,
 * Pearls, Horus CA analysis) are all SOLO discovery / single-shot analysis
 * paths. None of them participate in council voting, so the security
 * constitution that wrapped this layer was producing REJECT/ABSTAIN
 * silence on microcap discovery and has been removed — the prompts are
 * sent raw, exactly as the caller authored them.
 */
async function callGrok(prompt: string, model?: string): Promise<string> {
  const apiKey = process.env.VENICE_API_KEY;
  if (!apiKey) throw new Error('VENICE_API_KEY not configured');

  // Hard-cap the Venice call so a hung API request can't silently eat the whole
  // 300s Lambda budget. 270s leaves 30s for parsing + Telegram sends.
  const controller = new AbortController();
  const timeoutMs = 270_000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const start = Date.now();
  console.log('[grok] call start');

  try {
    const res = await fetch(VENICE_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: model || VENICE_MODEL,
        messages: [{ role: 'user', content: prompt }],
        // Max reasoning effort (xhigh — deep thinking). /invoke uses fast
        // grok-4-20 with scraping off, so xhigh fits the timeout budget.
        reasoning: { effort: 'xhigh' },
        max_completion_tokens: 40000,
        // Mirrors Grok's always-on web_search via Venice's native web + X search.
        venice_parameters: {
          enable_web_search: 'on',
          enable_x_search: true,
          enable_web_citations: true,
          // Reasoning stays ON, but strip the model's <think> blocks from the
          // response so the parser only sees the final structured output.
          strip_thinking_response: true,
        },
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Venice API error ${res.status}: ${body}`);
    }

    const data = (await res.json()) as Record<string, unknown>;
    const elapsed = Date.now() - start;
    console.log(`[grok] call ok in ${elapsed}ms`);
    return extractTextFromGrokResponse(data);
  } catch (err) {
    const elapsed = Date.now() - start;
    if (controller.signal.aborted) {
      console.error(`[grok] call timed out after ${elapsed}ms`);
      throw new Error(`Venice API timed out after ${timeoutMs / 1000}s`);
    }
    console.error(`[grok] call failed in ${elapsed}ms`, err);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export async function invokeOracle(): Promise<string> {
  return callGrok(ORACLE_PROMPT, ORACLE_INVOKE_MODEL);
}

export async function invokeOracleWithPrompt(prompt: string): Promise<string> {
  return callGrok(prompt);
}
