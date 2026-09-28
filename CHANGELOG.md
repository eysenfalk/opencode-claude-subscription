# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.2] - 2026-09-28

### Added
- Anthropic models show zero per-token cost while a subscription login is active.
- A 401 on a subscription request explains the next step (log in again, or run `claude`).

### Fixed
- Starting a browser login closes the callback server of an abandoned attempt, so a retry no longer fails with "Port 53692 is in use" for up to ten minutes.
- An abandoned browser login no longer leaves an unhandled promise rejection behind.
- A failed token refresh keeps the current credential and retries after 30 seconds instead of surfacing as an unexpected OpenCode error.
- The Claude Code login re-reads the stored token on refresh even when it is expired, instead of failing the request.
- The Claude Code login no longer opens a web page; it shows the credential source.
- `/v1/messages/count_tokens` requests are shaped like `/v1/messages`.

### Changed
- README and SECURITY.md describe verified models and where tokens are sent more precisely.

## [0.1.1] - 2026-09-28

### Added
- README with quick start, comparison, request flow diagram, FAQ and compatibility table.
- CI (typecheck, offline tests, build, Bun load check) and a tag-driven npm release with provenance.
- Issue templates for blocked requests, compatibility reports and bugs; contributing and security policies.

## [0.1.0] - 2026-09-28

### Added
- Login methods for the OpenCode v2 `anthropic` integration: browser (PKCE), paste code, and read-only reuse of the Claude Code login.
- Request shaping for subscription tokens: Claude Code identity block, headers and betas; Claude Code tool names and `mcp__opencode__*` aliases, translated back in streamed and JSON responses.
- Built-in rename of OpenCode's "Workspace root folder:" env line, which Anthropic classified as third-party usage.
- Opt-in `relocateSystem`, `billingHeader`, `toolAliases`, `systemReplacements` and `debugLog` options.

[Unreleased]: https://github.com/eysenfalk/opencode-claude-subscription/compare/v0.1.2...HEAD
[0.1.2]: https://github.com/eysenfalk/opencode-claude-subscription/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/eysenfalk/opencode-claude-subscription/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/eysenfalk/opencode-claude-subscription/releases/tag/v0.1.0
