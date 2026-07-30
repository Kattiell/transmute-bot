/**
 * LLM client for the v4 pipeline — dual backend.
 *
 * VENICE (default): the bot's existing Grok route (OpenAI-compatible
 * /chat/completions with venice_parameters). Venice only exposes on/off
 * toggles for web + X search — no allowed_domains / allowed_x_handles /
 * from_date filters — so shard scoping is enforced as a SOURCE SCOPE block
 * inside the prompt. Weaker than an API-level filter, but the deterministic
 * Stage 1.5 gate downstream is what actually guarantees correctness.
 *
 * XAI (optional, preferred when XAI_API_KEY is set): xAI's /v1/responses
 * carries server-side web_search / x_search tools with hard filters — the
 * shard design of the spec (§1) maps onto it 1:1.
 *
 * Every call is timeout-bounded; schema failures get ONE repair retry, then
 * the caller drops the candidate fail-closed.
 */
import { z } from 'zod';

const XAI_BASE = process.env.XAI_BASE_URL || 'https://api.x.ai/v1';
const XAI_MODEL = process.env.XAI_MODEL || 'grok-4.5';

const VENICE_URL = `${process.env.VENICE_BASE_URL || 'https://api.venice.ai/api/v1'}/chat/completions`;
// Focused per-stage calls: default to the fast Grok route, not the multi-agent
// model the single-pass v3 uses (v4 makes many small calls, not one big one).
const VENICE_V4_MODEL = process.env.ORACLE_V4_VENICE_MODEL || process.env.VENICE_MODEL || 'grok-4-3';

export type WebSearchTool = {
  type: 'web_search';
  filters?: { allowed_domains?: string[]; excluded_domains?: string[] };
  enable_image_understanding?: boolean;
};
export type XSearchTool = {
  type: 'x_search';
  allowed_x_handles?: string[];
  excluded_x_handles?: string[];
  from_date?: string;
  to_date?: string;
  enable_image_understanding?: boolean;
  enable_video_understanding?: boolean;
};
export type Tool = WebSearchTool | XSearchTool;

type Backend = 'xai' | 'venice';

function backend(): Backend | null {
  if (process.env.XAI_API_KEY) return 'xai';
  if (process.env.VENICE_API_KEY) return 'venice';
  return null;
}

/** v4 runs on either backend; ORACLE_V4=off forces the v3 single-pass fallback. */
export function isOracleV4Enabled(): boolean {
  if (process.env.ORACLE_V4 === 'off') return false;
  return backend() !== null;
}

