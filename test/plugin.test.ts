import assert from "node:assert/strict"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, test } from "node:test"
import plugin, { shapeRequest } from "../src/index.ts"
import { claudeCodeMethod, claudeCodeSource } from "../src/claude-code.ts"
import { CALLBACK_PATH, CALLBACK_PORT } from "../src/constants.ts"
import { browserMethod, refreshOrKeep, tokenRetry } from "../src/oauth.ts"
import { parseOptions } from "../src/options.ts"
import { AUTH_HINT, explainAuthError } from "../src/response.ts"

const realFetch = globalThis.fetch
tokenRetry.delays = [0, 0]
afterEach(() => {
  globalThis.fetch = realFetch
})

type Hook = (event: any) => Promise<void> | void

function fakeContext(credential: unknown) {
  const hooks: Record<string, Hook> = {}
  const transforms: Array<(editor: any) => void> = []
  let reloads = 0
  const registration = { dispose: async () => {} }
  const ctx = {
    options: {},
    integration: {
      transform: async () => registration,
      connection: {
        active: async () => (credential ? { id: "conn" } : undefined),
        resolve: async () => credential,
      },
    },
    model: {
      transform: async (callback: (editor: any) => void) => {
        transforms.push(callback)
        return registration
      },
      reload: async () => {
        reloads++
      },
    },
    session: {
      hook: async (name: string, callback: Hook) => {
        hooks[name] = callback
        return registration
      },
    },
  }
  const costs = () => {
    const models = [{ id: "claude-opus-5", cost: [{ input: 5 }] }]
    const editor = {
      list: () => models,
      update: (_provider: string, id: string, update: (draft: any) => void) =>
        update(models.find((model) => model.id === id)),
    }
    for (const transform of transforms) transform(editor)
    return models[0].cost
  }
  return { ctx: ctx as never, hooks, costs, reloads: () => reloads }
}

function messagesRequest(auth: Record<string, string>) {
  return new Request("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", ...auth },
    body: JSON.stringify({ system: "x", tools: [{ name: "shell" }], messages: [{ role: "user", content: "hi" }] }),
  })
}

test("costs are zeroed while a subscription login is active", async () => {
  const oauth = fakeContext({ type: "oauth", access: "sk-ant-oat01-x", refresh: "r", expires: 0 })
  await plugin.setup(oauth.ctx)
  assert.deepEqual(oauth.costs(), [])

  const key = fakeContext({ type: "key", key: "sk-ant-api03-x" })
  await plugin.setup(key.ctx)
  assert.deepEqual(key.costs(), [{ input: 5 }])
})

test("switching between API key and subscription reloads the model costs once", async () => {
  const fake = fakeContext({ type: "key", key: "sk-ant-api03-x" })
  await plugin.setup(fake.ctx)
  const send = (auth: Record<string, string>) =>
    fake.hooks["http.request"]({ sessionID: "ses", request: messagesRequest(auth) })
  await send({ "x-api-key": "sk-ant-api03-x" })
  assert.equal(fake.reloads(), 0)
  await send({ authorization: "Bearer sk-ant-oat01-x" })
  await send({ authorization: "Bearer sk-ant-oat01-x" })
  assert.equal(fake.reloads(), 1)
  assert.deepEqual(fake.costs(), [])
})

test("a 401 on a subscription request gets a next step; API-key responses are untouched", async () => {
  const fake = fakeContext(undefined)
  await plugin.setup(fake.ctx)
  const unauthorized = () =>
    new Response('{"type":"error","error":{"type":"authentication_error","message":"OAuth token has expired."}}', {
      status: 401,
      headers: { "content-type": "application/json" },
    })

  const subscription: any = { sessionID: "ses", request: messagesRequest({ authorization: "Bearer sk-ant-oat01-x" }) }
  await fake.hooks["http.request"](subscription)
  const response: any = { request: subscription.request, response: unauthorized() }
  await fake.hooks["http.response"](response)
  assert.equal((await response.response.json()).error.message, `OAuth token has expired. ${AUTH_HINT}`)

  const apiKey: any = { sessionID: "ses", request: messagesRequest({ "x-api-key": "sk-ant-api03-x" }) }
  await fake.hooks["http.request"](apiKey)
  const original = unauthorized()
  const passthrough: any = { request: apiKey.request, response: original }
  await fake.hooks["http.response"](passthrough)
  assert.equal(passthrough.response, original)
})

test("explainAuthError keeps non-JSON bodies and other statuses", async () => {
  const ok = new Response("fine")
  assert.equal(await explainAuthError(ok), ok)
  assert.equal(await (await explainAuthError(new Response("nope", { status: 401 }))).text(), "nope")
})

test("count_tokens requests are shaped like messages requests", async () => {
  const request = new Request("https://api.anthropic.com/v1/messages/count_tokens", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer sk-ant-oat01-x" },
    body: JSON.stringify({ tools: [{ name: "shell" }], messages: [{ role: "user", content: "hi" }] }),
  })
  const shaped = await shapeRequest(request, "ses", parseOptions({}, {}))
  assert.equal((await shaped!.request.json()).tools[0].name, "mcp__opencode__shell")
})

