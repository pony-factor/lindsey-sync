import assert from 'node:assert/strict';
import test from 'node:test';

import {
  changedRightLines,
  formatInlineComment,
  formatReviewBody,
  normalizeReviewFindings,
  reviewMarker
} from '../src/review.js';

test('tracks only added or modified right-side lines from a unified diff', () => {
  const patch = `@@ -10,4 +10,5 @@
 unchanged
-old
+new
+second
 tail`;

  assert.deepEqual([...changedRightLines(patch)], [11, 12]);
});

test('drops invented locations and downgrades obvious findings without a suggestion', () => {
  const valid = new Map([['src/app.js', new Set([8, 9])]]);
  const findings = normalizeReviewFindings(
    {
      findings: [
        {
          path: 'src/app.js',
          line: 8,
          kind: 'obvious',
          comment: 'This branch can never run.',
          suggestion: 'if (ready) {'
        },
        {
          path: 'src/app.js',
          line: 9,
          kind: 'obvious',
          comment: 'The correct behavior depends on product intent.',
          suggestion: null
        },
        {
          path: 'src/missing.js',
          line: 1,
          kind: 'human',
          comment: 'Invented location.',
          suggestion: null
        }
      ]
    },
    valid
  );

  assert.equal(findings.length, 2);
  assert.equal(findings[0].kind, 'obvious');
  assert.equal(findings[1].kind, 'human');
});

test('formats obvious fixes as GitHub suggestions and human concerns without patches', () => {
  assert.match(
    formatInlineComment({
      kind: 'obvious',
      comment: 'Use the guarded value.',
      suggestion: 'return value;'
    }),
    /```suggestion\nreturn value;\n```/
  );

  assert.equal(
    formatInlineComment({
      kind: 'human',
      comment: 'The authorization boundary needs a maintainer decision.',
      suggestion: null
    }),
    '**Human review needed:** The authorization boundary needs a maintainer decision.'
  );
});

test('review summaries disclose human-only findings and use a deterministic head marker', () => {
  const body = formatReviewBody(
    'abc123',
    [
      { kind: 'obvious' },
      { kind: 'human' },
      { kind: 'human' }
    ],
    []
  );

  assert.equal(reviewMarker('abc123'), '<!-- lindsey-sync:review:abc123 -->');
  assert.match(body, /1 high-confidence suggestion/);
  assert.match(body, /2 items that need human judgment/);
});
