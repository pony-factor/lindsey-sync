
import { timingSafeEqual } from 'node:crypto';
import { getInstallationToken } from './bot.js';

const GRAPHQL_ENDPOINT = 'https://api.github.com/graphql';
const COAUTHOR = 'Co-authored-by: Codex Web <noreply@openai.com>';
const MAX_CONTENT = 8 * 1024 * 1024;
const MUTATION = `mutation($input: CreateCommitOnBranchInput!) {
  createCommitOnBranch(input: $input) {
    commit { oid url signature { isValid wasSignedByGitHub } }
  }
}`;

export class CommitValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CommitValidationError';
  }
}

export function authorizeCommit(header, secret) {
  if (!secret || typeof header !== 'string') return false;
  const match = /^Bearer (.+)$/i.exec(header);
  if (!match) return false;
  const actual = Buffer.from(match[1]);
  const expected = Buffer.from(secret);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function validPath(path) {
  return typeof path === 'string' &&
    path.length > 0 && path.length <= 1024 &&
    !path.startsWith('/') && !path.includes('\\') &&
    !path.split('/').some((part) => part === '' || part === '.' || part === '..' || part === '.git') &&
    !/[\x00-\x1f]/.test(path);
}

export function buildCommitInput(payload, allowedRepositories = []) {
  const repository = payload?.repository;
  if (typeof repository !== 'string' ||
      !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) ||
      !allowedRepositories.some((item) => item.toLowerCase() === repository.toLowerCase())) {
    throw new CommitValidationError('Repository is not allowlisted');
  }
  const branch = payload.branch;
  if (typeof branch !== 'string' || !/^[A-Za-z0-9_][A-Za-z0-9_.\/-]{0,200}$/.test(branch) ||
      branch.includes('..') || branch.includes('//') || branch.endsWith('/') ||
      branch.endsWith('.') || /(^|\/)(main|master)$/i.test(branch)) {
    throw new CommitValidationError('A valid non-protected feature branch is required');
  }
  if (typeof payload.expectedHeadOid !== 'string' ||
      !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(payload.expectedHeadOid)) {
    throw new CommitValidationError('expectedHeadOid must be a commit SHA');
  }
  const headline = payload.message?.headline;
  const body = payload.message?.body || '';
  if (typeof headline !== 'string' || !headline.trim() || headline.length > 200 ||
      /[\r\n]/.test(headline) || typeof body !== 'string' || body.length > 16000) {
    throw new CommitValidationError('A single-line commit headline and optional body are required');
  }

  const additions = payload.fileChanges?.additions ?? [];
  const deletions = payload.fileChanges?.deletions ?? [];
  if (!Array.isArray(additions) || !Array.isArray(deletions) ||
      additions.length + deletions.length < 1 ||
      additions.length + deletions.length > 500) {
    throw new CommitValidationError('Provide 1–500 staged file changes');
  }
  let size = 0;
  const paths = new Set();
  for (const item of [...additions, ...deletions]) {
    if (!validPath(item?.path) || paths.has(item.path)) {
      throw new CommitValidationError('Invalid or duplicated changed file path');
    }
    paths.add(item.path);
  }
  for (const addition of additions) {
    if (typeof addition.contents !== 'string' ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(addition.contents)) {
      throw new CommitValidationError('Additions must have base64-encoded index content');
    }
    size += addition.contents.length;
  }
  if (size > MAX_CONTENT) throw new CommitValidationError('Staged content exceeds 8 MiB');
  const cleanBody = body.trim().replace(/\n*Co-authored-by: Codex Web <noreply@openai\.com>\s*$/i, '').trim();
  const signedBody = [cleanBody, COAUTHOR].filter(Boolean).join('\n\n');
  return {
    branch: { repositoryNameWithOwner: repository, branchName: branch },
    expectedHeadOid: payload.expectedHeadOid,
    message: { headline: headline.trim(), body: signedBody },
    fileChanges: { additions, deletions }
  };
}

export async function commitAsLindsey(payload, config, deps = {}) {
  const input = buildCommitInput(payload, config.commitRepositories);
  const getToken = deps.getToken || getInstallationToken;
  const fetchImpl = deps.fetchImpl || fetch;
  const token = await getToken(config.commitInstallationId, config);
  const response = await fetchImpl(GRAPHQL_ENDPOINT, {
    method: 'POST',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2026-03-10',
      'User-Agent': 'pony-factor-lindsey-sync/0.3.0'
    },
    body: JSON.stringify({ query: MUTATION, variables: { input } })
  });
  const json = await response.json();
  if (!response.ok || json.errors?.length || !json.data?.createCommitOnBranch?.commit?.oid) {
    const reason = json.errors?.map((error) => error.message).join('; ') ||
      json.message || `GitHub HTTP ${response.status}`;
    throw new Error(`GitHub refused Lindsey's commit: ${reason}`);
  }
  const result = json.data.createCommitOnBranch.commit;
  return { sha: result.oid, url: result.url, verified: result.signature?.isValid === true };
}
