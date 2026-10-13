import { createHmac, createSign, timingSafeEqual } from 'node:crypto';

const API_VERSION = '2026-03-10';
const USER_AGENT = 'pony-factor-lindsey-sync/0.1.0';
const tokenCache = new Map();

export class GitHubHttpError extends Error {
  constructor(status, data) {
    const detail =
      typeof data === 'object' && data?.message
        ? data.message
        : String(data ?? 'GitHub request failed');
    super(`GitHub ${status}: ${detail}`);
    this.name = 'GitHubHttpError';
    this.status = status;
    this.data = data;
  }
}

function required(value, name) {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`${name} is required`);
  return normalized;
}

function normalizePrivateKey(value) {
  return required(value, 'GITHUB_PRIVATE_KEY').replace(/\\n/g, '\n');
}

function base64url(value) {
  return Buffer.from(value).toString('base64url');
}

export function createAppJwt(appId, privateKey, nowSeconds = Math.floor(Date.now() / 1000)) {
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64url(
    JSON.stringify({
      iat: nowSeconds - 60,
      exp: nowSeconds + 9 * 60,
      iss: required(String(appId), 'GITHUB_APP_ID')
    })
  );
  const unsigned = `${header}.${payload}`;
  const signer = createSign('RSA-SHA256');
  signer.update(unsigned);
  signer.end();
  const signature = signer.sign(normalizePrivateKey(privateKey)).toString('base64url');
  return `${unsigned}.${signature}`;
}

export function signWebhook(secret, rawBody) {
  return `sha256=${createHmac('sha256', required(secret, 'GITHUB_WEBHOOK_SECRET'))
    .update(rawBody)
    .digest('hex')}`;
}

export function verifyWebhookSignature(secret, rawBody, signatureHeader) {
  if (!signatureHeader) return false;
  const expected = Buffer.from(signWebhook(secret, rawBody));
  const actual = Buffer.from(signatureHeader);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function sameIdentity(left, right) {
  return Boolean(left && right && left.toLowerCase() === right.toLowerCase());
}

export function matchesReviewRequest(payload, { reviewerLogin = '', reviewerTeam = '' } = {}) {
  if (payload?.action !== 'review_requested' || !payload?.pull_request) return false;

  const requestedLogin = payload.requested_reviewer?.login || '';
  const requestedTeam = payload.requested_team?.slug || '';

  return (
    (reviewerLogin && sameIdentity(requestedLogin, reviewerLogin)) ||
    (reviewerTeam && sameIdentity(requestedTeam, reviewerTeam))
  );
}

export function isMergeConflict(pull) {
  return pull?.mergeable === false || pull?.mergeable_state === 'dirty';
}

export function conflictMarker(pull) {
  return `<!-- lindsey-sync:sync-conflict:${pull.base.sha}:${pull.head.sha} -->`;
}

export function conflictComment(pull) {
  return `${conflictMarker(pull)}
I can't sync this branch to \`main\` because it currently conflicts with \`main\`. No changes were made.`;
}

async function parseResponse(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function githubRequest(path, token, init = {}) {
  const response = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': API_VERSION,
      'User-Agent': USER_AGENT,
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers ?? {})
    }
  });

  const data = await parseResponse(response);
  if (!response.ok) throw new GitHubHttpError(response.status, data);
  return { status: response.status, data };
}

async function getInstallationToken(installationId, config) {
  const cached = tokenCache.get(installationId);
  const now = Date.now();
  if (cached && cached.expiresAt - 60_000 > now) return cached.token;

  const jwt = createAppJwt(config.appId, config.privateKey);
  const response = await githubRequest(
    `/app/installations/${encodeURIComponent(installationId)}/access_tokens`,
    jwt,
    { method: 'POST' }
  );

  const token = required(response.data?.token, 'installation token');
  const expiresAt = Date.parse(response.data?.expires_at || '');
  tokenCache.set(installationId, {
    token,
    expiresAt: Number.isFinite(expiresAt) ? expiresAt : now + 50 * 60_000
  });
  return token;
}

