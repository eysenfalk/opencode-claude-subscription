# Security policy

This plugin handles Claude OAuth tokens, so please report vulnerabilities privately through [GitHub security advisories](https://github.com/eysenfalk/opencode-claude-subscription/security/advisories/new), not in public issues.

## How tokens are handled

- Tokens from the browser and paste-code logins are stored by OpenCode's credential store, like any other OpenCode login.
- The Claude Code method reads `~/.claude/.credentials.json` (or the macOS Keychain) and never writes to it.
- Tokens are only sent to `platform.claude.com` (login and refresh) and `api.anthropic.com` (model requests).
- The plugin never logs headers, tokens or credentials. The optional `debugLog` records request bodies only, which contain your prompts.

Only the latest release receives fixes.
