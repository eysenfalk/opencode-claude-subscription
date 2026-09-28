import { createHash } from "node:crypto"
import { appendFile } from "node:fs/promises"
import type { Plugin } from "@opencode/plugin/promise/plugin"
import { claudeCodeMethod } from "./claude-code.ts"
import { INTEGRATION_ID, OAUTH_BETAS, OAUTH_TOKEN_PREFIX, PLUGIN_ID } from "./constants.ts"
import { browserMethod, manualMethod } from "./oauth.ts"
import { parseOptions, type Options } from "./options.ts"
import { transformBody, type MessagesBody } from "./request.ts"
import { explainAuthError, restoreToolNames } from "./response.ts"

const OPENCODE_HEADERS = ["x-session-affinity", "x-session-id", "x-parent-session-id"]
const SHAPED_PATHS = ["/messages", "/messages/count_tokens"]

const plugin: Plugin = {
  id: PLUGIN_ID,
  async setup(ctx) {
    const options = parseOptions(ctx.options)
    const renamed = new WeakMap<Request, ReadonlyMap<string, string>>()
    const shaped = new WeakSet<Request>()
    const scope = { providerID: INTEGRATION_ID }
    let subscription = await detectSubscription(ctx)

    const methods = await ctx.integration.transform((editor) => {
      editor.method.update(browserMethod())
      editor.method.update(manualMethod())
      editor.method.update(claudeCodeMethod())
    })

    // The subscription covers usage, so per-token prices would only mislead.
    const costs = await ctx.model.transform((editor) => {
      if (!subscription) return
      for (const model of editor.list(INTEGRATION_ID))
        editor.update(INTEGRATION_ID, String(model.id), (draft) => {
          draft.cost = []
        })
    })

    const requestHook = await ctx.session.hook(
      "http.request",
      async (event) => {
        const next = await shapeRequest(event.request, event.sessionID, options)
        if (!next !== !subscription) {
          subscription = !!next
          ctx.model.reload().catch(() => {})
        }
        if (!next) return
        event.request = next.request
        shaped.add(next.request)
        if (next.fromWire.size) renamed.set(next.request, next.fromWire)
      },
      scope,
    )

    const responseHook = await ctx.session.hook(
      "http.response",
      async (event) => {
        if (!shaped.has(event.request)) return
        const fromWire = renamed.get(event.request)
        if (fromWire) event.response = await restoreToolNames(event.response, fromWire)
        event.response = await explainAuthError(event.response)
      },
      scope,
    )

    return async () => {
      await Promise.all([methods.dispose(), costs.dispose(), requestHook.dispose(), responseHook.dispose()])
    }
  },
}

export default plugin

export async function shapeRequest(request: Request, sessionID: string, options: Options) {
  const token = oauthToken(request.headers)
  if (!token) return

  const headers = new Headers(request.headers)
  headers.delete("x-api-key")
  headers.delete("content-length")
  for (const key of [...headers.keys()])
    if (key.startsWith("x-opencode-") || OPENCODE_HEADERS.includes(key)) headers.delete(key)
  headers.set("authorization", `Bearer ${token}`)
  headers.set("user-agent", `claude-cli/${options.claudeCodeVersion} (external, cli)`)
  headers.set("x-app", "cli")
  headers.set("anthropic-dangerous-direct-browser-access", "true")
  headers.set("anthropic-beta", mergeBetas(headers.get("anthropic-beta")))
  headers.set("x-claude-code-session-id", sessionUUID(sessionID))

  let body = request.body ? await request.text() : undefined
  let fromWire = new Map<string, string>()
  const path = new URL(request.url).pathname
  if (body && SHAPED_PATHS.some((suffix) => path.endsWith(suffix))) {
    const parsed = parseJson(body)
    if (parsed) {
      if (options.debugLog) await log(options.debugLog, "before", request.url, parsed)
      const names = transformBody(parsed, options)
      fromWire = new Map([...names.fromWire].filter(([wire, name]) => wire !== name))
      body = JSON.stringify(parsed)
      if (options.debugLog) await log(options.debugLog, "after", request.url, parsed)
    }
  }

  return {
    request: new Request(request.url, { method: request.method, headers, body, signal: request.signal }),
    fromWire,
  }
}

async function detectSubscription(ctx: Parameters<Plugin["setup"]>[0]) {
  try {
    const connection = await ctx.integration.connection.active(INTEGRATION_ID)
    const value = connection ? await ctx.integration.connection.resolve(connection) : undefined
    const token = value?.type === "oauth" ? value.access : value?.type === "key" ? value.key : undefined
    return token?.startsWith(OAUTH_TOKEN_PREFIX) ?? false
  } catch {
    return false
  }
}

/** Finds a subscription access token whether OpenCode sent it as a bearer token or as an API key. */
export function oauthToken(headers: Headers) {
  const bearer = headers.get("authorization")?.replace(/^Bearer\s+/i, "")
  if (bearer?.startsWith(OAUTH_TOKEN_PREFIX)) return bearer
  const key = headers.get("x-api-key")
  if (key?.startsWith(OAUTH_TOKEN_PREFIX)) return key
}

export function mergeBetas(current: string | null) {
  const betas = (current ?? "")
    .split(",")
    .map((beta) => beta.trim())
    .filter(Boolean)
  return [...new Set([...OAUTH_BETAS, ...betas])].join(",")
}

function sessionUUID(sessionID: string) {
  const hex = createHash("sha256").update(sessionID).digest("hex")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

function parseJson(text: string): MessagesBody | undefined {
  try {
    const parsed = JSON.parse(text)
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

async function log(file: string, stage: string, url: string, body: unknown) {
  await appendFile(file, JSON.stringify({ time: new Date().toISOString(), stage, url, body }) + "\n").catch(() => {})
}
