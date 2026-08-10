import { ORACLE_PROMPT, ORACLE_RH_PROMPT } from './prompts';

// Venice.ai inference (OpenAI-compatible). Routes through Venice instead of
// xAI directly; the `grok-4-3` model keeps behavior (native web + X search)
// close to the original Grok path. Mirror of nous-app's src/lib/api/grok.ts.
const VENICE_API_URL = `${process.env.VENICE_BASE_URL || 'https://api.venice.ai/api/v1'}/chat/completions`;
const VENICE_MODEL = process.env.VENICE_MODEL || 'grok-4-3';
/**
 * PAID PATHS ONLY — /invoke, /invokeRH and /oracle (Horus) run on the strongest
 * GPT-5.5 the provider exposes. Mirror of nous-app's src/lib/api/grok.ts.
 * Costs ~$37.5/M in, ~$225/M out — hence the 1-per-wallet-per-day cap.
 *
 * TRADE-OFF: no native X/Twitter search on this family. The displayed @handle
 * is resolved deterministically from DEX/CoinGecko/GeckoTerminal token profiles
 * by the token-resolver, never from the model's text.
 */
const ORACLE_INVOKE_MODEL = process.env.VENICE_ORACLE_MODEL || 'openai-gpt-55-pro';
/**
 * gpt-5.5-pro accepts medium|high|xhigh. `high` is the default on purpose:
 * xhigh plus web search does not reliably finish inside the 270s Lambda
 * ceiling. Raise via env only if measured latency leaves room.
 */
const ORACLE_REASONING_EFFORT = process.env.VENICE_ORACLE_EFFORT || 'high';

/**
 * Venice exposes X/Twitter search only on the Grok family (`supportsXSearch`
 * in the model spec). Sending enable_x_search to GPT-5.5 is at best ignored
 * and at worst a 400.
 */
function supportsXSearch(model: string): boolean {
  return /^grok/i.test(model);
}

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
 * Single chokepoint for every LLM call from this bot. The bot's callers
 * (invokeOracle, invokeOracleRobinhood, invokeHorus, invokeOracleWithPrompt)
 * are all SOLO discovery / single-shot analysis paths. None of them
 * participate in council voting, so the security constitution that wrapped
 * this layer was producing REJECT/ABSTAIN silence on microcap discovery and
 * has been removed — the prompts are sent raw, exactly as authored.
 */
async function callGrok(prompt: string, model?: string, effort?: string): Promise<string> {
  const apiKey = process.env.VENICE_API_KEY;
  if (!apiKey) throw new Error('VENICE_API_KEY not configured');

  const resolvedModel = model || VENICE_MODEL;

  // Hard-cap the Venice call so a hung API request can't silently eat the whole
  // 300s Lambda budget. 270s leaves 30s for parsing + Telegram sends.
  const controller = new AbortController();
  const timeoutMs = 270_000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const start = Date.now();
  console.log(`[grok] call start model=${resolvedModel}`);

  try {
    const res = await fetch(VENICE_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: resolvedModel,
        messages: [{ role: 'user', content: prompt }],
        reasoning: { effort: effort || 'xhigh' },
        max_completion_tokens: 64000,
        // Native web search with citations. X/Twitter search rides along only
        // on models that expose it (Grok family) — see supportsXSearch.
        venice_parameters: {
          enable_web_search: 'on',
          ...(supportsXSearch(resolvedModel) ? { enable_x_search: true } : {}),
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
  return callGrok(ORACLE_PROMPT, ORACLE_INVOKE_MODEL, ORACLE_REASONING_EFFORT);
}

/** /invokeRH — same paid model as /invoke, pointed at Robinhood mainnet. */
export async function invokeOracleRobinhood(): Promise<string> {
  return callGrok(ORACLE_RH_PROMPT, ORACLE_INVOKE_MODEL, ORACLE_REASONING_EFFORT);
}

/**
 * /oracle (Horus CA revelation) — a PAID, per-wallet-capped path, so it runs on
 * the same strong model as /invoke rather than the cheap default. Takes the
 * caller's fully-built Horus prompt (the CA + DexScreener ground-truth block).
 */
export async function invokeHorus(prompt: string): Promise<string> {
  return callGrok(prompt, ORACLE_INVOKE_MODEL, ORACLE_REASONING_EFFORT);
}

/** Generic single-shot call on the cheap default model (non-paid paths). */
export async function invokeOracleWithPrompt(prompt: string): Promise<string> {
  return callGrok(prompt);
}
