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

  const commandsRes = await fetch(
    `https://api.telegram.org/bot${token}/setMyCommands`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        commands: [
          { command: 'start',  description: 'Start main menu' },
          { command: 'invoke', description: 'Hunt hidden microcaps (<$600K FDV)' },
          { command: 'pulse',  description: 'Market daily report (macro, sentiment, flows)' },
          { command: 'myths',  description: 'Narrative tracker (rising stories)' },
          { command: 'pearls', description: 'Daily financial wisdom' },
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
