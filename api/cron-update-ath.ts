/**
 * Cron job that updates ATH (all-time-high FDV) for active /callnow approved
 * calls. Runs every 30 minutes via Vercel cron — see vercel.json.
 *
 * For each active call within the last 30 days:
 *   1. Fetch fresh DexScreener snapshot.
 *   2. If snapshot.fdvUsd > stored ath_fdv, update the row.
 *   3. Always touch last_polled_at so the next run picks the staler rows first.
 *
 * Calls older than 30 days are deactivated (is_active = false) so the poller
 * doesn't waste DexScreener quota on dead signals.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import {
  deactivateCall,
  listActiveCallsToPoll,
  touchCallPollTime,
  updateCallAth,
} from '../src/oracle/calls';
import {
  deactivateTokenCallsOlderThan,
  listTokenCallsToPoll,
  raiseTokenCallAthByCa,
  touchTokenCallPollByCa,
} from '../src/oracle/tokencalls';
import { fetchDexScreenerSnapshot } from '../src/dexscreener';
import { fetchTokenSnapshot } from '../src/tokensnapshot';
import { chainByKey } from '../src/chains';

const MAX_AGE_DAYS = 30;
// Two poll pools share the run: Pantheon calls + group-detected token calls.
// 40+40 spaced 1s apart stays under DexScreener's ~60 req/min per-IP cap and
// inside the 240s maxDuration with latency headroom.
const POLL_BATCH = 40;
const TOKEN_POLL_BATCH = 40;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const secret = process.env.CRON_SECRET;
  const auth = req.headers['authorization'];
  const bearer = secret ? `Bearer ${secret}` : null;
  const vercelCron = req.headers['x-vercel-cron'];

  if (!vercelCron && (!secret || auth !== bearer)) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  try {
    const calls = await listActiveCallsToPoll(MAX_AGE_DAYS, POLL_BATCH);
    let polled = 0;
    let athsUpdated = 0;
    let deactivated = 0;
    const ageCutoff = Date.now() - MAX_AGE_DAYS * 86400_000;

    for (const call of calls) {
      polled += 1;

      if (new Date(call.approved_at).getTime() < ageCutoff) {
        await deactivateCall(call.id);
        deactivated += 1;
        continue;
      }

      const snap = await fetchDexScreenerSnapshot(call.contract_address);
      if (!snap) {
        await touchCallPollTime(call.id);
        // Pacing — DexScreener is generous but stay polite.
        await new Promise((r) => setTimeout(r, 1000));
        continue;
      }

      const newFdv = snap.fdvUsd ?? null;
      const currentAth = call.ath_fdv ?? 0;
      if (newFdv !== null && newFdv > currentAth) {
        await updateCallAth({
          id: call.id,
          newAthFdv: newFdv,
          newAthPriceUsd: snap.priceUsd,
        });
        athsUpdated += 1;
      } else {
        await touchCallPollTime(call.id);
      }

      await new Promise((r) => setTimeout(r, 1000));
    }

    // Group-detected token calls (auto CA cards + /flex). The same CA may be
    // tracked by many chats — dedupe so one DexScreener fetch updates all rows.
    const tokenDeactivated = await deactivateTokenCallsOlderThan(MAX_AGE_DAYS);
    const tokenCalls = await listTokenCallsToPoll(MAX_AGE_DAYS, TOKEN_POLL_BATCH);
    const uniqueCas = [...new Set(tokenCalls.map((c) => c.contract_address))];
    // Poll each CA on the network it was called on — robinhood rows go through
    // the GeckoTerminal fallback when DexScreener doesn't index the pool.
    const chainKeyByCa = new Map<string, string>();
    for (const c of tokenCalls) {
      if (!chainKeyByCa.has(c.contract_address)) chainKeyByCa.set(c.contract_address, c.chain);
    }
    let tokenPolled = 0;
    let tokenAthsUpdated = 0;

    for (const ca of uniqueCas) {
      tokenPolled += 1;
      const snap = await fetchTokenSnapshot(ca, [chainByKey(chainKeyByCa.get(ca))])
        .then((r) => r?.snapshot ?? null)
        .catch(() => null);
      if (snap?.fdvUsd != null) {
        const hasNewHigh = tokenCalls.some(
          (c) => c.contract_address === ca && snap.fdvUsd! > (c.ath_fdv ?? 0),
        );
        if (hasNewHigh) {
          await raiseTokenCallAthByCa({
            contractAddress: ca,
            newAthFdv: snap.fdvUsd,
            newAthPriceUsd: snap.priceUsd,
          });
          tokenAthsUpdated += 1;
        }
      }
      await touchTokenCallPollByCa(ca);
      await new Promise((r) => setTimeout(r, 1000));
    }

    console.log('[cron-update-ath]', {
      polled,
      athsUpdated,
      deactivated,
      tokenPolled,
      tokenAthsUpdated,
      tokenDeactivated,
    });
    return res.status(200).json({
      ok: true,
      polled,
      athsUpdated,
      deactivated,
      tokenPolled,
      tokenAthsUpdated,
      tokenDeactivated,
    });
  } catch (err) {
    console.error('[cron-update-ath] failed', err);
    return res.status(500).json({ ok: false, error: (err as Error).message });
  }
}