test("a failed refresh keeps the current credential and backs off before retrying", async () => {
  let calls = 0
  globalThis.fetch = (async () => {
    calls++
    return new Response("rate limited", { status: 429 })
  }) as typeof fetch
  const current = { type: "oauth", methodID: "m", access: "old", refresh: "rt-backoff", expires: 0 } as never
  assert.equal(await refreshOrKeep("m", current, 1_000), current)
  assert.equal(await refreshOrKeep("m", current, 20_000), current)
  // Three rounds over both token hosts, then nothing until the backoff has passed.
  assert.equal(calls, 6)
  await refreshOrKeep("m", current, 40_000)
  assert.equal(calls, 12)
})

test("a rate-limited token host falls back to the next one", async () => {
  const hosts: string[] = []
  globalThis.fetch = (async (url: string) => {
    hosts.push(new URL(url).host)
    return hosts.length === 1
      ? new Response('{"error":{"type":"rate_limit_error"}}', { status: 429 })
      : Response.json({ access_token: "new", refresh_token: "rt-3", expires_in: 3600 })
  }) as typeof fetch
  const current = { type: "oauth", methodID: "m", access: "old", refresh: "rt-fallback", expires: 0 } as never
  const next: any = await refreshOrKeep("m", current)
  assert.deepEqual(hosts, ["platform.claude.com", "claude.ai"])
  assert.equal(next.access, "new")
})

test("a definitive token error is not retried on another host", async () => {
  let calls = 0
  globalThis.fetch = (async () => {
    calls++
    return new Response('{"error":"invalid_grant"}', { status: 400 })
  }) as typeof fetch
  const current = { type: "oauth", methodID: "m", access: "old", refresh: "rt-dead", expires: 0 } as never
  assert.equal(await refreshOrKeep("m", current), current)
  assert.equal(calls, 1)
})

test("a successful refresh returns the new tokens", async () => {
  globalThis.fetch = (async () =>
    Response.json({ access_token: "new", refresh_token: "rt-2", expires_in: 3600 })) as typeof fetch
  const current = { type: "oauth", methodID: "m", access: "old", refresh: "rt-ok", expires: 0 } as never
  const next: any = await refreshOrKeep("m", current)
  assert.equal(next.access, "new")
  assert.equal(next.refresh, "rt-2")
})

test("the Claude Code method re-reads the stored login and never opens a web page", async () => {
  const dir = await mkdtemp(join(tmpdir(), "claude-code-"))
  const previous = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = dir
  try {
    const method = claudeCodeMethod()
    const stale = { type: "oauth", methodID: "m", access: "stale", refresh: "", expires: 0 } as never
    // No stored login: keep the current credential instead of failing the request.
    assert.equal(await method.refresh!(stale), stale)

    await writeFile(
      join(dir, ".credentials.json"),
      JSON.stringify({ claudeAiOauth: { accessToken: "sk-ant-oat01-fresh", expiresAt: 1, subscriptionType: "max" } }),
    )
    // Expired logins are still returned; Anthropic's 401 then explains the next step.
    assert.equal((await method.refresh!(stale)).access, "sk-ant-oat01-fresh")

    if (process.platform !== "darwin") {
      const authorization = await method.authorize({} as never)
      assert.equal(authorization.url, claudeCodeSource())
      assert.match(authorization.url, /^file:\/\//)
    }
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = previous
  }
})

test("claudeCodeSource points at the Keychain on macOS", () => {
  assert.equal(claudeCodeSource({}, "darwin"), "keychain://Claude%20Code-credentials")
})

test("a new browser login frees the port held by an abandoned attempt", async () => {
  const method = browserMethod()
  const first: any = await method.authorize({} as never)
  const second: any = await method.authorize({} as never)
  await assert.rejects(first.callback, /Replaced by a newer login attempt/)

  // The second attempt owns the port now; finish it with an error so the server closes.
  const response = await realFetch(`http://127.0.0.1:${CALLBACK_PORT}${CALLBACK_PATH}?error=access_denied`)
  assert.equal(response.status, 400)
  await assert.rejects(second.callback, /access_denied/)
})

test("token requests mirror Claude Code's axios request", async () => {
  let seen: { headers: Headers; body: string } | undefined
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    seen = { headers: new Headers(init.headers), body: String(init.body) }
    return Response.json({ access_token: "new", refresh_token: "rt-5", expires_in: 3600 })
  }) as typeof fetch
  const current = { type: "oauth", methodID: "m", access: "old", refresh: "rt-shape", expires: 0 } as never
  await refreshOrKeep("m", current)
  assert.equal(seen!.headers.get("user-agent"), "axios/1.15.2")
  assert.equal(seen!.headers.get("accept"), "application/json, text/plain, */*")
  assert.equal(seen!.headers.get("content-type"), "application/json")
  assert.deepEqual(Object.keys(JSON.parse(seen!.body)), ["grant_type", "refresh_token", "client_id", "scope"])
})

test("a rate limit that outlasts the retries reports every host", async () => {
  globalThis.fetch = (async () => new Response("{}", { status: 429 })) as typeof fetch
  const { refresh } = await import("../src/oauth.ts")
  const current = { type: "oauth", methodID: "m", access: "old", refresh: "rt-report", expires: 0 } as never
  await assert.rejects(refresh("m", current), /platform\.claude\.com: 429.*claude\.ai: 429/)
})
