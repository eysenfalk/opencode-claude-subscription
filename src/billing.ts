import { createHash } from "node:crypto"

// Ported from opencode-claude-auth (MIT), which reverse-engineered Claude Code's billing block.
const SALT = "59cf53e54c78"
export const BILLING_PREFIX = "x-anthropic-billing-header"

type Message = { role?: unknown; content?: unknown }

export function billingBlock(messages: ReadonlyArray<Message>, version: string, entrypoint = "cli") {
  const text = firstUserText(messages)
  const sampled = [4, 7, 20].map((i) => text[i] ?? "0").join("")
  const suffix = sha256(`${SALT}${sampled}${version}`).slice(0, 3)
  return `${BILLING_PREFIX}: cc_version=${version}.${suffix}; cc_entrypoint=${entrypoint}; cch=${sha256(text).slice(0, 5)};`
}

function firstUserText(messages: ReadonlyArray<Message>) {
  const content = messages.find((message) => message.role === "user")?.content
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  const block = content.find((item) => item?.type === "text" && typeof item.text === "string")
  return block ? (block.text as string) : ""
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex")
}