async function post(url: string, apiKey: string, body: unknown, timeoutMs: number): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`${url} ${res.status}: ${(await res.text()).slice(0, 400)}`);
    return (await res.json()) as Record<string, unknown>;
  } catch (err) {
    if (controller.signal.aborted) throw new Error(`${url} timed out after ${timeoutMs}ms`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function extractText(r: Record<string, unknown>): string {
  // xAI /v1/responses convenience field
  if (typeof r.output_text === 'string' && r.output_text.trim()) return r.output_text;
  // xAI /v1/responses block list
  if (Array.isArray(r.output)) {
    const texts: string[] = [];
    for (const block of r.output as Record<string, unknown>[]) {
      if (block.type === 'message' && Array.isArray(block.content)) {
        for (const c of block.content as Record<string, unknown>[]) {
          if (typeof c.text === 'string' && c.text.trim()) texts.push(c.text);
        }
      }
    }
    if (texts.length) return texts.join('\n');
  }
  // chat/completions (xAI and Venice)
  const choices = r.choices as Record<string, unknown>[] | undefined;
  const msg = choices?.[0]?.message as Record<string, unknown> | undefined;
  if (msg && typeof msg.content === 'string') return msg.content;
  return JSON.stringify(r);
}

function parseJsonBlock(s: string): unknown {
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenced ? fenced[1] : s.slice(s.indexOf('{'), s.lastIndexOf('}') + 1);
  return JSON.parse(raw);
}

/**
 * Venice has no API-level source filters, so the shard's tool spec is
 * translated into an explicit scope instruction the model must obey.
 * Stage 1.5 remains the hard guarantee either way.
 */
function toolsToScopeBlock(tools: Tool[]): string {
  const lines: string[] = [];
  for (const t of tools) {
    if (t.type === 'web_search' && t.filters?.allowed_domains?.length) {
      lines.push(
        `- Web research is RESTRICTED to these domains: ${t.filters.allowed_domains.join(', ')}. ` +
          'Discard anything found on any other domain.',
      );
    }
    if (t.type === 'x_search') {
      if (t.allowed_x_handles?.length) {
        lines.push(
          `- On X, only posts authored by these handles count as sources: ${t.allowed_x_handles
            .map((h) => '@' + h)
            .join(', ')}.`,
        );
      }
      if (t.from_date) {
        lines.push(`- Only use X posts dated on or after ${t.from_date} (UTC). Verify the post timestamp.`);
      }
    }
  }
  return lines.length ? `SOURCE SCOPE (mandatory)\n${lines.join('\n')}\n\n` : '';
}

function veniceSearchBody(prompt: string, tools: Tool[], temperature: number): unknown {
  const wantsWeb = tools.some((t) => t.type === 'web_search');
  const wantsX = tools.some((t) => t.type === 'x_search');
  return {
    model: VENICE_V4_MODEL,
    temperature,
    messages: [{ role: 'user', content: toolsToScopeBlock(tools) + prompt }],
    max_completion_tokens: 16000,
    venice_parameters: {
      enable_web_search: wantsWeb ? 'on' : 'off',
      enable_x_search: wantsX,
      enable_web_citations: true,
      strip_thinking_response: true,
    },
  };
}

/**
 * Tool-using call with zod validation + one repair retry. Returns null on any
 * terminal failure — callers treat null as fail-closed (candidate dropped or
 * stage skipped and reported in SCAN INTEGRITY), never as "assume fine".
 */
export async function grokSearch<T extends z.ZodTypeAny>(opts: {
  prompt: string;
  tools: Tool[];
  schema: T;
  temperature: number;
  timeoutMs: number;
  label: string;
}): Promise<z.infer<T> | null> {
  const be = backend();
  if (!be) return null;

  const jsonReminder =
    '\n\nReturn ONLY a single JSON object. No prose, no preamble, no markdown outside the JSON.';

  const call = async (extra?: string) => {
    if (be === 'xai') {
      const r = await post(
        `${XAI_BASE}/responses`,
        process.env.XAI_API_KEY as string,
        {
          model: XAI_MODEL,
          temperature: opts.temperature,
          tools: opts.tools,
          input: [{ role: 'user', content: opts.prompt + jsonReminder + (extra ?? '') }],
        },
        opts.timeoutMs,
      );
      return extractText(r);
    }
    const r = await post(
      VENICE_URL,
      process.env.VENICE_API_KEY as string,
      veniceSearchBody(opts.prompt + jsonReminder + (extra ?? ''), opts.tools, opts.temperature),
      opts.timeoutMs,
    );
    return extractText(r);
  };

  const start = Date.now();
  try {
    let text = await call();
    try {
      return opts.schema.parse(parseJsonBlock(text));
    } catch (e) {
      console.warn(`[oracle-v4] ${opts.label}: schema mismatch, repair retry`);
      text = await call(
        `\n\nYour previous output failed schema validation with: ${String(e).slice(0, 600)}\n` +
          'Emit corrected JSON only. Use null / "UNVERIFIABLE" rather than inventing values.',
      );
      return opts.schema.parse(parseJsonBlock(text));
    }
  } catch (err) {
    console.error(`[oracle-v4] ${opts.label} (${be}) failed after ${Date.now() - start}ms: ${(err as Error).message}`);
    return null;
  }
}

/**
 * Synthesis call with NO search enabled — the model cannot introduce new
 * facts at this stage by construction (spec §4b). On xAI that means no tools;
 * on Venice, web + X search are explicitly forced off.
 */
export async function grokSynthesize(prompt: string, temperature: number, timeoutMs: number): Promise<string | null> {
  const be = backend();
  if (!be) return null;
  try {
    if (be === 'xai') {
      const r = await post(
        `${XAI_BASE}/chat/completions`,
        process.env.XAI_API_KEY as string,
        { model: XAI_MODEL, temperature, messages: [{ role: 'user', content: prompt }] },
        timeoutMs,
      );
      return extractText(r);
    }
    const r = await post(
      VENICE_URL,
      process.env.VENICE_API_KEY as string,
      {
        model: VENICE_V4_MODEL,
        temperature,
        messages: [{ role: 'user', content: prompt }],
        max_completion_tokens: 16000,
        venice_parameters: {
          enable_web_search: 'off',
          enable_x_search: false,
          strip_thinking_response: true,
        },
      },
      timeoutMs,
    );
    return extractText(r);
  } catch (err) {
    console.error(`[oracle-v4] synthesis (${be}) failed: ${(err as Error).message}`);
    return null;
  }
}
