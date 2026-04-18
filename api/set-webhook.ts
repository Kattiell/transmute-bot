import type { VercelRequest, VercelResponse } from '@vercel/node';

/**
 * GET /api/set-webhook?secret=YOUR_SECRET
 *
 * Call this once after deploying to register the webhook URL with Telegram.
 * Set WEBHOOK_SECRET env var to protect this endpoint.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  const secret = req.query.secret as string;
  if (secret !== process.env.WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    return res.status(500).json({ error: 'TELEGRAM_BOT_TOKEN not set' });
  }

  // Derive webhook URL from Vercel deployment
  const host = req.headers.host;
  const webhookUrl = `https://${host}/api/webhook`;

  const response = await fetch(
    `https://api.telegram.org/bot${token}/setWebhook`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: webhookUrl,
        allowed_updates: ['message'],
        max_connections: 10,
      }),
    }
  );

  const data = await response.json();
  res.status(200).json({ webhookUrl, telegram: data });
}
