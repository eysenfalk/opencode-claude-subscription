# opencode-claude-subscription

Use your Claude Pro/Max subscription with OpenCode v2's built-in `anthropic` provider.

The plugin adds subscription login methods to the Anthropic integration and shapes requests the way the subscription endpoint expects. It does not replace the provider, the transport, or the model list. API-key usage is left untouched.

> [!WARNING]
> Anthropic's consumer terms restrict subscription OAuth tokens to Anthropic's own apps, and Anthropic actively detects and bills or blocks third-party clients. Using this plugin can get requests rejected, charged as extra usage, or your account restricted. Use it at your own risk.

## Requirements

- OpenCode 2.0.16 or newer
- A Claude Pro or Max subscription

## Install

```sh
opencode plugin add opencode-claude-subscription
opencode auth login anthropic
```

`opencode plugin add` installs the plugin from npm and adds it to your global config (`~/.config/opencode/opencode.json`). Restart OpenCode afterwards, or run `opencode service restart` if you use the background service.

To update or remove it:

```sh
opencode plugin update opencode-claude-subscription
opencode plugin remove opencode-claude-subscription
```

Pick one of the methods the plugin adds:

| Method | ID | Notes |
|---|---|---|
| Claude Pro/Max subscription (browser) | `claude-subscription-browser` | PKCE login with a local callback on port 53692. OpenCode stores and refreshes the tokens. |
| Claude Pro/Max subscription (paste code) | `claude-subscription-manual` | For remote or headless machines: authorize anywhere, paste the code. |
| Claude Code login on this machine (read-only) | `claude-subscription-claude-code` | Reuses Claude Code's stored login (`~/.claude/.credentials.json`, or the macOS Keychain). |

The Claude Code method never refreshes the token itself, because Anthropic rotates refresh tokens and refreshing from OpenCode would log Claude Code out. Claude Code has to run now and then to keep the token fresh. For unattended use, prefer one of the first two methods: they get their own token chain.

## What it changes

Only requests authenticated with a subscription token (`sk-ant-oat…`) are touched. API keys pass through unchanged.

- **Headers:** Claude Code's `user-agent` and `x-app`, plus the `claude-code-20250219` and `oauth-2025-04-20` betas, merged with the betas OpenCode already sends. OpenCode's `x-opencode-*` and session-affinity headers are removed. A subscription token stored as an API key is moved to bearer auth.
- **System prompt:** Claude Code's identity line becomes its own first system block. The rest of OpenCode's system prompt stays in place, including cache breakpoints.
- **Tool names:** tools that match a Claude Code tool keep its exact name (`read` → `Read`, `webfetch` → `WebFetch`). Every other flat tool becomes an MCP-shaped alias (`shell` → `mcp__opencode__shell`). Tool definitions, `tool_choice`, and tool calls in the history are renamed consistently. Tool calls in the response stream are translated back, so OpenCode only ever sees its own names.
- **Env block:** OpenCode's `<env>` block is classified as third-party usage when "Workspace root folder:" appears together with "Is directory a git repo:". The plugin renames the first line to "Workspace root:".

## Options

```jsonc
{
  "plugins": [
    {
      "package": "opencode-claude-subscription",
      "options": {
        "toolAliases": { "apply_patch": "mcp__patch__apply" },
        "systemReplacements": [["some phrase", "replacement"]],
        "relocateSystem": false,
        "billingHeader": false,
        "claudeCodeVersion": "2.1.280",
        "debugLog": "/tmp/claude-subscription.jsonl"
      }
    }
  ]
}
```

| Option | Env var | Default | Effect |
|---|---|---|---|
| `toolAliases` | | `{}` | Explicit wire names for flat tools. Use `mcp__<server>__<tool>` names. |
| `systemReplacements` | | `[]` | Literal replacements in system prompt text, applied after the built-in one. |
| `relocateSystem` | `OPENCODE_CLAUDE_SUBSCRIPTION_RELOCATE_SYSTEM=1` | `false` | Moves all system text except the identity line into the first user message. This is the most robust fallback if Anthropic starts rejecting new prompt content, but it weakens prompt caching. |
| `billingHeader` | `OPENCODE_CLAUDE_SUBSCRIPTION_BILLING_HEADER=1` | `false` | Adds Claude Code's signed billing block as the first system entry. |
| `claudeCodeVersion` | `OPENCODE_CLAUDE_SUBSCRIPTION_CC_VERSION` | `2.1.280` | Version used in the user agent and the billing block. |
| `debugLog` | `OPENCODE_CLAUDE_SUBSCRIPTION_DEBUG_LOG` | unset | Appends each request body before and after shaping as JSON lines. Headers and tokens are never logged, but the log contains your prompts. |

## Troubleshooting

**"Third-party apps now draw from your extra usage…"**: Anthropic classified the request as third-party. Set `debugLog`, reproduce the error, and check which system text or tool differs from the last working request. Setting `relocateSystem: true` usually unblocks you right away. Please open an issue with the phrase that triggers it, or add it to `systemReplacements`.

**Login fails with "Port 53692 is in use"**: use the paste-code method.

**"The Claude Code login has expired"**: run `claude` once, or switch to one of the subscription login methods.

## Development

```sh
npm install
npm test        # node --test, no network
npm run typecheck
npm run build
```

To try a checkout locally, remove the npm package first, then point OpenCode at the directory. If both are configured, the plugin loads twice and every login method shows up twice.

```sh
opencode plugin remove opencode-claude-subscription
```

```jsonc
{ "plugins": ["/path/to/opencode-claude-subscription"] }
```

OpenCode loads `server.js` from the package root, which re-exports `src/index.ts`, so no build is needed.

## Credits

- [pi-claude-code-use](https://github.com/ben-vargas/pi-packages/tree/main/packages/pi-claude-code-use) (MIT): the approach of changing as little as possible and using MCP-shaped tool aliases.
- [opencode-claude-auth](https://github.com/griffinmartin/opencode-claude-auth) (MIT): the billing block signature (`src/billing.ts`) and the system relocation fallback.
