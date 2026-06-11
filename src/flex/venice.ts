/**
 * Minimal Venice AI image-generation client.
 *
 * Docs: https://docs.venice.ai/api-reference/endpoint/image/generate
 *   POST https://api.venice.ai/api/v1/image/generate
 *   Authorization: Bearer <VENICE_API_KEY>   (https://venice.ai/settings/api)
 *   → { id, images: [base64...], timing }
 *
 * Used OFFLINE by scripts/generate-flex-templates.ts to create the 5 flexcard
 * background templates. It is deliberately NOT called at runtime per /flex:
 *   1. Image models garble overlaid typography — the flex numbers must be
 *      crisp, so text is composited as vectors in src/flex/image.ts.
 *   2. No user-controlled text ever reaches the Venice prompt (prompt
 *      injection surface stays closed).
 *   3. /flex stays fast and free of per-call inference cost.
 */

const VENICE_API_BASE = process.env.VENICE_API_BASE || 'https://api.venice.ai/api/v1';
const DEFAULT_MODEL = process.env.VENICE_IMAGE_MODEL || 'venice-sd35';
const TIMEOUT_MS = 120_000;

export class VeniceError extends Error {
  constructor(
    public status: number,
    public body: string,
  ) {
    super(`Venice API error ${status}: ${body.slice(0, 300)}`);
    this.name = 'VeniceError';
  }
}

export interface VeniceImageRequest {
  prompt: string;
  negativePrompt?: string;
  width?: number;
  height?: number;
  model?: string;
  seed?: number;
}

export async function generateVeniceImage(req: VeniceImageRequest): Promise<Buffer> {
  const apiKey = process.env.VENICE_API_KEY;
  if (!apiKey) throw new Error('VENICE_API_KEY is not set');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(`${VENICE_API_BASE}/image/generate`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: req.model ?? DEFAULT_MODEL,
        prompt: req.prompt,
        negative_prompt: req.negativePrompt,
        width: req.width ?? 1280,
        height: req.height ?? 720,
        format: 'png',
        safe_mode: true,
        seed: req.seed,
      }),
    });

    if (!res.ok) {
      throw new VeniceError(res.status, await res.text().catch(() => ''));
    }

    const data = (await res.json()) as { images?: string[] };
    const b64 = data.images?.[0];
    if (!b64) throw new VeniceError(502, 'Venice returned no images');

    // Defensive: some APIs prefix data URIs; Venice documents raw base64.
    const raw = b64.replace(/^data:image\/\w+;base64,/, '');
    return Buffer.from(raw, 'base64');
  } finally {
    clearTimeout(timer);
  }
}
