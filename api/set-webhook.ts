import type { VercelRequest, VercelResponse } from '@vercel/node';

/**
 * GET /api/set-webhook?secret=YOUR_SECRET
 *
 * Call this once after deploying to register the webhook URL with Telegram.
 * Set WEBHOOK_SECRET env var to protect this endpoint.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    return res.status(500).json({ error: 'TELEGRAM_BOT_TOKEN not set' });
  }

  // Gate this endpoint behind WEBHOOK_SECRET so a stranger can't repoint
  // the webhook (DoS) or flush queued updates (?drop=1) on us. Vercel cron
  // jobs identify themselves with x-vercel-cron and are allowed through.
  const expected = process.env.WEBHOOK_SECRET;
  const provided = typeof req.query.secret === 'string' ? req.query.secret : '';
  const isVercelCron = !!req.headers['x-vercel-cron'];
  if (expected && !isVercelCron && provided !== expected) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  if (!expected) {
    console.warn('[set-webhook] WEBHOOK_SECRET not configured — endpoint is public.');
  }

  // Derive webhook URL from Vercel deployment
  const host = req.headers.host;
  const webhookUrl = `https://${host}/api/webhook`;

  // ?drop=1 flushes any stuck retries Telegram has queued
  const dropPendingUpdates = req.query.drop === '1' || req.query.drop === 'true';

  const response = await fetch(
    `https://api.telegram.org/bot${token}/setWebhook`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: webhookUrl,
        allowed_updates: ['message', 'callback_query'],
        max_connections: 40,
        drop_pending_updates: dropPendingUpdates,
      }),
    }
  );

  const commandsRes = await fetch(
    `https://api.telegram.org/bot${token}/setMyCommands`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        commands: [
          { command: 'start',   description: 'Start main menu' },
          { command: 'invoke',  description: 'Hunt hidden microcaps' },
          { command: 'oracle',  description: 'Reveal a token by its contract address' },
          { command: 'callnow', description: 'Submit a token call to the Pantheon' },
          { command: 'gods',    description: 'Pantheon leaderboard (/gods 7d|30d|all)' },
          { command: 'pulse',   description: 'Market daily report (macro, sentiment, flows)' },
          { command: 'myths',   description: 'Narrative tracker (rising stories)' },
          { command: 'pearls',  description: 'Daily financial wisdom' },
          { command: 'forge',   description: 'Launch a token via Bankr (admin)' },
          { command: 'optout',  description: 'Stop receiving Pantheon DMs' },
          { command: 'optin',   description: 'Re-enable Pantheon DMs' },
          { command: 'cancel',  description: 'Cancel an in-progress wizard' },
        ],
      }),
    }
  );

  const menuRes = await fetch(
    `https://api.telegram.org/bot${token}/setChatMenuButton`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        menu_button: { type: 'commands' },
      }),
    }
  );

  const data = await response.json();
  const commandsData = await commandsRes.json();
  const menuData = await menuRes.json();
  res.status(200).json({
    webhookUrl,
    telegram: data,
    commands: commandsData,
    menuButton: menuData,
  });
}
