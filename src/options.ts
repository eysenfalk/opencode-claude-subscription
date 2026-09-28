import { CLAUDE_CODE_VERSION, DEFAULT_SYSTEM_REPLACEMENTS } from "./constants.ts"

export interface Options {
  /** Explicit wire names for flat tools, e.g. `{ "apply_patch": "mcp__opencode__patch" }`. */
  readonly toolAliases: Readonly<Record<string, string>>
  /** Literal replacements applied to system prompt text, in order, after the built-in ones. */
  readonly systemReplacements: ReadonlyArray<readonly [string, string]>
  /** Move all non-identity system text into the first user message. */
  readonly relocateSystem: boolean
  /** Add Claude Code's signed billing block as the first system entry. */
  readonly billingHeader: boolean
  readonly claudeCodeVersion: string
  /** Append before/after request bodies (never headers or tokens) as JSON lines to this file. */
  readonly debugLog?: string
}

export function parseOptions(raw: Readonly<Record<string, unknown>> | undefined, env = process.env): Options {
  const input = raw ?? {}
  return {
    toolAliases: record(input.toolAliases),
    systemReplacements: [...DEFAULT_SYSTEM_REPLACEMENTS, ...pairs(input.systemReplacements)],
    relocateSystem: flag(input.relocateSystem, env.OPENCODE_CLAUDE_SUBSCRIPTION_RELOCATE_SYSTEM),
    billingHeader: flag(input.billingHeader, env.OPENCODE_CLAUDE_SUBSCRIPTION_BILLING_HEADER),
    claudeCodeVersion: string(input.claudeCodeVersion) ?? env.OPENCODE_CLAUDE_SUBSCRIPTION_CC_VERSION ?? CLAUDE_CODE_VERSION,
    debugLog: string(input.debugLog) ?? env.OPENCODE_CLAUDE_SUBSCRIPTION_DEBUG_LOG,
  }
}

function flag(value: unknown, env: string | undefined) {
  if (typeof value === "boolean") return value
  return env === "1" || env === "true"
}

function string(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function record(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  )
}

function pairs(value: unknown): Array<[string, string]> {
  if (!Array.isArray(value)) return []
  return value.filter(
    (entry): entry is [string, string] =>
      Array.isArray(entry) && entry.length === 2 && typeof entry[0] === "string" && typeof entry[1] === "string",
  )
}
