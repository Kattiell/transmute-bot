import type { VercelRequest, VercelResponse } from '@vercel/node';
import { cleanupExpired } from '../src/gate/db';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const secret = process.env.CRON_SECRET;
  const auth = req.headers['authorization'];
  const bearer = secret ? `Bearer ${secret}` : null;
  const vercelCron = req.headers['x-vercel-cron'];

  if (!vercelCron && (!secret || auth !== bearer)) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  try {
    const result = await cleanupExpired();
    console.log('[cron-cleanup]', result);
    return res.status(200).json({ ok: true, ...result });
  } catch (err) {
    console.error('[cron-cleanup] failed', err);
    return res.status(500).json({ ok: false, error: (err as Error).message });
  }
}
