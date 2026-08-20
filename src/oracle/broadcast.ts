/**
 * Client for the site's systemic-broadcast endpoint.
 *
 * `/invoke` in Telegram does NOT run its own hunt. It triggers the SAME
 * broadcast the operator's button on the site triggers, and then polls for the
 * result. That matters for more than tidiness: the daily cap and the
 * concurrency guard live on the site, so a second local implementation would
 * carry its own counter and the operator could double-spend simply by switching
 * surface. One hunt, one counter, two doors.
 *
 * Authorization is decided entirely by the site (see
 * /api/internal/oracle/broadcast): the bot forwards the Telegram id that
 * Telegram itself stamped on the update, and the site checks it against the
 * wallet link. The bot holds no allowlist of its own to drift out of sync.
 */

/**
 * Where the Transmute App lives. NOT `ARENA_BOT_INTERNAL_URL` — that one points
 * the other way (it is how the site reaches THIS bot). Falls back to the link
 * base URL, which already has to point at the site for /link to work.
 */
const BASE_URL = (process.env.SITE_BASE_URL || process.env.GATE_LINK_BASE_URL || '').replace(/\/+$/, '');

/**
 * The shared bot↔site secret. Reuses ARENA_BOT_INTERNAL_SECRET, which both
 * deployments already hold and keep in sync for the arena push channel — a
 * third secret would only be one more thing to rotate in two places.
 */
const SECRET = process.env.ARENA_BOT_INTERNAL_SECRET || process.env.CRON_SECRET;

export interface BroadcastProject {
  number?: number;
  ticker?: string;
  name?: string;
  ca?: string | null;
  network?: 'base' | 'robinhood';
  potential?: number | null;
  risk?: number | null;
  summary?: string;
  signals?: string;
  fullText?: string;
  resolution?: unknown;
}

export type StartResult =
  | { ok: true; pendingId: string }
  | { ok: false; code: 'not_operator' | 'limit_reached' | 'pending_in_progress' | 'not_configured' | 'unauthorized' | 'error'; message?: string };

export type PollResult =
  | { status: 'pending' }
  | { status: 'done'; projects: BroadcastProject[] }
  | { status: 'failed'; message?: string }
  | { status: 'unreachable' };

function endpoint(): string | null {
  if (!BASE_URL || !SECRET) return null;
  return `${BASE_URL}/api/internal/oracle/broadcast`;
}

/** True when the bot has everything it needs to reach the site. */
export function isBroadcastConfigured(): boolean {
  return endpoint() !== null;
}

export async function startBroadcast(telegramId: number): Promise<StartResult> {
  const url = endpoint();
  if (!url) return { ok: false, code: 'not_configured' };

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-internal-secret': SECRET! },
      body: JSON.stringify({ telegramId }),
    });
  } catch (err) {
    console.error('[broadcast] start failed', err);
    return { ok: false, code: 'error' };
  }

  const data = (await res.json().catch(() => ({}))) as {
    pending_id?: string;
    error?: string;
    message?: string;
  };

  if (res.status === 202 && data.pending_id) {
    return { ok: true, pendingId: data.pending_id };
  }

  const code = data.error;
  if (code === 'not_operator' || code === 'limit_reached' || code === 'pending_in_progress' || code === 'not_configured' || code === 'unauthorized') {
    return { ok: false, code, message: data.message };
  }
  console.error('[broadcast] unexpected start response', res.status, data);
  return { ok: false, code: 'error' };
}

/**
 * Is this Telegram account the operator?
 *
 * Used ONLY to decide whether to show /invoke in that user's command menu —
 * never as an authorization gate. The real gate is server-side on every
 * broadcast request, so a wrong answer here costs a menu entry, not access.
 *
 * Returns false on any failure: a missing command is a far better failure than
 * a command dangled at someone who cannot use it.
 */
export async function isOperator(telegramId: number): Promise<boolean> {
  const url = endpoint();
  if (!url) return false;
  try {
    // Hard 2.5s cap: /start blocks on this, and a slow app must never make the
    // bot look dead. Timing out means the user gets the ordinary menu, which is
    // the correct degraded state.
    const res = await fetch(`${url}?telegramId=${encodeURIComponent(String(telegramId))}`, {
      headers: { 'x-internal-secret': SECRET! },
      signal: AbortSignal.timeout(2_500),
    });
    if (!res.ok) return false;
    const data = (await res.json()) as { isOperator?: boolean };
    return !!data.isOperator;
  } catch {
    return false;
  }
}

export async function pollBroadcast(pendingId: string): Promise<PollResult> {
  const url = endpoint();
  if (!url) return { status: 'unreachable' };

  let res: Response;
  try {
    res = await fetch(`${url}?id=${encodeURIComponent(pendingId)}`, {
      headers: { 'x-internal-secret': SECRET! },
    });
  } catch {
    // Transient — the caller keeps polling rather than declaring failure on one
    // dropped request.
    return { status: 'pending' };
  }

  if (!res.ok) return { status: 'pending' };

  const data = (await res.json().catch(() => ({}))) as {
    status?: string;
    projects?: BroadcastProject[];
    error_message?: string;
  };

  if (data.status === 'done') return { status: 'done', projects: data.projects ?? [] };
  if (data.status === 'failed') return { status: 'failed', message: data.error_message };
  return { status: 'pending' };
}
