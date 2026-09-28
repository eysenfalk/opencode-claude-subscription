# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

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

[Unreleased]: https://github.com/eysenfalk/opencode-claude-subscription/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/eysenfalk/opencode-claude-subscription/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/eysenfalk/opencode-claude-subscription/releases/tag/v0.1.0
