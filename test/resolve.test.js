import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  validateConflictRequest, validateResolutionOutput, resolveConflicts, ResolutionValidationError
} from '../src/resolve.js';
import { parseUnmergedIndex, validateEndpoint, collectConflictRequest, main } from '../scripts/resolve-conflicts.js';

const head = 'a'.repeat(40);
const body = () => ({ version: 1, branch: 'topic', head, files: [
  { path: 'src/file.js', base: 'base\n', ours: 'left\n', theirs: 'right\n' }
] });

test('validates conflict request shape, sizes, and safe paths', () => {
  assert.equal(validateConflictRequest(body()).files.length, 1);
  for (const change of [
    { head: 'invalid' },
    { files: [] },
    { files: [{ path: '../outside', base: '', ours: '', theirs: '' }] },
    { files: [{ path: 'a', base: '', ours: '\0', theirs: '' }] },
    { files: [body().files[0], body().files[0]] },
    { files: [{ path: 'a', base: '', ours: 'x'.repeat(33000), theirs: '' }] }
  ]) assert.throws(() => validateConflictRequest({ ...body(), ...change }), ResolutionValidationError);
});

test('rejects omitted files, duplicate or invented paths, and unresolved markers', () => {
  const requested = body().files;
  assert.deepEqual(validateResolutionOutput({
    resolutions: [{ path: 'src/file.js', contents: 'merged\n' }]
  }, requested).resolutions, [{ path: 'src/file.js', contents: 'merged\n' }]);
  for (const output of [
    { resolutions: [] },
    { resolutions: [{ path: 'other.js', contents: 'x' }] },
    { resolutions: [{ path: 'src/file.js', contents: '<<<<<<< HEAD\nx' }] },
    { resolutions: [{ path: 'src/file.js', contents: '\0' }] }
  ]) assert.throws(() => validateResolutionOutput(output, requested), ResolutionValidationError);
});

test('passes untrusted sources to the model and never writes GitHub or files', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, request: JSON.parse(init.body) });
    return {
      ok: true, status: 200,
      text: async () => JSON.stringify({
        output: [{ type: 'message', content: [{
          type: 'output_text', text: JSON.stringify({
            resolutions: [{ path: 'src/file.js', contents: 'merged\n' }]
          })
        }] }]
      })
    };
  };
  const result = await resolveConflicts(body(), { openaiApiKey: 'secret', openaiModel: 'test-model' }, fetchImpl);
  assert.equal(result.resolutions[0].contents, 'merged\n');
  assert.equal(calls[0].url, 'https://api.openai.com/v1/responses');
  assert.equal(calls[0].request.model, 'test-model');
  assert.equal(calls[0].request.store, false);
  assert.match(calls[0].request.input, /"theirs":"right/);
  await assert.rejects(resolveConflicts(body(), { openaiApiKey: '' }, fetchImpl), /OPENAI_API_KEY/);
});

test('local interface validates endpoint, index stages, and previews without edits', async () => {
  assert.throws(() => validateEndpoint('http://example.com/resolve-conflicts'), /HTTPS/);
  assert.equal(validateEndpoint('http://127.0.0.1:8788/resolve-conflicts').pathname, '/resolve-conflicts');
  assert.throws(() => parseUnmergedIndex(Buffer.from('')), /1–8/);
  assert.throws(() => parseUnmergedIndex(Buffer.from('120000 ' + head + ' 2\tfile.txt\0')), /symlink/);

  const folder = mkdtempSync(path.join(os.tmpdir(), 'lindsey-resolve-test-'));
  const root = path.join(folder, 'git'), output = path.join(folder, 'proposals');
  mkdirSync(root);
  const git = (args, extra = {}) => execFileSync('git', args,
    { cwd: root, encoding: 'utf8', ...extra }).trim();
  try {
    git(['init', '-b', 'topic']);
    git(['config', 'user.name', 'Test']);
    git(['config', 'user.email', 'test@example.invalid']);
    writeFileSync(path.join(root, 'file.txt'), 'base\n');
    git(['add', 'file.txt']); git(['commit', '-m', 'Base']);
    const blobs = {};
    for (const [stage, text] of [['1', 'base\n'], ['2', 'ours\n'], ['3', 'theirs\n']]) {
      blobs[stage] = git(['hash-object', '-w', '--stdin'], { input: text });
    }
    const index = [1, 2, 3].map(n =>
      '100644 ' + blobs[String(n)] + ' ' + n + '\tfile.txt\n').join('');
    execFileSync('git', ['update-index', '--index-info'], { cwd: root, input: index });
    const conflict = '<<<<<<< ours\nours\n=======\ntheirs\n>>>>>>> theirs\n';
    writeFileSync(path.join(root, 'file.txt'), conflict);
    const beforeHead = git(['rev-parse', 'HEAD']);
    const collected = await collectConflictRequest(root);
    assert.deepEqual(collected.request.files[0], {
      path: 'file.txt', base: 'base\n', ours: 'ours\n', theirs: 'theirs\n'
    });
    const fetchImpl = async (_url, init) => {
      assert.equal(init.headers.Authorization, 'Bearer local-secret');
      assert.equal(JSON.parse(init.body).head, beforeHead);
      return { ok: true, status: 200, json: async () => ({
        ok: true, version: 1, resolutions: [{ path: 'file.txt', contents: 'merged\n' }]
      }) };
    };
    const manifest = await main(['--repo', root, '--output', output], {
      LINDSEY_RESOLVE_URL: 'http://localhost:8788/resolve-conflicts',
      LINDSEY_RESOLVE_SECRET: 'local-secret'
    }, fetchImpl);
    assert.equal(manifest.version, 1);
    assert.equal(manifest.files[0].path, 'file.txt');
    assert.equal(readFileSync(path.join(output, 'candidate-0.txt'), 'utf8'), 'merged\n');
    assert.equal(readFileSync(path.join(root, 'file.txt'), 'utf8'), conflict);
    assert.equal(git(['rev-parse', 'HEAD']), beforeHead);
    assert.match(git(['ls-files', '-u', '--', 'file.txt']), /file.txt/);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});
