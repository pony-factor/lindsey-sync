# Lindsey Sync

Lindsey Sync is a small hosted GitHub App for a maintainer-style pull-request workflow. When its configured reviewer identity is requested on a pull request targeting `main`, it first brings the branch up to date with `main` when GitHub can do so safely, then performs a focused automated code review.

The review is intentionally quiet: it posts only concrete findings. A clean pull request gets no review comment, so when Lindsey's only work was syncing the branch, the visible result is just GitHub's sync commit.

## Behavior

On a native GitHub `pull_request.review_requested` webhook:

1. Ignore the event unless the requested reviewer login or requested team matches Lindsey's configured reviewer identity.
2. Ignore pull requests whose base branch is not `main`.
3. Ask GitHub whether the pull request can merge cleanly with `main`.
4. If the branch is behind and has no merge conflicts, call GitHub's standard **Update pull request branch** endpoint using the current head SHA and wait briefly for the new head.
5. If GitHub reports a merge conflict, post one deduplicated PR conversation comment:
   > I can't sync this branch to `main` because it currently conflicts with `main`. No changes were made.
6. Review the current pull-request diff with the configured OpenAI model.
7. Submit one GitHub review only when there are concrete findings:
   - **Obvious fixes** are high-confidence, local changes and appear as inline GitHub suggestion blocks.
   - **Human review needed** comments identify real concerns where the correct fix depends on product, architecture, security, or repository context.
8. If the model finds nothing concrete, post nothing.

Reviews are deduplicated by pull-request head SHA, so re-requesting a review without changing the branch does not repeat the same review submission.

Lindsey never approves a review, requests changes, merges the pull request, force-pushes, rewrites history, resolves conflicts itself, or edits PR files. Repository content is treated as untrusted input to the reviewer.

## GitHub App setup

Create a GitHub App named **Lindsey Sync** and set its webhook URL to:

```
https://YOUR-HOST/webhook
```

Subscribe to the **Pull request** event.

Repository permissions:

- **Contents: Read & write** — GitHub requires content write access to the head repository when an App updates a PR branch.
- **Pull requests: Read & write** — required to update branches, read diffs, and submit inline reviews.
- **Issues: Read & write** — pull request conversation comments use the issue-comments API.
- **Metadata: Read-only** — included automatically by GitHub Apps.

Install the app on every repository whose pull requests it should review. For a forked pull request, the app also needs permission to write the head repository or GitHub will reject the update-branch request.

## Environment

Required for GitHub App authentication:

```sh
GITHUB_APP_ID=123456
GITHUB_PRIVATE_KEY='-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----'
GITHUB_WEBHOOK_SECRET='a-long-random-secret'
```

Choose at least one native review-request trigger:

```sh
CODEX_REVIEWER_LOGIN='codex-bot[bot]'
# or
CODEX_REVIEWER_TEAM='codex-bot'
```

Enable automated code review:

```sh
OPENAI_API_KEY='...'
```

Optional review and server settings:

```sh
OPENAI_MODEL='gpt-5.3-codex'
HOST=0.0.0.0
PORT=8788
```

If `OPENAI_API_KEY` is omitted, Lindsey still performs safe branch syncing but returns `review-unconfigured` instead of calling a model or posting a review. The private key can contain literal newlines or escaped `\n` sequences.

## Review contract

The model receives the pull-request title, body, and GitHub patches for changed text files. The prompt explicitly treats all repository and pull-request content as untrusted data.

A model finding is accepted only when it points to a real added or modified right-side line in GitHub's patch. Invalid or invented file/line locations are discarded before anything is posted.

Lindsey asks the model to classify findings into two groups:

- `obvious` — a concrete issue with a safe, exact replacement for the targeted line. Lindsey posts it as a GitHub `suggestion` block.
- `human` — a concrete issue that requires maintainer judgment. Lindsey posts the concern inline without pretending there is a mechanical fix.

If GitHub does not provide patch text for a changed file, Lindsey does not invent findings for that file.

## Run

```sh
npm test
npm start
```

Health check:

```
GET /health
```

## Docker

```sh
docker build -t lindsey-sync .
docker run --rm -p 8788:8788 \
  -e GITHUB_APP_ID \
  -e GITHUB_PRIVATE_KEY \
  -e GITHUB_WEBHOOK_SECRET \
  -e CODEX_REVIEWER_LOGIN \
  -e OPENAI_API_KEY \
  lindsey-sync
```

Terminate TLS at the hosting platform or reverse proxy and point the GitHub App webhook at the public HTTPS `/webhook` endpoint.


## Commit staged changes as Lindsey Pony

The same hosted service can also publish a commit directly onto an existing feature
branch, using the **Lindsey Pony** GitHub App installation identity. This is separate
from the PR-review webhook: it does not open a PR, merge anything, or change reviewer behavior.

Set the **Lindsey Pony App's own avatar** in GitHub App settings. Its installation must
have **Contents: Read & write** on each repository it will commit to. The commit is
authored as the App bot and normally signed by GitHub, rather than using a local
Git author email. The public App name/avatar are independent of this service's code.

Configure the hosted Lindsey Sync service with these additional variables:

```sh
LINDSEY_COMMIT_INSTALLATION_ID='the-Lindsey-App-installation-ID'
LINDSEY_COMMIT_REPOSITORIES='pony-factor/lindsey-sync,pony-factor/other-project'
LINDSEY_COMMIT_SECRET='a-long-independent-random-secret'
```

Keep the App ID, private key, installation ID and allowlist **only on the server**.
The commit secret authorizes write access to the listed repositories; do not check
it into any repository. Use HTTPS for the hosted API and do not expose it without
authentication. The normal `/webhook` HMAC secret is separate.

In the local VS Code terminal, in **the repository you are developing**, configure
the endpoint and matching commit secret:

```sh
export LINDSEY_COMMIT_URL='https://YOUR-HOST/commit'
export LINDSEY_COMMIT_SECRET='the-same-independent-random-secret'
git add your-changed-files
node /path/to/lindsey-sync/scripts/commit-as-lindsey.js \
  -m '🔩 Commit changes as Lindsey Pony' \
  -b 'Describe the specific branch changes.'
```

You can wire the exact CLI command into an existing Codex/Sweetie Bot commit action.
It reads **only staged index changes**, preserves the commit title/body, adds the
required Codex Web coauthor trailer, and asks the Lindsey service to create the
commit with GraphQL `createCommitOnBranch`. GitHub's `expectedHeadOid` rejects
stale branch updates. After successful publication, the CLI fetches the new head
and synchronizes local HEAD/index with `git reset --mixed`, preserving unstaged
working-tree content. If local state changed concurrently, it declines to reset
and prints the created commit link for manual reconciliation.

**Restrictions:** the branch must already exist on `origin`, local HEAD must
match the remote branch, and committing directly to `main`/`master` is refused.
No force push or history rewrite is performed. Ordinary staged files, renames
(as add/delete), and deletions are supported; GitHub's signed-commit GraphQL
mutation cannot preserve executable mode, symlinks, or submodules, so the CLI
explicitly rejects those changes rather than corrupting their modes. Branch
protection and App installation permissions still apply. The service cannot
access unstaged files or the user's local disk; only the selected staged contents
are transmitted.
