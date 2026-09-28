# Contributing

Thanks for helping. The most useful contributions are reports of request shapes that Anthropic rejects, and fixes that keep the plugin small.

Before changing login, token handling, headers or request shaping, read [docs/anthropic-subscription-auth.md](docs/anthropic-subscription-auth.md). It records how Anthropic's OAuth flow and classifiers behave, which projects to compare against, and how to investigate failures. Update it in the same pull request when you learn something new.

## Report a rejected request

1. Enable the debug log in your plugin entry: `"options": { "debugLog": "/tmp/claude-subscription.jsonl" }`.
2. Reproduce the error, then find the smallest system text or tool that makes the difference. Removing blocks one at a time works well.
3. Open a [blocked request issue](https://github.com/eysenfalk/opencode-claude-subscription/issues/new?template=blocked-request.yml) with that text. Do not paste whole logs: they contain your prompts.

## Develop

```sh
npm install
npm test          # offline, node --test
npm run typecheck
npm run build
```

Try a checkout in OpenCode by pointing a plugin entry at the directory (remove the npm entry first). OpenCode loads `server.js`, which re-exports `src/index.ts`.

## Guidelines

- Keep request changes minimal and explain why each one is needed, ideally with the bisected trigger.
- Record new or changed Anthropic behavior in `docs/anthropic-subscription-auth.md`, with the date and how you confirmed it.
- Add a test for every request or response transformation.
- Never log headers, tokens or credentials.
- Update `CHANGELOG.md` under "Unreleased".

## Release

Bump `version` in `package.json`, move the "Unreleased" notes into a new version section, commit, then push a matching tag (`git tag v0.2.0 && git push --tags`). The release workflow publishes to npm with provenance and creates the GitHub release.
