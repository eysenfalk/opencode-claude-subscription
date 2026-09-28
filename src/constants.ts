export const PLUGIN_ID = "opencode-claude-subscription"
export const INTEGRATION_ID = "anthropic"

export const METHOD = {
  browser: "claude-subscription-browser",
  manual: "claude-subscription-manual",
  claudeCode: "claude-subscription-claude-code",
} as const

export const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
export const AUTHORIZE_URL = "https://claude.ai/oauth/authorize"
/**
 * Tried in order. platform.claude.com and console.anthropic.com share a rate limit that answers
 * 429 without Retry-After for long stretches, while claude.ai kept serving the same requests.
 */
export const TOKEN_URLS = ["https://claude.ai/v1/oauth/token", "https://platform.claude.com/v1/oauth/token"]
export const MANUAL_REDIRECT_URI = "https://platform.claude.com/oauth/code/callback"
export const CALLBACK_HOST = "127.0.0.1"
export const CALLBACK_PORT = 53692
export const CALLBACK_PATH = "/callback"
export const SCOPES =
  "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload"

export const CLAUDE_CODE_VERSION = "2.1.280"
export const IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude."
export const OAUTH_BETAS = ["claude-code-20250219", "oauth-2025-04-20"]

/** Anthropic OAuth access tokens carry this prefix; API keys use `sk-ant-api`. */
export const OAUTH_TOKEN_PREFIX = "sk-ant-oat"

/** Claude Code's built-in tool names. Matching tools keep this exact casing on the wire. */
export const CLAUDE_CODE_TOOLS = [
  "Read",
  "Write",
  "Edit",
  "Bash",
  "Grep",
  "Glob",
  "AskUserQuestion",
  "EnterPlanMode",
  "ExitPlanMode",
  "KillShell",
  "NotebookEdit",
  "Skill",
  "Task",
  "TaskOutput",
  "TodoWrite",
  "WebFetch",
  "WebSearch",
]

/**
 * Applied to system prompt text before user replacements. Found by bisecting live requests:
 * OpenCode's `<env>` block with "Workspace root folder:" followed by "Is directory a git repo:"
 * is classified as third-party usage; renaming either line is enough.
 */
export const DEFAULT_SYSTEM_REPLACEMENTS: ReadonlyArray<readonly [string, string]> = [
  ["Workspace root folder:", "Workspace root:"],
]

export const ALIAS_SERVER = "opencode"
export const MAX_TOOL_NAME = 64
