# Lindsey Sync

Lindsey Sync is a small hosted GitHub App that handles one maintainer-style review task: when its configured reviewer identity is requested on a pull request targeting `main`, it tries to bring the pull request branch up to date with `main`.

It deliberately does **nothing else**.

## Behavior

On a native GitHub `pull_request.review_requested` webhook:

1. Ignore the event unless the requested reviewer login or requested team matches this app's configured Codex reviewer identity.
2. Ignore pull requests whose base branch is not `main`.
3. Ask GitHub whether the pull request can merge cleanly with `main`.
4. If the branch is behind and has no merge conflicts, call GitHub's standard **Update pull request branch** endpoint using the current head SHA.
5. If GitHub reports a merge conflict, post one PR conversation comment:
   > I can't sync this branch to `main` because it currently conflicts with `main`. No changes were made.
6. Stop.

The bot never approves a review, requests changes, merges the pull request, force-pushes, rewrites history, resolves conflicts, edits files, or changes PR metadata. If the branch is already current, it exits without commenting.

GitHub's review-request model targets users and teams. Configure either a dedicated reviewable bot login with `CODEX_REVIEWER_LOGIN` or a dedicated team such as `codex-bot` with `CODEX_REVIEWER_TEAM`. The team option is useful when the GitHub App's bot identity is not offered directly in the repository's reviewer picker.

## GitHub App setup

Create a GitHub App named **Lindsey Sync** and set its webhook URL to:

```
https://YOUR-HOST/webhook
```

Subscribe to the **Pull request** event.

Repository permissions:

- **Contents: Read & write** — GitHub requires content write access to the head repository when an App updates a PR branch.
- **Pull requests: Read & write** — required by the update-branch endpoint and to read PR state.
- **Issues: Read & write** — pull request conversation comments use the issue-comments API.
- **Metadata: Read-only** — included automatically by GitHub Apps.

Install the app on every repository whose pull request branches it should update. For a forked pull request, the app also needs permission to write the head repository or GitHub will reject the update.

## Environment

Required:

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

Optional server settings:

```sh
HOST=0.0.0.0
PORT=8788
```

The private key can contain literal newlines or escaped `\n` sequences.

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
  lindsey-sync
```

Terminate TLS at the hosting platform or reverse proxy and point the GitHub App webhook at the public HTTPS `/webhook` endpoint.
