import assert from 'node:assert/strict';
import test from 'node:test';
import {
  attributionForCommits, isLinkedStack, mergeSelectedPullRequests,
  squashTitle, validateSelection, BulkMergeError
} from '../src/bulk-merge.js';

const sha = 'a'.repeat(40);
const mergedSha = 'b'.repeat(40);
const repo = 'pony-factor/example';
const selected = (number = 10, changes = {}) => ({
  number, title: '🐛 Correct caching', head: 'pony-topic', headSha: sha,
  base: 'main', headRepo: repo, ...changes
});
const request = (...pullRequests) => ({ repository: repo, pullRequests });
const live = (item) => ({
  number: item.number, title: item.title, state: 'open', draft: false,
  base: { ref: item.base, repo: { full_name: repo } },
  head: { ref: item.head, sha: item.headSha, repo: { full_name: item.headRepo || repo } },
  changed_files: 2, mergeable: true
});
const gitCommit = (name, email, message = 'Improve caching.') => ({
  commit: { author: { name, email }, committer: { name: 'GitHub', email: 'noreply@github.com' }, message }
});

test('validates exact snapshots and numbered squash titles', () => {
  assert.equal(squashTitle('🐛 Correct caching (#4)', 10), '🐛 Correct caching (#10)');
  assert.equal(validateSelection(request(selected())).pullRequests.length, 1);
  assert.throws(() => validateSelection(request(selected(), selected())), BulkMergeError);
  assert.throws(() => validateSelection(request(selected(1, { headSha: 'wrong' }))), BulkMergeError);
  assert.throws(() => validateSelection(request(selected(1, { title: '' }))), BulkMergeError);
});

test('preserves original human author and ordered Codex / Codex Web / other identities', () => {
  const entries = attributionForCommits([
    gitCommit('A. Human', '123+human@users.noreply.github.com',
      'Fix issue\n\nCo-authored-by: Ollama <hello@ollama.com>\nCo-authored-by: Codex <noreply@openai.com>'),
    gitCommit('codex-pony[bot]', '326443430+codex-pony[bot]@users.noreply.github.com')
  ]);
  assert(entries[0].includes('A. Human'));
  const order = ['Codex <', 'Codex Web <', 'codex-pony[bot] <', 'Ollama <'];
  let cursor = 0;
  for (const phrase of order) {
    const found = entries.findIndex((s, i) => i >= cursor && s.includes(phrase));
    assert(found >= cursor, 'Missing or unordered ' + phrase);
    cursor = found + 1;
  }
  assert.equal(entries.filter(s => s.includes('Codex Web <')).length, 1);
  assert.throws(() => attributionForCommits([gitCommit('', '')]), BulkMergeError);
});

test('linked PRs and native stack metadata are never ordinary-squash merged', () => {
  const a = selected(1, { head: 'lower' });
  const b = selected(2, { head: 'upper', base: 'lower' });
  assert(isLinkedStack(request(a, b), a));
  assert(isLinkedStack(request(a, b), b));
  assert(isLinkedStack(request(selected(3, { stack: true })), selected(3, { stack: true })));
});

test('squash merges only a selected, fresh, mergeable PR and verifies result', async () => {
  const item = selected();
  const calls = [];
  let submitted;
  const api = async (path, method = 'GET', body) => {
    calls.push({ path, method });
    if (path.endsWith('/pulls/10/commits?per_page=100&page=1')) {
      return [gitCommit('A. Human', '123+human@users.noreply.github.com',
        'Change\n\nCo-authored-by: Codex <noreply@openai.com>')];
    }
    if (path.endsWith('/pulls/10/merge')) {
      submitted = body;
      return { merged: true, sha: mergedSha };
    }
    if (path.endsWith('/pulls/10')) {
      if (submitted) return { ...live(item), merged: true, merge_commit_sha: mergedSha };
      return live(item);
    }
    if (path.endsWith('/commits/' + mergedSha)) {
      return { commit: { message: submitted.commit_title + '\n\n' + submitted.commit_message,
        tree: { sha: 'tree-new' } }, parents: [{ sha }] };
    }
    if (path.endsWith('/commits/' + sha)) return { commit: { tree: { sha: 'tree-old' } } };
    throw new Error('Unexpected request ' + path);
  };
  const result = await mergeSelectedPullRequests(request(item), api);
  assert.equal(result.results[0].status, 'merged');
  assert.equal(result.results[0].sha, mergedSha);
  assert.equal(submitted.sha, sha);
  assert.equal(submitted.merge_method, 'squash');
  assert.equal(submitted.commit_title, '🐛 Correct caching (#10)');
  assert(submitted.commit_message.indexOf('A. Human') < submitted.commit_message.indexOf('Codex Web'));
  assert(calls.every(call => !call.path.includes('pulls/11')));
});

test('stale head, conflict, and incomplete selected stacks cause no writes', async () => {
  const original = selected();
  const stackParent = selected(20, { head: 'base-layer' });
  const stackChild = selected(21, { base: 'base-layer', head: 'second-layer' });
  let writes = 0;
  const api = async (path, method = 'GET') => {
    if (method !== 'GET') { writes++; throw new Error('Unexpected mutation'); }
    const n = Number(/\/pulls\/(\d+)/.exec(path)?.[1]);
    if (n === 10) return live({ ...original, headSha: 'c'.repeat(40) });
    if (n === 20) return live(stackParent);
    if (n === 21) return live(stackChild);
    throw new Error('Unexpected request');
  };
  const result = await mergeSelectedPullRequests(request(original, stackParent, stackChild), api);
  assert.deepEqual(result.results.map(r => r.status), ['blocked', 'blocked', 'blocked']);
  assert.equal(writes, 0);
});
