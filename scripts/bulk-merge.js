#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mergeSelectedPullRequests } from '../src/bulk-merge.js';

export async function main(argv = process.argv.slice(2), merge = mergeSelectedPullRequests) {
  if (argv.length !== 2 || argv[0] !== '--input') {
    throw new Error('Usage: node scripts/bulk-merge.js --input /absolute/path/selection.json');
  }
  const file = resolve(argv[1]);
  const data = await readFile(file);
  if (data.length > 128 * 1024) throw new Error('Bulk-merge selection exceeds 128 KiB');
  const output = await merge(JSON.parse(data.toString('utf8')));
  process.stdout.write(JSON.stringify(output) + '\n');
  return output;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    process.stderr.write('Lindsey bulk merge: ' + error.message + '\n');
    process.exitCode = 1;
  });
}
