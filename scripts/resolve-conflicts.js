#!/usr/bin/env node
// Local preview producer for Sweetiebot. Never edits the repository's worktree.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, lstat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateConflictRequest, validateResolutionOutput } from '../src/resolve.js';

function git(root, args, encoding = 'utf8') {
  return execFileSync('git', args, { cwd: root, encoding, maxBuffer: 4 * 1024 * 1024 });
}

export function parseUnmergedIndex(buffer) {
  const entries = buffer.toString('utf8').split('\0').filter(Boolean);
  const byPath = new Map();
  for (const entry of entries) {
    const match = /^([0-7]{6}) ([a-f0-9]{40,64}) ([123])\t(.+)$/s.exec(entry);
    if (!match) throw new Error('Unsupported unmerged Git index entry');
    const [, mode, , stage, filename] = match;
    if (!['100644', '100755'].includes(mode)) {
      throw new Error('Lindsey cannot resolve binary, symlink or submodule conflicts: ' + filename);
    }
    const stages = byPath.get(filename) || new Set();
    stages.add(Number(stage));
    byPath.set(filename, stages);
  }
  if (!byPath.size || byPath.size > 8) throw new Error('Expected 1–8 unresolved Git files');
  for (const [name, stages] of byPath) {
    if (!stages.has(2) || !stages.has(3)) {
      throw new Error('Lindsey supports conflicts with both ours and theirs versions: ' + name);
    }
  }
  return [...byPath.keys()];
}

function utf8(bytes, name) {
  if (bytes.includes(0)) throw new Error('Binary conflict files are not supported: ' + name);
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

export async function collectConflictRequest(root) {
  const files = parseUnmergedIndex(git(root, ['ls-files', '-u', '-z'], 'buffer'));
  const branch = git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD']).trim();
  const head = git(root, ['rev-parse', 'HEAD']).trim();
  const fileContents = [];
  const originals = new Map();
  for (const name of files) {
    const absolute = path.resolve(root, name);
    if (!absolute.startsWith(path.resolve(root) + path.sep)) throw new Error('Unsafe index file path');
    const stat = await lstat(absolute);
    if (!stat.isFile()) throw new Error('Only regular conflicted files are supported');
    const bytes = await readFile(absolute);
    utf8(bytes, name);
    originals.set(name, createHash('sha256').update(bytes).digest('hex'));
    const stage = number => {
      try { return utf8(git(root, ['show', ':' + number + ':' + name], 'buffer'), name); }
      catch (error) { if (number === 1) return ''; throw error; }
    };
    fileContents.push({ path: name, base: stage(1), ours: stage(2), theirs: stage(3) });
  }
  return { request: validateConflictRequest({ version: 1, branch, head, files: fileContents }), originals };
}

export function validateEndpoint(urlString) {
  const url = new URL(urlString);
  if (!(url.protocol === 'https:' || (url.protocol === 'http:' &&
        ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) ||
      url.username || url.password || url.search || url.hash || url.pathname !== '/resolve-conflicts') {
    throw new Error('LINDSEY_RESOLVE_URL must be HTTPS /resolve-conflicts (HTTP localhost allowed)');
  }
  return url;
}

function parseArgs(args) {
  let repo, output;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--repo' && args[i + 1]) repo = path.resolve(args[++i]);
    else if (args[i] === '--output' && args[i + 1]) output = path.resolve(args[++i]);
    else throw new Error('Usage: resolve-conflicts.js --repo <git-root> --output <empty-temp-directory>');
  }
  if (!repo || !output || repo === output || output.startsWith(repo + path.sep)) {
    throw new Error('Provide a repository and a separate output directory outside its worktree');
  }
  return { repo, output };
}

export async function main(args = process.argv.slice(2), env = process.env, fetchImpl = fetch) {
  const { repo, output } = parseArgs(args);
  const secret = env.LINDSEY_RESOLVE_SECRET?.trim();
  if (!secret) throw new Error('Set LINDSEY_RESOLVE_SECRET in Sweetiebot’s local environment');
  const endpoint = validateEndpoint(env.LINDSEY_RESOLVE_URL || '');
  const { request, originals } = await collectConflictRequest(repo);
  await mkdir(output, { recursive: true });
  if (!(await lstat(output)).isDirectory()) throw new Error('Output is not a directory');
  const response = await fetchImpl(endpoint, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + secret, 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
    signal: AbortSignal.timeout(120000)
  });
  const reply = await response.json();
  if (!response.ok || !reply.ok) {
    throw new Error(reply.error || 'Lindsey resolve endpoint HTTP ' + response.status);
  }
  const validated = validateResolutionOutput(reply, request.files);
  const files = [];
  for (const [i, result] of validated.resolutions.entries()) {
    const filename = 'candidate-' + i + '.txt';
    await writeFile(path.join(output, filename), result.contents, { flag: 'wx', mode: 0o600 });
    files.push({ path: result.path, candidate: filename, originalSha: originals.get(result.path) });
  }
  const manifest = { version: 1, branch: request.branch, head: request.head, files };
  process.stdout.write(JSON.stringify(manifest) + '\n');
  return manifest;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
