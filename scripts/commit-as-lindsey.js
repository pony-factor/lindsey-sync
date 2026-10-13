
#!/usr/bin/env node
// Execute from the target repository's working directory. No GitHub App private key is stored here.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

function git(args, encoding = 'utf8') {
  return execFileSync('git', args, { encoding, maxBuffer: 20 * 1024 * 1024 });
}

export function repositoryFromRemote(url) {
  const match = /^(?:git@github\.com:|ssh:\/\/git@github\.com\/|https:\/\/github\.com\/)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/i.exec(url.trim());
  if (!match) throw new Error('origin must point to a GitHub owner/repository URL');
  return `${match[1]}/${match[2]}`;
}

export function parseStagedRaw(raw, showFile) {
  const fields = raw.toString('utf8').split('\0');
  const additions = [], deletions = [];
  for (let i = 0; i < fields.length - 1; i += 2) {
    const metadata = fields[i];
    const path = fields[i + 1];
    const match = /^:([0-7]{6}) ([0-7]{6}) [a-f0-9]+ [a-f0-9]+ ([A-Z])$/.exec(metadata);
    if (!match || !path) throw new Error('Unsupported git index diff entry');
    const [, oldMode, newMode, status] = match;
    if (!['000000', '100644'].includes(oldMode) || !['000000', '100644'].includes(newMode)) {
      throw new Error(`Unsupported mode change for ${path}; executable files, symlinks and submodules require normal git commits`);
    }
    if (status === 'D') deletions.push({ path });
    else if (status === 'A' || status === 'M' || status === 'T') {
      additions.push({ path, contents: showFile(path).toString('base64') });
    } else throw new Error(`Unsupported staged change type ${status}`);
  }
  if (!additions.length && !deletions.length) throw new Error('No staged changes to commit');
  return { additions, deletions };
}

function parseArgs(args) {
  let headline = '', body = '';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-m' && args[i + 1]) headline = args[++i];
    else if (args[i] === '-b' && args[i + 1]) body = args[++i];
    else throw new Error('Usage: lindsey-commit -m "✨ Commit title" [-b "Commit body"]');
  }
  if (!headline) throw new Error('Specify the commit title with -m');
  return { headline, body };
}

export async function main(args = process.argv.slice(2)) {
  const { headline, body } = parseArgs(args);
  const endpoint = process.env.LINDSEY_COMMIT_URL?.trim();
  const secret = process.env.LINDSEY_COMMIT_SECRET?.trim();
  if (!endpoint || !secret) throw new Error('Set LINDSEY_COMMIT_URL and LINDSEY_COMMIT_SECRET');
  const url = new URL(endpoint);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) ||
      url.username || url.password || url.search || url.hash || url.pathname !== '/commit') {
    throw new Error('LINDSEY_COMMIT_URL must be an HTTPS /commit endpoint (HTTP localhost for development)');
  }

  const branch = git(['symbolic-ref', '--quiet', '--short', 'HEAD']).trim();
  if (['main', 'master'].includes(branch.toLowerCase())) {
    throw new Error('Commit on a feature branch, not main/master');
  }
  const repository = repositoryFromRemote(git(['remote', 'get-url', 'origin']));
  const oldHead = git(['rev-parse', '--verify', 'HEAD']).trim();
  const remote = git(['ls-remote', '--heads', 'origin', `refs/heads/${branch}`]).trim();
  if (!remote || remote.split(/\s+/)[0] !== oldHead) {
    throw new Error('The remote branch must exist and match local HEAD; fetch/reconcile before committing');
  }
  const indexTree = git(['write-tree']).trim();
  const fileChanges = parseStagedRaw(
    git(['diff', '--cached', '--raw', '--no-renames', '-z'], 'buffer'),
    (path) => git(['show', `:${path}`], 'buffer')
  );

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${secret}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      repository, branch, expectedHeadOid: oldHead,
      message: { headline, body }, fileChanges
    })
  });
  const result = await response.json();
  if (!response.ok || !result.ok || !result.sha) {
    throw new Error(result.error || `Lindsey commit service returned HTTP ${response.status}`);
  }
  // The remote commit exists even if the subsequent local synchronization fails.
  console.log(`Lindsey created ${result.url || result.sha}`);
  git(['fetch', '--no-tags', 'origin', `refs/heads/${branch}`]);
  const fetched = git(['rev-parse', 'FETCH_HEAD']).trim();
  if (fetched !== result.sha || git(['rev-parse', 'HEAD']).trim() !== oldHead ||
      git(['write-tree']).trim() !== indexTree) {
    throw new Error('Remote commit succeeded, but local state changed; synchronize manually without discarding local work');
  }
  git(['reset', '--mixed', result.sha]);
  console.log(`Local ${branch} now points to Lindsey's commit; unstaged work was preserved.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
