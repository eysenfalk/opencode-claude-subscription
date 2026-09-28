import assert from "node:assert/strict"
import { test } from "node:test"
import { mergeBetas, oauthToken, shapeRequest } from "../src/index.ts"
import { parseCode } from "../src/oauth.ts"
import { parseOptions } from "../src/options.ts"
import { restoreToolNames, rewriteEvent } from "../src/response.ts"

const options = parseOptions({}, {})
const url = "https://api.anthropic.com/v1/messages"

function request(headers: Record<string, string>) {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ system: "x", tools: [{ name: "apply_patch" }], messages: [{ role: "user", content: "hi" }] }),
  })
}

test("API-key requests pass through untouched", async () => {
  assert.equal(await shapeRequest(request({ "x-api-key": "sk-ant-api03-abc" }), "ses_1", options), undefined)
})

test("subscription requests get Claude Code headers and lose OpenCode fingerprints", async () => {
  const shaped = await shapeRequest(
    request({
      authorization: "Bearer sk-ant-oat01-abc",
      "anthropic-beta": "context-management-2025-06-27",
      "x-opencode-session": "ses_1",
      "x-session-affinity": "ses_1",
      "user-agent": "opencode/2.0.16",
    }),
    "ses_1",
    options,
  )
  assert.ok(shaped)
  const headers = shaped.request.headers
  assert.equal(headers.get("authorization"), "Bearer sk-ant-oat01-abc")
  assert.equal(headers.get("user-agent"), "claude-cli/2.1.280 (external, cli)")
  assert.equal(headers.get("x-app"), "cli")
  assert.equal(headers.get("anthropic-beta"), "claude-code-20250219,oauth-2025-04-20,context-management-2025-06-27")
  assert.equal(headers.get("x-opencode-session"), null)
  assert.equal(headers.get("x-session-affinity"), null)
  assert.match(headers.get("x-claude-code-session-id")!, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/)
  const body = await shaped.request.json()
  assert.equal(body.tools[0].name, "mcp__opencode__apply_patch")
  assert.deepEqual([...shaped.fromWire], [["mcp__opencode__apply_patch", "apply_patch"]])
})

test("an OAuth token stored as an API key is moved to bearer auth", async () => {
  const shaped = await shapeRequest(request({ "x-api-key": "sk-ant-oat01-abc" }), "ses_1", options)
  assert.equal(shaped!.request.headers.get("x-api-key"), null)
  assert.equal(shaped!.request.headers.get("authorization"), "Bearer sk-ant-oat01-abc")
})

test("oauthToken and mergeBetas", () => {
  assert.equal(oauthToken(new Headers({ authorization: "Bearer sk-ant-api-1" })), undefined)
  assert.equal(mergeBetas("oauth-2025-04-20, x"), "claude-code-20250219,oauth-2025-04-20,x")
})

const fromWire = new Map([["Read", "read"], ["mcp__opencode__apply_patch", "apply_patch"]])

test("tool_use starts in the SSE stream are renamed back, split across chunks", async () => {
  const events = [
    'event: message_start\ndata: {"type":"message_start","message":{}}\n\n',
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"t","name":"mcp__opencode__apply_patch","input":{}}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"name\\":\\"Read\\"}"}}\n\n',
  ].join("")
  const encoder = new TextEncoder()
  const chunks = [events.slice(0, 50), events.slice(50, 130), events.slice(130)]
  const body = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  })
  const response = await restoreToolNames(
    new Response(body, { headers: { "content-type": "text/event-stream" } }),
    fromWire,
  )
  const text = await response.text()
  assert.match(text, /"name":"apply_patch"/)
  assert.doesNotMatch(text, /mcp__opencode__apply_patch/)
  // Tool input that happens to contain a mapped name is not touched.
  assert.match(text, /\\"name\\":\\"Read\\"/)
})

test("non-streaming JSON responses are renamed back", async () => {
  const response = await restoreToolNames(
    Response.json({ content: [{ type: "tool_use", name: "Read", input: {} }, { type: "text", text: "Read" }] }),
    fromWire,
  )
  const body = await response.json()
  assert.equal(body.content[0].name, "read")
  assert.equal(body.content[1].text, "Read")
})

test("error responses pass through unchanged", async () => {
  const original = new Response('{"error":"Read"}', { status: 400, headers: { "content-type": "application/json" } })
  assert.equal(await restoreToolNames(original, fromWire), original)
})

test("rewriteEvent leaves unmapped tools alone", () => {
  const event = 'data: {"type":"content_block_start","content_block":{"type":"tool_use","name":"mcp__github__x"}}\n\n'
  assert.equal(rewriteEvent(event, fromWire), event)
})

test("parseCode accepts the formats Anthropic hands out", () => {
  assert.deepEqual(parseCode("abc#st"), { code: "abc", state: "st" })
  assert.deepEqual(parseCode("https://platform.claude.com/oauth/code/callback?code=abc&state=st"), { code: "abc", state: "st" })
  assert.deepEqual(parseCode("code=abc&state=st"), { code: "abc", state: "st" })
  assert.deepEqual(parseCode(" abc "), { code: "abc", state: undefined })
})
