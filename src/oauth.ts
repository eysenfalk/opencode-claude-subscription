import type { Server } from "node:http"
import type { Credential } from "@opencode/plugin"
import type { IntegrationOAuthMethodRegistration } from "@opencode/plugin/promise/integration"
import {
  AUTHORIZE_URL,
  CALLBACK_HOST,
  CALLBACK_PATH,
  CALLBACK_PORT,
  CLIENT_ID,
  INTEGRATION_ID,
  MANUAL_REDIRECT_URI,
  METHOD,
  SCOPES,
  TOKEN_HEADERS,
  TOKEN_URLS,
} from "./constants.ts"

const LOGIN_TIMEOUT = 10 * 60 * 1000
const REFRESH_RETRY_DELAY = 30 * 1000
const LOGIN_BUDGET = 30 * 1000
/** Refresh runs inline before a model request, so it gives up sooner than a login. */
const REFRESH_BUDGET = 10 * 1000

/** The callback server of the login attempt that is still waiting, if any. */
let pending: { server: Server; cancel: (error: Error) => void } | undefined
/** Refresh tokens whose last refresh failed, with the time of that failure. */
const failedRefresh = new Map<string, number>()

interface TokenResponse {
  access_token: string
  refresh_token?: string
  expires_in?: number
  account?: { uuid?: string; email_address?: string }
  organization?: { uuid?: string; name?: string }
}

interface Pkce {
  verifier: string
  challenge: string
}

export function browserMethod(): IntegrationOAuthMethodRegistration {
  return {
    integrationID: INTEGRATION_ID,
    method: { id: METHOD.browser, type: "oauth", label: "Claude Pro/Max subscription (browser)" },
    authorize: async () => {
      const pkce = await generatePkce()
      const state = randomToken()
      const redirect = `http://localhost:${CALLBACK_PORT}${CALLBACK_PATH}`
      const { server, code } = await listen(state)
      const callback = code
        .then((value) => exchange(value, state, redirect, pkce))
        .then((tokens) => credential(METHOD.browser, tokens))
        .finally(() => close(server))
      // OpenCode stops awaiting a cancelled attempt; keep its later rejection from going unhandled.
      callback.catch(() => {})
      return {
        mode: "auto",
        url: authorizeURL(redirect, pkce, state),
        instructions: "Complete the login in your browser. This window updates automatically.",
        expiresAt: Date.now() + LOGIN_TIMEOUT,
        callback,
      }
    },
    refresh: (value) => refreshOrKeep(METHOD.browser, value),
    label,
  }
}

export function manualMethod(): IntegrationOAuthMethodRegistration {
  return {
    integrationID: INTEGRATION_ID,
    method: { id: METHOD.manual, type: "oauth", label: "Claude Pro/Max subscription (paste code)" },
    authorize: async () => {
      const pkce = await generatePkce()
      const state = randomToken()
      return {
        mode: "code",
        url: authorizeURL(MANUAL_REDIRECT_URI, pkce, state),
        instructions: "Authorize in your browser, then paste the code Anthropic shows you.",
        callback: async (input) => {
          const parsed = parseCode(input)
          if (!parsed.code) throw new Error("No authorization code found in the pasted value")
          if (parsed.state && parsed.state !== state) throw new Error("OAuth state mismatch")
          return credential(METHOD.manual, await exchange(parsed.code, state, MANUAL_REDIRECT_URI, pkce))
        },
      }
    },
    refresh: (value) => refreshOrKeep(METHOD.manual, value),
    label,
  }
}

function label(value: Credential.OAuth) {
  const email = value.metadata?.email
  return typeof email === "string" ? email : undefined
}

export function authorizeURL(redirect: string, pkce: Pkce, state: string) {
  return `${AUTHORIZE_URL}?${new URLSearchParams({
    code: "true",
    client_id: CLIENT_ID,
    response_type: "code",
    redirect_uri: redirect,
    scope: SCOPES,
    code_challenge: pkce.challenge,
    code_challenge_method: "S256",
    state,
  })}`
}

/** Accepts `code#state`, a full redirect URL, a query string, or a bare code. */
export function parseCode(input: string): { code?: string; state?: string } {
  const value = input.trim()
  if (!value) return {}
  if (URL.canParse(value)) {
    const url = new URL(value)
    return { code: url.searchParams.get("code") ?? undefined, state: url.searchParams.get("state") ?? undefined }
  }
  if (value.includes("code=")) {
    const params = new URLSearchParams(value)
    return { code: params.get("code") ?? undefined, state: params.get("state") ?? undefined }
  }
  const [code, state] = value.split("#", 2)
  return { code, state }
}

function exchange(code: string, state: string, redirect: string, pkce: Pkce) {
  // Same fields and order as Claude Code's exchange.
  return postToken({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirect,
    client_id: CLIENT_ID,
    code_verifier: pkce.verifier,
    state,
  })
}

export async function refresh(methodID: string, value: Credential.OAuth) {
  const tokens = await postToken(
    { grant_type: "refresh_token", refresh_token: value.refresh, client_id: CLIENT_ID, scope: SCOPES },
    REFRESH_BUDGET,
  )
  const next = credential(methodID, tokens)
  return {
    ...next,
    refresh: tokens.refresh_token ?? value.refresh,
    metadata: { ...value.metadata, ...next.metadata },
  } as Credential.OAuth
}

