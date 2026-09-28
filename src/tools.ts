import { createHash } from "node:crypto"
import { ALIAS_SERVER, CLAUDE_CODE_TOOLS, MAX_TOOL_NAME } from "./constants.ts"

const claudeCode = new Map(CLAUDE_CODE_TOOLS.map((name) => [name.toLowerCase(), name]))

/**
 * Bidirectional mapping between OpenCode tool names and the names sent to Anthropic.
 *
 * The subscription endpoint accepts Claude Code's own tool names and MCP-shaped names
 * (`mcp__<server>__<tool>`), but classifies other flat names as third-party usage.
 */
export interface ToolNames {
  readonly toWire: ReadonlyMap<string, string>
  readonly fromWire: ReadonlyMap<string, string>
}

export function buildToolNames(names: Iterable<string>, aliases: Readonly<Record<string, string>> = {}): ToolNames {
  const toWire = new Map<string, string>()
  const fromWire = new Map<string, string>()
  const assign = (name: string, wire: string) => {
    toWire.set(name, wire)
    fromWire.set(wire, name)
  }
  const sorted = [...new Set(names)].sort()

  // Names that already look native keep their exact spelling and win any collision.
  for (const name of sorted) if (name.startsWith("mcp__")) assign(name, name)
  for (const name of sorted) {
    if (toWire.has(name)) continue
    const alias = aliases[name]
    if (alias && !fromWire.has(alias)) assign(name, alias)
  }
  for (const name of sorted) {
    if (toWire.has(name)) continue
    const native = claudeCode.get(name.toLowerCase())
    if (native && !fromWire.has(native)) assign(name, native)
  }
  for (const name of sorted) {
    if (toWire.has(name)) continue
    let wire = mcpAlias(name)
    for (let n = 2; fromWire.has(wire); n++) wire = mcpAlias(name, `_${n}`)
    assign(name, wire)
  }
  return { toWire, fromWire }
}

export function mcpAlias(name: string, suffix = "") {
  const prefix = `mcp__${ALIAS_SERVER}__`
  const tool = name.replace(/[^a-zA-Z0-9_-]/g, "_") || "tool"
  const full = prefix + tool + suffix
  if (full.length <= MAX_TOOL_NAME) return full
  const hash = createHash("sha256").update(name).digest("hex").slice(0, 8)
  return prefix + tool.slice(0, MAX_TOOL_NAME - prefix.length - hash.length - suffix.length - 1) + "_" + hash + suffix
}
