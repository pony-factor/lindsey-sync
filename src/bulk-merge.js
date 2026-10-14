import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const CODEx_WEB = { name: 'Codex Web', email: 'noreply@openai.com' };
const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const TRAILER = /^Co-authored-by:\s*(.+?)\s*<([^<>\s]+@[^<>\s]+)>[ \t]*$/gim;

export class BulkMergeError extends Error {
  constructor(message) { super(message); this.name = 'BulkMergeError'; }
}

export function squashTitle(title, number) {
  const stem = String(title || '').trim().replace(/\s*\(#\d+\)\s*$/, '').trim();
  if (!stem || !Number.isSafeInteger(number) || number < 1) {
    throw new BulkMergeError('A valid PR title and number are required');
  }
  return stem + ' (#' + number + ')';
}

export function validateSelection(payload) {
  if (!REPO.test(payload?.repository || '') ||
      !Array.isArray(payload?.pullRequests) ||
      !payload.pullRequests.length || payload.pullRequests.length > 50) {
    throw new BulkMergeError('Specify a repository and 1–50 selected pull requests');
  }
  const numbers = new Set();
  const pullRequests = payload.pullRequests.map(item => {
    const number = Number(item?.number);
    if (!Number.isSafeInteger(number) || number < 1 || numbers.has(number) ||
        typeof item?.base !== 'string' || !item.base ||
        typeof item?.title !== 'string' || !item.title.trim() ||
        typeof item?.head !== 'string' || !item.head ||
        !SHA.test(item?.headSha || '')) {
      throw new BulkMergeError('Every selected PR needs a unique number, title, base, head, and exact SHA');
    }
    numbers.add(number);
    return { number, title: item.title, base: item.base, head: item.head,
      headSha: item.headSha, headRepo: item.headRepo || '',
      stack: Boolean(item.stack) };
  });
  return { repository: payload.repository, pullRequests };
}

function contributorTier(person, originalAuthor) {
  const id = person.name.toLowerCase();
  const email = person.email.toLowerCase();
  if (/^codex$/.test(id)) return 2;
  if (/^codex web$/.test(id)) return 3;
  if (/codex.pony/.test(id) || /codex-pony/.test(email)) return 4;
  if (/copilot/.test(id + ' ' + email)) return 5;
  if (/ollama/.test(id + ' ' + email)) return 6;
  if (/\[bot\]|bot@|github-actions|dependabot|^github$|^web-flow$/.test(id + ' ' + email)) return 7;
  if (/openai|claude|gemini|ai.agent/.test(id + ' ' + email)) return 8;
  return originalAuthor ? 0 : 1;
}

function contributor(name, email, originalAuthor) {
  if (typeof name !== 'string' || typeof email !== 'string' ||
      !name.trim() || name.length > 120 || !/^[^\s<>]+@[^\s<>]+$/.test(email) ||
      /[\r\n<>]/.test(name)) return null;
  const normalized = { name: name.trim(), email: email.trim() };
  return { ...normalized, tier: contributorTier(normalized, originalAuthor) };
}

export function attributionForCommits(commits) {
  if (!commits.length) throw new BulkMergeError('No original PR commits found');
  const entries = new Map();
  function include(person) {
    if (!person) return;
    const key = person.name.toLowerCase() + '\0' + person.email.toLowerCase();
    const existing = entries.get(key);
    if (!existing || person.tier < existing.tier) entries.set(key, person);
  }
  for (const entry of commits) {
    const author = entry?.commit?.author;
    const creator = contributor(author?.name, author?.email, true);
    if (!creator) throw new BulkMergeError('An original commit author has no verified name/email');
    include(creator);
    const committer = entry?.commit?.committer;
    // GitHub's merge machinery can be the committer; it is not evidence of a human.
    if (committer?.name && committer?.email) include(contributor(committer.name, committer.email, false));
    const body = String(entry?.commit?.message || '');
    for (const match of body.matchAll(TRAILER)) include(contributor(match[1], match[2], false));
  }
  include(contributor(CODEx_WEB.name, CODEx_WEB.email, false));
  const ordered = [...entries.values()].sort((a, b) => a.tier - b.tier);
  return ordered.map(p => 'Co-authored-by: ' + p.name + ' <' + p.email + '>');
}

export function isLinkedStack(selected, item) {
  if (item.stack) return true;
  return selected.pullRequests.some(other => other.number !== item.number && (
    (item.base === other.head && (!other.headRepo || other.headRepo === selected.repository)) ||
    (other.base === item.head && (!item.headRepo || item.headRepo === selected.repository))
  ));
}

export async function githubApi(path, method = 'GET', body) {
  const args = ['api', '-X', method, path];
  if (body) for (const [key, value] of Object.entries(body)) {
    args.push('-f', key + '=' + value);
  }
  const result = await exec('gh', args, { timeout: 120000, maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0' } });
  return JSON.parse(result.stdout);
}

async function collectCommits(api, repoPath, number) {
  const commits = [];
  for (let page = 1; page <= 100; page++) {
    const group = await api(repoPath + '/pulls/' + number + '/commits?per_page=100&page=' + page);
    if (!Array.isArray(group)) throw new BulkMergeError('GitHub returned invalid commit history');
    commits.push(...group);
    if (group.length < 100) return commits;
  }
  throw new BulkMergeError('Commit history exceeds safe pagination limit');
}

function matchesSnapshot(pr, selected, repo) {
  return pr?.state === 'open' && !pr.draft &&
    pr?.base?.ref === selected.base &&
    pr?.base?.repo?.full_name?.toLowerCase() === repo.toLowerCase() &&
    pr?.head?.ref === selected.head &&
    pr?.head?.sha === selected.headSha &&
    (!selected.headRepo || pr?.head?.repo?.full_name?.toLowerCase() === selected.headRepo.toLowerCase()) &&
    pr?.title === selected.title;
}

function result(item, status, reason, more = {}) {
  return { number: item.number, base: item.base, status, ...(reason ? { reason } : {}), ...more };
}

async function runOne(api, prefix, selection, repo) {
  let pr = await api(prefix + '/pulls/' + selection.number);
  if (!matchesSnapshot(pr, selection, repo)) {
    return result(selection, 'blocked', 'The PR head, base, title, or state changed; refresh the picker');
  }
  if (pr.stack) return result(selection, 'blocked', 'Native stacks require per-layer attribution-safe merging');
  if (pr.mergeable !== true) {
    return result(selection, 'blocked', 'GitHub has not confirmed this PR is mergeable');
  }
  if (!(Number(pr.changed_files) > 0)) {
    return result(selection, 'blocked', 'No changed PR files to squash');
  }

  const commits = await collectCommits(api, prefix, selection.number);
  const trailers = attributionForCommits(commits);
  const title = squashTitle(pr.title, selection.number);
  const message = [
    'Squash reviewed changes from pull request #' + selection.number + ' into ' + selection.base + '.',
    'Original PR: https://github.com/' + repo + '/pull/' + selection.number,
    trailers.join('\n')
  ].join('\n\n');

  // Final preflight immediately before a write. The API's sha parameter
  // provides a second compare-and-swap guard on the exact selected HEAD.
  pr = await api(prefix + '/pulls/' + selection.number);
  if (!matchesSnapshot(pr, selection, repo) || pr.mergeable !== true ||
      !(Number(pr.changed_files) > 0)) {
    return result(selection, 'blocked', 'PR changed or stopped being mergeable during preflight');
  }
  const response = await api(prefix + '/pulls/' + selection.number + '/merge', 'PUT', {
    merge_method: 'squash', sha: selection.headSha,
    commit_title: title, commit_message: message
  });
  if (!response?.merged || !SHA.test(response.sha || '')) {
    return result(selection, 'queued', 'GitHub did not confirm a completed squash merge');
  }
  const hash = response.sha;
  const commit = await api(prefix + '/commits/' + hash);
  const mergedPr = await api(prefix + '/pulls/' + selection.number);
  const actual = String(commit?.commit?.message || '');
  const expectedTrailers = trailers;
  let previous = -1;
  const trailersOrdered = expectedTrailers.every(line => {
    const next = actual.indexOf(line);
    if (next <= previous) return false;
    previous = next;
    return true;
  });
  let changedTree = true;
  const parentSha = commit?.parents?.[0]?.sha;
  if (parentSha) {
    const parent = await api(prefix + '/commits/' + parentSha);
    changedTree = Boolean(commit?.commit?.tree?.sha &&
      parent?.commit?.tree?.sha && commit.commit.tree.sha !== parent.commit.tree.sha);
  }
  const verified = actual.split('\n')[0] === title &&
    trailersOrdered && changedTree && mergedPr?.merged === true &&
    mergedPr?.base?.ref === selection.base &&
    mergedPr?.merge_commit_sha === hash;
  return result(selection, verified ? 'merged' : 'verification-failed',
    verified ? undefined : 'GitHub merged the PR but commit attribution or resulting tree failed verification',
    { sha: hash, url: 'https://github.com/' + repo + '/commit/' + hash });
}

export async function mergeSelectedPullRequests(payload, api = githubApi) {
  const request = validateSelection(payload);
  const prefix = 'repos/' + request.repository;
  const results = [];
  // Preflight the whole selection before allowing the first write.
  const live = new Map();
  for (const item of request.pullRequests) {
    try {
      live.set(item.number, await api(prefix + '/pulls/' + item.number));
    } catch (error) {
      live.set(item.number, { error: String(error.message || error) });
    }
  }
  // A child can point at an unselected open parent. Discover those parents
  // instead of assuming a non-main target is unrelated merely from the picker.
  const openHeads = new Set();
  let ancestryError = '';
  if (request.pullRequests.some(item => item.base !== 'main')) {
    try {
      for (let page = 1; page <= 20; page++) {
        const group = await api(prefix + '/pulls?state=open&per_page=100&page=' + page);
        if (!Array.isArray(group)) throw new BulkMergeError('Invalid open-PR list');
        for (const pr of group) {
          if (pr?.head?.repo?.full_name?.toLowerCase() === request.repository.toLowerCase()) {
            openHeads.add(pr.head.ref);
          }
        }
        if (group.length < 100) break;
        if (page === 20) throw new BulkMergeError('Open-PR ancestry exceeds pagination limit');
      }
    } catch (error) {
      ancestryError = String(error.message || error);
    }
  }
  const ordered = [...request.pullRequests].sort((a, b) => a.number - b.number);
  for (const item of ordered) {
    const snapshot = live.get(item.number);
    if (snapshot?.error) {
      results.push(result(item, 'blocked', snapshot.error));
    } else if (!matchesSnapshot(snapshot, item, request.repository)) {
      results.push(result(item, 'blocked', 'Selected PR no longer matches its GitHub snapshot'));
    } else if (item.base !== 'main' && ancestryError) {
      results.push(result(item, 'blocked', 'Could not verify open parent PRs: ' + ancestryError));
    } else if (item.base !== 'main' && openHeads.has(item.base)) {
      results.push(result(item, 'blocked', 'Base branch is the head of an open PR; select and verify the complete ancestry'));
    } else if (isLinkedStack(request, item) || snapshot.stack) {
      results.push(result(item, 'blocked', 'Stack members cannot use ordinary PR merges without losing layer boundaries'));
    } else {
      try {
        results.push(await runOne(api, prefix, item, request.repository));
      } catch (error) {
        results.push(result(item, 'blocked', String(error.message || error)));
      }
    }
  }
  return { version: 1, repository: request.repository, results };
}
