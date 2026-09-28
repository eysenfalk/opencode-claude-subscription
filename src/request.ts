import { BILLING_PREFIX, billingBlock } from "./billing.ts"
import { IDENTITY } from "./constants.ts"
import type { Options } from "./options.ts"
import { buildToolNames, type ToolNames } from "./tools.ts"

type Block = Record<string, unknown> & { type?: unknown; text?: unknown }
type Message = { role?: unknown; content?: unknown } & Record<string, unknown>
type Tool = Record<string, unknown> & { name?: unknown; type?: unknown }

export interface MessagesBody extends Record<string, unknown> {
  system?: string | Block[]
  messages?: Message[]
  tools?: Tool[]
  tool_choice?: Record<string, unknown>
}

/**
 * Shapes an Anthropic Messages request so the subscription endpoint accepts it:
 * Claude Code identity as its own first system block, and tool names Claude Code would send.
 * Returns the tool mapping needed to translate the response back.
 */
export function transformBody(body: MessagesBody, options: Options): ToolNames {
  body.system = shapeSystem(body.system, options)
  const names = buildToolNames(collectToolNames(body), options.toolAliases)
  const wire = (name: unknown) => (typeof name === "string" ? (names.toWire.get(name) ?? name) : name)

  if (Array.isArray(body.tools))
    for (const tool of body.tools) if (isCustomTool(tool)) tool.name = wire(tool.name)
  if (body.tool_choice?.type === "tool") body.tool_choice.name = wire(body.tool_choice.name)
  for (const block of contentBlocks(body.messages)) if (block.type === "tool_use") block.name = wire(block.name)

  if (options.relocateSystem) relocateSystem(body)
  if (options.billingHeader) {
    const system = body.system as Block[]
    system.unshift({ type: "text", text: billingBlock(body.messages ?? [], options.claudeCodeVersion) })
  }
  return names
}

function shapeSystem(system: MessagesBody["system"], options: Options): Block[] {
  const blocks: Block[] =
    typeof system === "string" ? [{ type: "text", text: system }] : Array.isArray(system) ? [...system] : []
  const rest: Block[] = []
  for (const block of blocks) {
    if (block.type !== "text" || typeof block.text !== "string") {
      rest.push(block)
      continue
    }
    if (block.text.startsWith(BILLING_PREFIX)) continue
    let text = block.text.startsWith(IDENTITY) ? block.text.slice(IDENTITY.length).replace(/^\s+/, "") : block.text
    for (const [from, to] of options.systemReplacements) text = text.split(from).join(to)
    if (text) rest.push({ ...block, text })
  }
  return [{ type: "text", text: IDENTITY }, ...rest]
}

function relocateSystem(body: MessagesBody) {
  const system = body.system as Block[]
  const moved = system.slice(1).filter((block) => block.type === "text" && typeof block.text === "string")
  const first = body.messages?.find((message) => message.role === "user")
  if (!first || moved.length === 0) return
  body.system = system.filter((block) => !moved.includes(block))
  const text = moved.map((block) => block.text as string).join("\n\n")
  const prefix: Block = { type: "text", text: `<system-reminder>\n${text}\n</system-reminder>` }
  first.content =
    typeof first.content === "string"
      ? [prefix, { type: "text", text: first.content }]
      : [prefix, ...(Array.isArray(first.content) ? first.content : [])]
}

function collectToolNames(body: MessagesBody) {
  const names: string[] = []
  for (const tool of body.tools ?? []) if (isCustomTool(tool) && typeof tool.name === "string") names.push(tool.name)
  for (const block of contentBlocks(body.messages))
    if (block.type === "tool_use" && typeof block.name === "string") names.push(block.name)
  return names
}

/** Anthropic server tools (web_search_20250305, …) carry a versioned type and must keep their name. */
function isCustomTool(tool: Tool) {
  return tool.type === undefined || tool.type === "custom"
}

function* contentBlocks(messages: MessagesBody["messages"]): Generator<Block> {
  for (const message of messages ?? [])
    if (Array.isArray(message.content))
      for (const block of message.content) if (block && typeof block === "object") yield block as Block
}
