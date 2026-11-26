import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import test from 'node:test';
import { createResolverAuthorizer } from '../src/resolve-auth.js';

test('resolver verifies signed request bytes and the named installation', async () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const now = 1782000000000;
  let checks = 0;
  const authorize = createResolverAuthorizer({ appId: '42', privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }) }, {
    now: () => now,
    request: async path => {
      checks++;
      assert.equal(path, '/repos/owner/repo/installation');
      return { data: { id: 1, app_id: 42, suspended_at: checks > 1 ? '2026-06-01' : null } };
    }
  });
  const body = Buffer.from('{"files":[]}');
  const headers = (time = String(now / 1000)) => {
    const nonce = randomUUID(), digest = createHash('sha256').update(body).digest('hex');
    const input = ['lindsey-resolver-v1', 'POST', '42', 'owner/repo', time, nonce, digest].join('\n');
    return { 'x-lindsey-app': '42', 'x-lindsey-repository': 'owner/repo', 'x-lindsey-time': time,
      'x-lindsey-nonce': nonce, 'x-lindsey-proof': sign('RSA-SHA256', Buffer.from(input), privateKey).toString('base64url') };
  };
  const proof = headers();
  assert.equal(await authorize('GET', proof, body), false);
  assert.equal(await authorize('POST', proof, Buffer.from('modified')), false);
  assert.equal(await authorize('POST', { ...proof, 'x-lindsey-repository': 'owner/other' }, body), false);
  assert.equal(await authorize('POST', headers(String(now / 1000 - 61)), body), false);
  assert.equal(await authorize('POST', proof, body), true);
  assert.equal(await authorize('POST', proof, body), false);
  assert.equal(checks, 1);
  assert.equal(await authorize('POST', headers(), body), false, 'The signed repo installation is suspended');
});
