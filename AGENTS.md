# Agent instructions

OpenCode v2 plugin that lets the built-in `anthropic` provider use a Claude Pro/Max subscription. Entry point: `src/index.ts`. OpenCode loads `server.js`, which re-exports it.

## Read first

- [docs/anthropic-subscription-auth.md](docs/anthropic-subscription-auth.md) covers how the OAuth flow, the token endpoint filter and the Messages API classifier work, which projects to compare against, and how to investigate failures. Read it before touching login, token handling, headers or request shaping, and update it in the same change when you learn something new.
- [CONTRIBUTING.md](CONTRIBUTING.md) covers the release process and pull request expectations.

## Commands

```sh
npm install
npm test            # node --test, offline
npm run typecheck
npm run build       # dist/ for the "." export; OpenCode itself runs src/
```

CI (`.github/workflows/ci.yml`) runs the same checks on Node 26 and loads `server.js` with Bun.

## Rules

- Every request or response transformation needs a test in `test/`.
- Never log or print headers, tokens or credential files. Never paste `~/.claude/.credentials.json` contents anywhere.
- Never refresh or write Claude Code's stored login; the Claude Code method is read-only.
- Live requests against Anthropic cost the user's quota and can get their account flagged. Use one request per variant, with a cheap model and `max_tokens: 8`, and never in retry loops.
- For end-to-end tests, use an isolated OpenCode and pass `--standalone` to every command (see the playbook in the docs). A non-standalone command starts a background service that breaks the user's OpenCode.
- Only a user can complete a browser login. Ask for a single attempt after a change.
- Releases go through tags and `.github/workflows/release.yml`. Don't publish to npm by hand, and don't tag or push without the maintainer's approval.
