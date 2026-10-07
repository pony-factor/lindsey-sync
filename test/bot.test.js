import assert from 'node:assert/strict';
import test from 'node:test';

import {
  conflictComment,
  conflictMarker,
  isMergeConflict,
  matchesReviewRequest,
  verifyWebhookSignature
} from '../src/bot.js';

test('validates GitHub webhook HMAC using the published test vector', () => {
  const secret = "It's a Secret to Everybody";
  const payload = Buffer.from('Hello, World!');
  const signature =
    'sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17';

  assert.equal(verifyWebhookSignature(secret, payload, signature), true);
  assert.equal(verifyWebhookSignature(secret, payload, 'sha256=deadbeef'), false);
});

test('matches a configured reviewer login case-insensitively', () => {
  const payload = {
    action: 'review_requested',
    pull_request: { number: 12 },
    requested_reviewer: { login: 'Codex-Bot[bot]' }
  };

  assert.equal(
    matchesReviewRequest(payload, { reviewerLogin: 'codex-bot[bot]' }),
    true
  );
});

test('matches a configured reviewer team', () => {
  const payload = {
    action: 'review_requested',
    pull_request: { number: 12 },
    requested_team: { slug: 'codex-bot' }
  };

  assert.equal(matchesReviewRequest(payload, { reviewerTeam: 'codex-bot' }), true);
});

test('ignores unrelated pull request events', () => {
  const payload = {
    action: 'synchronize',
    pull_request: { number: 12 },
    requested_reviewer: { login: 'codex-bot[bot]' }
  };

  assert.equal(
    matchesReviewRequest(payload, { reviewerLogin: 'codex-bot[bot]' }),
    false
  );
});

test('recognizes GitHub merge conflicts', () => {
  assert.equal(isMergeConflict({ mergeable: false, mergeable_state: 'dirty' }), true);
  assert.equal(isMergeConflict({ mergeable: true, mergeable_state: 'clean' }), false);
});

test('conflict comments are deterministic and explicitly make no changes', () => {
  const pull = {
    base: { sha: 'base123' },
    head: { sha: 'head456' }
  };

  assert.equal(
    conflictMarker(pull),
    '<!-- lindsey-sync:sync-conflict:base123:head456 -->'
  );
  assert.match(conflictComment(pull), /conflicts with `main`/);
  assert.match(conflictComment(pull), /No changes were made/);
});
