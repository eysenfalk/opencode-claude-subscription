import assert from "node:assert/strict"
import { test } from "node:test"
import { IDENTITY } from "../src/constants.ts"
import { parseOptions } from "../src/options.ts"
import { transformBody, type MessagesBody } from "../src/request.ts"
import { buildToolNames, mcpAlias } from "../src/tools.ts"

const options = parseOptions({}, {})

function body(): MessagesBody {
  return {
    model: "claude-opus-4-7",
    system: [{ type: "text", text: "Project rules", cache_control: { type: "ephemeral" } }],
    tools: [
      { name: "read", input_schema: {} },
      { name: "bash", input_schema: {} },
      { name: "apply_patch", input_schema: {} },
      { name: "mcp__github__search", input_schema: {} },
      { type: "web_search_20250305", name: "web_search" },
    ],
    tool_choice: { type: "tool", name: "apply_patch" },
    messages: [
      { role: "user", content: "hi" },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "read", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
    ],
  }
}

test("identity becomes its own first system block and keeps existing blocks intact", () => {
  const input = body()
  transformBody(input, options)
  assert.deepEqual(input.system, [
    { type: "text", text: IDENTITY },
    { type: "text", text: "Project rules", cache_control: { type: "ephemeral" } },
  ])
})

test("an identity prefix already merged into a block is split out, not duplicated", () => {
  const input = { ...body(), system: `${IDENTITY}\n\nRules` }
  transformBody(input, options)
  assert.deepEqual(input.system, [
    { type: "text", text: IDENTITY },
    { type: "text", text: "Rules" },
  ])
})

test("tools use Claude Code names, MCP aliases for the rest, and server tools stay untouched", () => {
  const input = body()
  const names = transformBody(input, options)
  assert.deepEqual(
    input.tools!.map((tool) => tool.name),
    ["Read", "Bash", "mcp__opencode__apply_patch", "mcp__github__search", "web_search"],
  )
  assert.equal(input.tool_choice!.name, "mcp__opencode__apply_patch")
  const history = input.messages![1].content as Array<{ name: string }>
  assert.equal(history[0].name, "Read")
  assert.equal(names.fromWire.get("mcp__opencode__apply_patch"), "apply_patch")
  assert.equal(names.fromWire.get("Read"), "read")
})

test("history tool calls to tools that are no longer offered are still renamed consistently", () => {
  const input = body()
  input.tools = []
  transformBody(input, options)
  const history = input.messages![1].content as Array<{ name: string }>
  assert.equal(history[0].name, "Read")
})

test("colliding names fall back to distinct aliases", () => {
  const names = buildToolNames(["Read", "read"])
  assert.equal(names.toWire.get("Read"), "Read")
  assert.equal(names.toWire.get("read"), "mcp__opencode__read")
})

test("user aliases win over derived names", () => {
  const names = buildToolNames(["apply_patch"], { apply_patch: "mcp__patch__apply" })
  assert.equal(names.toWire.get("apply_patch"), "mcp__patch__apply")
})

test("long aliases stay within the tool name limit and remain unique", () => {
  const a = mcpAlias("x".repeat(100) + "a")
  const b = mcpAlias("x".repeat(100) + "b")
  assert.ok(a.length <= 64)
  assert.notEqual(a, b)
})

test("relocateSystem moves prompt text into the first user message", () => {
  const input = body()
  transformBody(input, parseOptions({ relocateSystem: true }, {}))
  assert.deepEqual(input.system, [{ type: "text", text: IDENTITY }])
  const first = input.messages![0].content as Array<{ text: string }>
  assert.match(first[0].text, /Project rules/)
  assert.equal(first[1].text, "hi")
})

test("billingHeader prepends exactly one signed block", () => {
  const input = body()
  transformBody(input, parseOptions({ billingHeader: true }, {}))
  transformBody(input, parseOptions({ billingHeader: true }, {}))
  const system = input.system as Array<{ text: string }>
  assert.equal(system.filter((block) => block.text.startsWith("x-anthropic-billing-header")).length, 1)
  assert.match(system[0].text, /^x-anthropic-billing-header: cc_version=2\.1\.280\.[0-9a-f]{3}; cc_entrypoint=cli; cch=[0-9a-f]{5};$/)
  assert.equal(system[1].text, IDENTITY)
})

test("systemReplacements rewrite prompt text only", () => {
  const input = body()
  transformBody(input, parseOptions({ systemReplacements: [["Project", "Repo"]] }, {}))
  assert.equal((input.system as Array<{ text: string }>)[1].text, "Repo rules")
  assert.equal(input.messages![0].content, "hi")
})

test("the fingerprinted OpenCode env line is renamed by default", () => {
  const input = { ...body(), system: "<env>\n  Workspace root folder: /x\n  Is directory a git repo: yes\n</env>" }
  transformBody(input, options)
  assert.equal((input.system as unknown as Array<{ text: string }>)[1].text, "<env>\n  Workspace root: /x\n  Is directory a git repo: yes\n</env>")
})