/**
 * OpenCode turns a rejected refresh into an unexpected-error defect. Keeping the current
 * credential instead lets the request reach Anthropic, whose 401 gets an actionable hint
 * (see `explainAuthError`). Failed refreshes are retried at most every 30 seconds.
 */
export async function refreshOrKeep(methodID: string, value: Credential.OAuth, now = Date.now()) {
  const failed = failedRefresh.get(value.refresh)
  if (!value.refresh || (failed !== undefined && now - failed < REFRESH_RETRY_DELAY)) return value
  try {
    const next = await refresh(methodID, value)
    failedRefresh.delete(value.refresh)
    return next
  } catch {
    failedRefresh.set(value.refresh, now)
    return value
  }
}

/** Waits between rounds over all token hosts; tests shorten them. */
export const tokenRetry = { delays: [1000, 2000] }

async function postToken(body: Record<string, string>, budget = LOGIN_BUDGET): Promise<TokenResponse> {
  const deadline = Date.now() + budget
  const failures: string[] = []
  for (let round = 0; ; round++) {
    let retryAfter = 0
    for (const url of TOKEN_URLS) {
      const host = new URL(url).host
      let response: Response
      try {
        response = await fetch(url, {
          method: "POST",
          headers: TOKEN_HEADERS,
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(Math.max(1, Math.min(30_000, deadline - Date.now()))),
        })
      } catch (error) {
        failures.push(`${host}: ${error instanceof Error ? error.message : String(error)}`)
        continue
      }
      const text = await response.text()
      if (response.ok) {
        const parsed = JSON.parse(text) as TokenResponse
        if (!parsed.access_token) throw new Error("Anthropic token response did not contain an access token")
        return parsed
      }
      // Rate limits and server errors are per host and often short-lived; any other status is the real answer.
      if (response.status !== 429 && response.status < 500)
        throw new Error(`Anthropic token request failed (${response.status} from ${host}): ${text.slice(0, 500)}`)
      failures.push(`${host}: ${response.status}`)
      retryAfter = Math.max(retryAfter, (Number(response.headers.get("retry-after")) || 0) * 1000)
    }
    const delay = Math.max(tokenRetry.delays[round] ?? -1, Math.min(retryAfter, 10_000))
    if (round >= tokenRetry.delays.length || Date.now() + delay >= deadline)
      throw new Error(`Anthropic token request failed after retries (${failures.join(", ")})`)
    await new Promise((resolve) => setTimeout(resolve, delay))
  }
}

function credential(methodID: string, tokens: TokenResponse): Credential.OAuth {
  const metadata = {
    ...(tokens.account?.email_address ? { email: tokens.account.email_address } : {}),
    ...(tokens.organization?.name ? { organization: tokens.organization.name } : {}),
  }
  return {
    type: "oauth",
    methodID,
    access: tokens.access_token,
    refresh: tokens.refresh_token ?? "",
    expires: Date.now() + (tokens.expires_in ?? 3600) * 1000,
    ...(Object.keys(metadata).length ? { metadata } : {}),
  } as Credential.OAuth
}

async function listen(state: string): Promise<{ server: Server; code: Promise<string> }> {
  // A cancelled attempt would otherwise hold the port until its timeout and block the retry.
  if (pending) {
    pending.cancel(new Error("Replaced by a newer login attempt"))
    await close(pending.server)
  }
  const { createServer } = await import("node:http")
  let settle!: { resolve: (code: string) => void; reject: (error: Error) => void }
  const code = new Promise<string>((resolve, reject) => (settle = { resolve, reject }))
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost")
    if (url.pathname !== CALLBACK_PATH) return void response.writeHead(404).end("Not found")
    const error = url.searchParams.get("error_description") ?? url.searchParams.get("error")
    const value = url.searchParams.get("code")
    const failure = error ?? (!value ? "Missing authorization code" : url.searchParams.get("state") !== state ? "Invalid OAuth state" : undefined)
    response.writeHead(failure ? 400 : 200, { "Content-Type": "text/html; charset=utf-8" })
    response.end(page(failure ?? "Claude login complete. You can close this window."))
    if (failure) settle.reject(new Error(failure))
    else settle.resolve(value!)
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", (error: NodeJS.ErrnoException) =>
      reject(
        error.code === "EADDRINUSE"
          ? new Error(`Port ${CALLBACK_PORT} is in use. Free it or use the "paste code" login method.`)
          : error,
      ),
    )
    server.listen(CALLBACK_PORT, CALLBACK_HOST, resolve)
  })
  const timer = setTimeout(() => settle.reject(new Error("Login timed out")), LOGIN_TIMEOUT)
  pending = { server, cancel: settle.reject }
  code
    .finally(() => {
      clearTimeout(timer)
      if (pending?.server === server) pending = undefined
    })
    .catch(() => {})
  return { server, code }
}

function close(server: Server) {
  return new Promise<void>((resolve) => {
    if (!server.listening) return resolve()
    server.close(() => resolve())
    server.closeAllConnections()
  })
}

function page(message: string) {
  const escaped = message.replace(/[&<>"]/g, (char) => `&#${char.charCodeAt(0)};`)
  return `<!doctype html><meta charset="utf-8"><title>Claude login</title><body style="font-family:system-ui;padding:3rem"><p>${escaped}</p></body>`
}

async function generatePkce(): Promise<Pkce> {
  const verifier = randomToken()
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))
  return { verifier, challenge: Buffer.from(digest).toString("base64url") }
}

function randomToken() {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url")
}
