
import assert from 'node:assert/strict';
import test from 'node:test';
import { authorizeCommit, buildCommitInput, commitAsLindsey, CommitValidationError } from '../src/commit.js';
import { parseStagedRaw, repositoryFromRemote } from '../scripts/commit-as-lindsey.js';

const sha = 'a'.repeat(40);
const payload = () => ({
  repository: 'pony-factor/lindsey-sync', branch: 'lindsey-pony-commit',
  expectedHeadOid: sha, message: { headline: '🔩 Commit as Lindsey', body: 'Add branch publishing.' },
  fileChanges: { additions: [{ path: 'file.txt', contents: Buffer.from('hello').toString('base64') }], deletions: [] }
});
const allowed = ['pony-factor/lindsey-sync'];

test('commit endpoint uses constant-time bearer comparison and rejects missing or incorrect credentials', () => {
  assert.equal(authorizeCommit('Bearer very-secret', 'very-secret'), true);
  assert.equal(authorizeCommit('Bearer other', 'very-secret'), false);
  assert.equal(authorizeCommit('', 'very-secret'), false);
});

test('constrains repository, branch, SHA, file paths and staged content', () => {
  const valid = buildCommitInput(payload(), allowed);
  assert.equal(valid.branch.branchName, 'lindsey-pony-commit');
  assert.match(valid.message.body, /Co-authored-by: Codex Web <noreply@openai.com>$/);
  const invalids = [
    { repository: 'pony-factor/other' },
    { branch: 'main' }, { branch: '../main' }, { expectedHeadOid: 'invalid' },
    { fileChanges: { additions: [{ path: '../evil', contents: 'eA==' }], deletions: [] } },
    { fileChanges: { additions: [{ path: 'a', contents: '?' }], deletions: [] } },
    { fileChanges: { additions: [{ path: 'a', contents: 'YQ==' }], deletions: [{ path: 'a' }] } }
  ];
  for (const changes of invalids) {
    assert.throws(() => buildCommitInput({ ...payload(), ...changes }, allowed), CommitValidationError);
  }
});

test('coauthor trailer appears once even when present in requested body', () => {
  const original = payload();
  original.message.body = 'Change details.\\n\\nCo-authored-by: Codex Web <noreply@openai.com>';
  const input = buildCommitInput(original, allowed);
  assert.equal(input.message.body.match(/Co-authored-by:/g).length, 1);
});

test('posts authenticated GraphQL mutation with branch compare-and-swap and no author override', async () => {
  let data;
  const fetchImpl = async (url, init) => {
    assert.equal(url, 'https://api.github.com/graphql');
    assert.equal(init.headers.Authorization, 'Bearer app-installation-token');
    data = JSON.parse(init.body);
    return { ok: true, status: 200, json: async () => ({
      data: { createCommitOnBranch: { commit: { oid: 'b'.repeat(40), url: 'https://github.com/example/commit/sha',
        signature: { isValid: true } } } }
    }) };
  };
  const output = await commitAsLindsey(payload(),
    { commitRepositories: allowed, commitInstallationId: '123' },
    { getToken: async (id) => { assert.equal(id, '123'); return 'app-installation-token'; }, fetchImpl });
  assert.equal(data.variables.input.expectedHeadOid, sha);
  assert.equal(data.variables.input.message.headline, '🔩 Commit as Lindsey');
  assert.equal(data.variables.input.author, undefined);
  assert.equal(output.verified, true);
});

test('parses index changes and rejects modes unsupported by GitHub-signed mutation', () => {
  const content = Buffer.from(':000000 100644 0000000 abcd123 A\\0new.txt\\0:100644 000000 abcd123 0000000 D\\0old.txt\\0'.replaceAll('\\0', '\0'));
  const files = parseStagedRaw(content, () => Buffer.from('new'));
  assert.equal(files.additions[0].contents, 'bmV3');
  assert.equal(files.deletions[0].path, 'old.txt');
  assert.throws(() => parseStagedRaw(Buffer.from(':100644 100755 abcd123 abcd123 M\0run.sh\0'), () => Buffer.from('x')), /Unsupported mode/);
  assert.equal(repositoryFromRemote('git@github.com:pony-factor/lindsey-sync.git'), 'pony-factor/lindsey-sync');
});
