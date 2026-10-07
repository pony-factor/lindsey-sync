import { createServer } from 'node:http';

import {
  handleReviewRequested,
  matchesReviewRequest,
  verifyWebhookSignature
} from './bot.js';

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function configFromEnv() {
  const reviewerLogin = process.env.CODEX_REVIEWER_LOGIN?.trim() || '';
  const reviewerTeam = process.env.CODEX_REVIEWER_TEAM?.trim() || '';
  if (!reviewerLogin && !reviewerTeam) {
    throw new Error('Set CODEX_REVIEWER_LOGIN or CODEX_REVIEWER_TEAM');
  }

  return {
    appId: requiredEnv('GITHUB_APP_ID'),
    privateKey: requiredEnv('GITHUB_PRIVATE_KEY'),
    webhookSecret: requiredEnv('GITHUB_WEBHOOK_SECRET'),
    reviewerLogin,
    reviewerTeam
  };
}

function readBody(req, maxBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;

    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error('Webhook payload is too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
}

const config = configFromEnv();
const host = process.env.HOST?.trim() || '0.0.0.0';
const port = Number(process.env.PORT || 8788);

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('PORT must be a valid TCP port');
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'GET' && url.pathname === '/health') {
    sendJson(res, 200, { ok: true, server: 'lindsey-sync' });
    return;
  }

  if (req.method !== 'POST' || url.pathname !== '/webhook') {
    res.writeHead(404).end();
    return;
  }

  try {
    const rawBody = await readBody(req);
    if (
      !verifyWebhookSignature(
        config.webhookSecret,
        rawBody,
        req.headers['x-hub-signature-256']
      )
    ) {
      res.writeHead(401).end('Invalid webhook signature');
      return;
    }

    const event = req.headers['x-github-event'];
    const payload = JSON.parse(rawBody.toString('utf8'));

    if (event !== 'pull_request' || !matchesReviewRequest(payload, config)) {
      sendJson(res, 200, { ok: true, result: 'ignored' });
      return;
    }

    const result = await handleReviewRequested(payload, config);
    sendJson(res, 200, { ok: true, result });
  } catch (error) {
    console.error(error);
    sendJson(res, 500, {
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    });
  }
});

server.listen(port, host, () => {
  console.error(`Lindsey Sync listening on http://${host}:${port}`);
});

const shutdown = () => server.close();
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