function repoPath(owner, repo) {
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
}

async function getPull(token, owner, repo, number) {
  return (await githubRequest(`${repoPath(owner, repo)}/pulls/${number}`, token)).data;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getPullWithMergeability(token, owner, repo, number) {
  let pull = await getPull(token, owner, repo, number);

  for (let attempt = 0; attempt < 4 && pull.mergeable === null; attempt += 1) {
    await delay(350);
    pull = await getPull(token, owner, repo, number);
  }

  return pull;
}

async function commentOnConflict(token, owner, repo, number, pull) {
  const marker = conflictMarker(pull);
  const comments = (
    await githubRequest(
      `${repoPath(owner, repo)}/issues/${number}/comments?per_page=100`,
      token
    )
  ).data;

  if (Array.isArray(comments) && comments.some((comment) => comment?.body?.includes(marker))) {
    return 'conflict-already-commented';
  }

  await githubRequest(`${repoPath(owner, repo)}/issues/${number}/comments`, token, {
    method: 'POST',
    body: JSON.stringify({ body: conflictComment(pull) })
  });
  return 'conflict-commented';
}

async function compareBaseAndHead(token, owner, repo, pull) {
  const base = encodeURIComponent(pull.base.sha);
  const head = encodeURIComponent(pull.head.sha);
  return (
    await githubRequest(`${repoPath(owner, repo)}/compare/${base}...${head}`, token)
  ).data;
}

function updateErrorLooksLikeConflict(error) {
  if (!(error instanceof GitHubHttpError) || error.status !== 422) return false;
  const message =
    typeof error.data === 'object' && error.data?.message
      ? error.data.message
      : String(error.data ?? '');
  return /conflict|cannot be merged|not mergeable/i.test(message);
}

function updateErrorLooksUpToDate(error) {
  if (!(error instanceof GitHubHttpError) || error.status !== 422) return false;
  const message =
    typeof error.data === 'object' && error.data?.message
      ? error.data.message
      : String(error.data ?? '');
  return /not behind|already up.?to.?date/i.test(message);
}

export async function handleReviewRequested(payload, config) {
  if (!matchesReviewRequest(payload, config)) return 'ignored-reviewer';

  const installationId = payload.installation?.id;
  if (!installationId) throw new Error('Webhook payload is missing installation.id');

  const owner = payload.repository?.owner?.login;
  const repo = payload.repository?.name;
  const number = payload.pull_request?.number;
  if (!owner || !repo || !number) throw new Error('Webhook payload is missing pull request repository data');

  const token = await getInstallationToken(installationId, config);
  let pull = await getPullWithMergeability(token, owner, repo, number);

  if (pull.state !== 'open') return 'ignored-closed';
  if (pull.base?.ref !== 'main') return 'ignored-non-main';

  if (isMergeConflict(pull)) {
    return commentOnConflict(token, owner, repo, number, pull);
  }

  const comparison = await compareBaseAndHead(token, owner, repo, pull);
  if ((comparison?.behind_by ?? 0) === 0) return 'already-current';

  try {
    await githubRequest(`${repoPath(owner, repo)}/pulls/${number}/update-branch`, token, {
      method: 'PUT',
      body: JSON.stringify({ expected_head_sha: pull.head.sha })
    });
    return 'sync-requested';
  } catch (error) {
    if (updateErrorLooksUpToDate(error)) return 'already-current';

    pull = await getPullWithMergeability(token, owner, repo, number);
    if (isMergeConflict(pull) || updateErrorLooksLikeConflict(error)) {
      return commentOnConflict(token, owner, repo, number, pull);
    }

    if (pull.head.sha !== payload.pull_request.head.sha) return 'head-changed';
    throw error;
  }
}
