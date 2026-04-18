import { ORACLE_PROMPT } from './prompts';

const GROK_API_URL = 'https://api.x.ai/v1/responses';

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

async function callGrok(prompt: string): Promise<string> {
  const apiKey = process.env.GROK_API_KEY;
  if (!apiKey) throw new Error('GROK_API_KEY not configured');

  const res = await fetch(GROK_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'grok-4.20-reasoning',
      input: prompt,
      tools: [{ type: 'web_search' }],
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Grok API error ${res.status}: ${body}`);
  }

  const data = (await res.json()) as Record<string, unknown>;
  return extractTextFromGrokResponse(data);
}

export async function invokeOracle(): Promise<string> {
  return callGrok(ORACLE_PROMPT);
}

export async function invokeOracleWithPrompt(prompt: string): Promise<string> {
  return callGrok(prompt);
}
