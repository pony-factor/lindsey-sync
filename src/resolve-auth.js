import { createHash, createPublicKey, verify } from 'node:crypto';
import { createAppJwt, githubRequest, GitHubHttpError } from './bot.js';

const proofLifetime = 60;

export function createResolverAuthorizer(config, { request = githubRequest, now = Date.now } = {}) {
  const normalize = value => value.replace(/\\n/g, '\n');
  const keys = [createPublicKey(normalize(config.privateKey))];
  if (config.resolvePublicKey) keys.push(createPublicKey(normalize(config.resolvePublicKey)));
  const used = new Map();

  return async (method, headers, body) => {
    const app = headers['x-lindsey-app'];
    const repository = headers['x-lindsey-repository'];
    const time = headers['x-lindsey-time'];
    const nonce = headers['x-lindsey-nonce'];
    const proof = headers['x-lindsey-proof'];
    const seconds = Math.floor(now() / 1000);
    if (app !== config.appId || !/^[\w.-]+\/[\w.-]+$/.test(repository || '') ||
        repository.split('/').some(part => part === '.' || part === '..') ||
        !/^\d{10}$/.test(time || '') || Math.abs(seconds - Number(time)) > proofLifetime ||
        !/^[a-f0-9-]{36}$/.test(nonce || '') || !/^[\w-]{100,1024}$/.test(proof || '')) return false;

    const digest = createHash('sha256').update(body).digest('hex');
    const signed = Buffer.from(['lindsey-resolver-v1', method, app, repository, time, nonce, digest].join('\n'));
    if (!keys.some(key => verify('RSA-SHA256', signed, key, Buffer.from(proof, 'base64url')))) return false;

    for (const [id, expires] of used) if (expires < seconds) used.delete(id);
    if (used.has(nonce) || used.size >= 4096) return false;
    used.set(nonce, Number(time) + proofLifetime);
    try {
      const { data } = await request(`/repos/${repository}/installation`,
        createAppJwt(config.appId, config.privateKey), { redirect: 'error', signal: AbortSignal.timeout(15000) });
      return Number.isSafeInteger(data?.id) && String(data.app_id) === config.appId && !data.suspended_at;
    } catch (error) {
      if (error instanceof GitHubHttpError && error.status === 404) return false;
      throw new Error('GitHub could not verify the Lindsey repository installation.');
    }
  };
}
