# How Anthropic subscription auth works (and how it breaks)

This is the working knowledge behind the plugin: how the Claude Pro/Max OAuth flow works, how Anthropic tells Claude Code apart from other clients, how other projects solve the same problem, and how to investigate when something stops working. Read it before you change login, token handling, headers or request shaping.

Anthropic changes all of this without notice. Every fact below carries the date it was last confirmed and how. When you re-confirm or disprove something, update the entry and its date in the same pull request.

Evidence labels:

- **observed**: reproduced directly (live request, log, test).
- **read**: taken from source code (ours, OpenCode, Claude Code or another project).
- **reported**: stated by another project or issue, not reproduced here.

## Contents

1. [The pieces](#1-the-pieces)
2. [OAuth login and refresh](#2-oauth-login-and-refresh)
3. [The token endpoint answers some clients with 429](#3-the-token-endpoint-answers-some-clients-with-429)
4. [Messages API: looking like Claude Code](#4-messages-api-looking-like-claude-code)
5. [OpenCode v2 plugin mechanics](#5-opencode-v2-plugin-mechanics)
6. [Where to look: reference implementations](#6-where-to-look-reference-implementations)
7. [Investigation playbook](#7-investigation-playbook)
8. [Rules](#8-rules)
9. [Keeping up with Claude Code releases](#9-keeping-up-with-claude-code-releases)

## 1. The pieces

```text
opencode auth login / TUI (Ctrl+A → Anthropic)
        │  login method from this plugin
        ▼
claude.ai/oauth/authorize ──► code ──► token endpoint ──► access + refresh token
                                                   │
                                  OpenCode credential store
                                                   │
OpenCode anthropic provider ── Authorization: Bearer sk-ant-oat… ──► http.request hook
        (this plugin reshapes headers, system prompt, tool names) ──► api.anthropic.com
```

Three login methods exist (`src/oauth.ts`, `src/claude-code.ts`):

| Method ID | Token source | Talks to token endpoint |
|---|---|---|
| `claude-subscription-browser` | own PKCE login, local callback on port 53692 | yes (exchange and refresh) |
| `claude-subscription-manual` | own PKCE login, user pastes `code#state` | yes (exchange and refresh) |
| `claude-subscription-claude-code` | reads Claude Code's stored login | never |

## 2. OAuth login and refresh

| Fact | Value | Evidence |
|---|---|---|
| Client ID | `9d1c250a-e61b-44d9-88ed-5944d1962f5e` (Claude Code's public client) | read: Claude Code 2.1.283, pi, ex-machina |
| Authorize URL | `https://claude.ai/oauth/authorize` with `code=true`, PKCE S256, `state` | observed 2026-09-28 |
| Scopes | `org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload` | read: pi, ex-machina |
| Browser redirect | `http://localhost:53692/callback` is accepted: the callback arrived with a code | observed 2026-09-28 |
| Manual redirect | `https://platform.claude.com/oauth/code/callback` is accepted: claude.ai showed `code#state` with our state | observed 2026-09-28 |
| Token endpoint | `https://platform.claude.com/v1/oauth/token` (Claude Code's `TOKEN_URL`). `https://claude.ai/v1/oauth/token` serves the same grants | read: Claude Code 2.1.283; observed: both answer `invalid_grant` for a fake code |
| Exchange body | JSON, fields in this order: `grant_type`, `code`, `redirect_uri`, `client_id`, `code_verifier`, `state` | read: Claude Code 2.1.283 |
| Refresh body | JSON: `grant_type=refresh_token`, `refresh_token`, `client_id`, `scope` (space-joined) | read: Claude Code 2.1.283 |
| Refresh tokens rotate | A refresh returns a new refresh token; the old one stops working | reported: opencode-claude-auth, ex-machina; this is why the Claude Code method never refreshes |
| Revoke | `POST {TOKEN_URL}/revoke` with `token`, `token_type_hint`, `client_id` | read: Claude Code 2.1.283 |
| Access tokens | start with `sk-ant-oat`; API keys start with `sk-ant-api` | observed |
| Long-lived tokens | `claude setup-token` exists in Claude Code and prints a long-lived token | observed 2026-09-28 (`claude --help`); not yet tested with this plugin |

Claude Code stores its login in `~/.claude/.credentials.json` (`$CLAUDE_CONFIG_DIR` overrides the directory), or in the macOS Keychain entry `Claude Code-credentials`. The shape is `{ "claudeAiOauth": { accessToken, refreshToken, expiresAt, subscriptionType } }` (observed on Linux, 2026-09-28).

## 3. The token endpoint answers some clients with 429

**Symptom:** the browser step succeeds, then the exchange fails with `429 {"error":{"type":"rate_limit_error","message":"Rate limited. Please try again later."}}`, without `Retry-After`. The same happens to refreshes. OpenCode's CLI shows the paste-code variant only as `UnexpectedStatus: 500` (see [section 5](#5-opencode-v2-plugin-mechanics)).

**It is not volume.** On 2026-09-28, one request each against `platform.claude.com` with a fake code (observed):

| Request shape | Result |
|---|---|
| curl, default headers | `429 rate_limit_error`, every time, including the very first request of the day |
| curl with `User-Agent: axios/1.15.2` (alone, or with axios' `Accept`) | `400 invalid_grant`, processed normally |
| Bun `fetch` default headers | `400 invalid_grant` |
| Node `fetch` default headers | `400 invalid_grant` |

Real logins from the plugin with Bun's default headers still got 429 from both hosts (observed 08:39 and 08:53 UTC). So the filter looks at the request shape, and may look harder at requests carrying a real code. ex-machina reports the same: token requests without a Claude-Code-like `User-Agent` got 429 even with a valid code, and they fixed it with headers (their PR #12).

**What we do (`src/oauth.ts`, `TOKEN_HEADERS` in `src/constants.ts`):**

- Send Claude Code's exact request: `Content-Type: application/json`, `Accept: application/json, text/plain, */*`, `User-Agent: axios/<version Claude Code bundles>`, and the same field order.
- Try `platform.claude.com` first, then `claude.ai`.
- On 429 or 5xx, retry up to three rounds over both hosts, 1 s and 2 s apart (a longer `Retry-After` wins, capped at 10 s). The total budget is 30 s for logins and 10 s for refreshes.
- Any other status (400 `invalid_grant`, 401) is final and is not retried.
- Errors name every host's status.

**Open questions:** whether a 429 consumes the authorization code (PI-Desktop#389 reports it does, yet their fix retries with the same code), and which header the filter keys on for real codes. Update this section when you learn more.

## 4. Messages API: looking like Claude Code

Subscription requests to `/v1/messages` that do not look like Claude Code fail with:

> Third-party apps now draw from your extra usage, not your plan limits. Add more at claude.ai/settings/usage and keep going.

(HTTP 400 `invalid_request_error`; older wording: "You're out of extra usage".) What passes today (`src/index.ts`, `src/request.ts`):

| Element | Required shape | Evidence |
|---|---|---|
| Auth | `Authorization: Bearer sk-ant-oat…`, no `x-api-key` | observed |
| Headers | `user-agent: claude-cli/<version> (external, cli)`, `x-app: cli`, `anthropic-dangerous-direct-browser-access: true` | observed; read: pi, ex-machina |
| Betas | `claude-code-20250219`, `oauth-2025-04-20`, merged with the betas OpenCode sends | observed |
| Identity | `You are Claude Code, Anthropic's official CLI for Claude.` as its own first system block | observed; read: pi |
| Tool names | Claude Code's names (`Read`, `Bash`, …) or MCP-shaped `mcp__<server>__<tool>`. Other flat names like `shell` count as third party | reported: pi-claude-code-use; observed that aliases pass |
| OpenCode fingerprints | removed `x-opencode-*`, `x-session-affinity`, `x-session-id`, `x-parent-session-id` headers | precaution, not bisected |

**Known prompt fingerprints.** The classifier also matches system prompt text:

| Fingerprint | Fix | Evidence |
|---|---|---|
| OpenCode's `<env>` block containing `Workspace root folder:` followed by `Is directory a git repo:` | rename the first line to `Workspace root:` (built-in replacement) | observed 2026-09-28 by bisection; removing either line passes |
| `Here is some useful information about the environment you are running in:` | ex-machina rewrites it to `Environment context you are running in:` | reported by ex-machina; not reproduced here, because the rename above already passed |
| Newer models refused for old versions | error `claude_code_version_too_old`; keep `claudeCodeVersion` at or above the latest Claude Code release | reported by ex-machina |

**Fallbacks that work:** `relocateSystem: true` (move all system text except the identity into the first user message) passed the full failing prompt (observed). `billingHeader: true` alone did not (observed). Both together passed.

Tested models: only `claude-haiku-4-5` (2026-09-28). The classifier may treat other models or longer prompts differently.

## 5. OpenCode v2 plugin mechanics

All read from OpenCode 2.0.18 source (`github.com/anomalyco/opencode`, tag `v2.0.18`) unless noted.

- **Credentials:** For the `anthropic` provider, an OAuth credential becomes `authToken`, which means `Authorization: Bearer` (`packages/core/src/model-resolver.ts`, `nativeCredentialSettings`). A key credential becomes `x-api-key`. The plugin moves a `sk-ant-oat` key to bearer auth.
- **Login methods:** `ctx.integration.transform(editor => editor.method.update(...))` on integration `anthropic`. The TUI dialog (Ctrl+A) and `opencode auth login anthropic --method <id>` list the same methods.
- **Refresh:** Core calls our `refresh` when the credential expires within 5 minutes (`packages/core/src/integration.ts`) and stores the result.
- **Errors:** The promise adapter wraps our promises with `Effect.promise`, so a rejected `refresh` or `authorize` becomes a defect, not a typed error. In paste-code mode the CLI shows it as `UnexpectedStatus: 500`, and the real message is only in the server log (`~/.local/share/opencode/log/opencode.log`). That is why refresh keeps the current credential instead of rejecting, and why 401s carry our hint.
- **Hooks:** `session.hook("http.request" | "http.response", cb, { providerID: "anthropic" })` receives a web `Request`/`Response`. `http.response` gets the same `Request` object we set, so a `WeakMap` keyed by it carries per-request state (tool name mapping).
- **Costs:** `ctx.model.transform` can set `cost = []`. After a login switch, call `ctx.model.reload()`.
- **Loading a local directory:** OpenCode resolves `server.(js|ts)` or `index.*` in the package root and ignores `package.json#main`. From npm, it resolves the `./server` export.
- **Installing from npm:** OpenCode installs with `ignoreScripts`, so no build step runs. We ship `src/` and point `./server` at `src/index.ts`, which Bun runs directly. Git installs are blocked by npm 12's default `allow-git=none`.
- **Browser opening:** The CLI only opens `http(s)` URLs, so the Claude Code method returns a `file://` or `keychain://` source that is shown, not opened.
- **`GET /api/model`** may answer before plugins have settled. To check costs, read a session's messages instead: `opencode api --standalone GET /api/session/<id>/message`.

## 6. Where to look: reference implementations

Check that a project had commits in the last weeks before trusting it. As of 2026-09-28:

| Source | What to read | Why |
|---|---|---|
| Claude Code itself (`~/.local/share/claude/versions/<version>`, a Bun binary) | `strings` and search for `grant_type:"authorization_code"`, `TOKEN_URL`, `"axios/"+` | ground truth for token requests, endpoints, axios version |
| [ex-machina-co/opencode-anthropic-auth](https://github.com/ex-machina-co/opencode-anthropic-auth), branches `main` (v1) and `v2/main` (OpenCode v2) | `src/auth.ts`, `src/constants.ts`, `src/transform.ts`, PRs #12, #19, #250, #269 | closest peer: working login, axios headers, prompt fingerprints, version gating |
| [earendil-works/pi](https://github.com/earendil-works/pi) | `packages/ai/src/auth/oauth/anthropic.ts`, `packages/ai/src/api/anthropic-messages.ts` | reference login flow, Claude Code tool names, identity and headers |
| [pi-claude-code-use](https://github.com/ben-vargas/pi-packages/tree/main/packages/pi-claude-code-use) | README, `extensions/index.ts` | minimal-change approach, MCP-shaped tool aliases |
| [vastsa/PI-Desktop](https://github.com/vastsa/PI-Desktop) | `patches/@earendil-works__pi-ai@*.patch`, issue #389 | 429 retry and backoff on the token endpoint |
| [griffinmartin/opencode-claude-auth](https://github.com/griffinmartin/opencode-claude-auth) | `src/transforms.ts`, `src/signing.ts`, `src/refresh-backoff.ts` | billing block signature, system relocation, refresh backoff |
| [anomalyco/opencode](https://github.com/anomalyco/opencode) at the installed tag | `packages/core/src/plugin/provider/openai.ts` (template for OAuth plugins), `model-resolver.ts`, `integration.ts`, `session/model-request.ts` | how v2 calls plugins |
| GitHub code search for the client ID `9d1c250a-e61b-44d9-88ed-5944d1962f5e` | `gh search code "9d1c250a-e61b-44d9-88ed-5944d1962f5e"` | finds new projects that talk to the same endpoints |
| Upstream issues | anomalyco/opencode#18329, vastsa/PI-Desktop#389 | known 429 reports |

## 7. Investigation playbook

### A request fails with "Third-party apps…"

1. Add `"debugLog": "/tmp/claude-subscription.jsonl"` to the plugin options and reproduce once. The log holds request bodies before and after shaping, never headers or tokens.
2. Replay the logged `after` body with `shapeRequest` from `src/index.ts`, one variant per request. Use a cheap model and `max_tokens: 8`. Start with: no tools, no system, only the first system block, all system blocks.
3. Bisect the failing block: halves, then lines. Drop one line at a time until you find the smallest text whose removal makes the request pass.
4. Prefer a meaning-preserving rename over deleting text. Add it to `DEFAULT_SYSTEM_REPLACEMENTS` in `src/constants.ts` with a test, and document it in [section 4](#4-messages-api-looking-like-claude-code).
5. Unblock users meanwhile with `relocateSystem: true`.

### Login or refresh fails with 429

1. Read the error: it names each host's status. The server log has the full message (`grep "Anthropic token request failed" ~/.local/share/opencode/log/opencode.log`).
2. Compare request shapes with a **fake code**, one request per variant, a few seconds apart: see the table in [section 3](#3-the-token-endpoint-answers-some-clients-with-429). `400 invalid_grant` means the shape passes, `429` means it is filtered.
3. Diff our headers and body against Claude Code's current binary ([section 9](#9-keeping-up-with-claude-code-releases)) and against ex-machina's `src/auth.ts`.
4. Only a user can test a real code, because it needs the browser. Ask for one attempt after a change, not a series.

### Testing OpenCode end to end

Use an isolated OpenCode with its own directories, and pass `--standalone` to **every** command:

```sh
T=$(mktemp -d)
export XDG_CONFIG_HOME=$T/config XDG_DATA_HOME=$T/data XDG_STATE_HOME=$T/state XDG_CACHE_HOME=$T/cache
mkdir -p $XDG_CONFIG_HOME/opencode
echo '{ "plugins": ["/path/to/checkout"] }' > $XDG_CONFIG_HOME/opencode/opencode.json
opencode auth login anthropic --method claude-subscription-claude-code --standalone
opencode run --standalone -m anthropic/claude-haiku-4-5 "Reply with exactly: OK"
```

A command without `--standalone` starts a background service with the isolated directories. That service takes the user's managed service port and breaks their normal `opencode` until it is killed. Delete `$T` afterwards: its database holds a copy of the token.

## 8. Rules

Do:

- Keep the Claude Code method read-only. Never refresh or write Claude Code's token: refresh tokens rotate, and a refresh from here logs Claude Code out.
- Mirror Claude Code's current token request exactly (headers, field order, `scope` on refresh), and re-check it when Claude Code updates.
- Keep request changes minimal. Every change to headers, system text or tool names needs a reason in this document and a test.
- Keep failed refreshes non-fatal: return the current credential, back off (30 s), and let Anthropic's 401 carry the hint.
- Close the callback server of an abandoned login before starting a new one, and mark abandoned promises handled.
- Keep costs at zero while a subscription login is active.
- Update the dates and evidence labels here whenever you re-check a fact.

Don't:

- Don't probe the token endpoint in loops or from scripts that retry. One request per variant, spaced out. Plain `curl` is always filtered, so a curl 429 says nothing about the plugin.
- Don't send an authorization code to two hosts at once, and don't retry a code on a definitive error (`invalid_grant`, 401).
- Don't log headers, tokens, credentials or whole prompts in issues. `debugLog` output contains prompts: share only the smallest triggering phrase.
- Don't claim support for models or flows that were not tested. Update the "Tested with" table in the README instead.
- Don't publish from a local machine when the release workflow can do it. Tags publish with provenance.

## 9. Keeping up with Claude Code releases

When Claude Code updates, check what changed in its token requests and version gating:

```sh
B=$(readlink -f "$(command -v claude)")      # e.g. ~/.local/share/claude/versions/2.1.283
strings -n 4 "$B" > /tmp/cc.strings
grep -o 'TOKEN_URL:"[^"]*"' /tmp/cc.strings | sort -u
python3 - <<'EOF'
import re
s = open("/tmp/cc.strings", errors="ignore").read()
i = s.find('grant_type:"authorization_code",code:')
print(s[i-200:i+600])                          # exchange request and headers
for m in re.finditer(r'"axios/"\+(\w+)', s):
    v = re.search(r'\b' + m.group(1) + r'="(\d+\.\d+\.\d+)"', s)
    print("axios", v.group(1) if v else "?")   # value for TOKEN_HEADERS User-Agent
EOF
```

Then update `CLAUDE_CODE_VERSION` and `TOKEN_HEADERS` in `src/constants.ts`, run the tests, and record the new values and date in sections [2](#2-oauth-login-and-refresh) and [3](#3-the-token-endpoint-answers-some-clients-with-429).
