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
  TOKEN_URL,
} from "./constants.ts"

const LOGIN_TIMEOUT = 10 * 60 * 1000

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
        .finally(() => server.close())
      return {
        mode: "auto",
        url: authorizeURL(redirect, pkce, state),
        instructions: "Complete the login in your browser. This window updates automatically.",
        expiresAt: Date.now() + LOGIN_TIMEOUT,
        callback,
      }
    },
    refresh: (value) => refresh(METHOD.browser, value),
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
    refresh: (value) => refresh(METHOD.manual, value),
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
  return postToken({
    grant_type: "authorization_code",
    client_id: CLIENT_ID,
    code,
    state,
    redirect_uri: redirect,
    code_verifier: pkce.verifier,
  })
}

export async function refresh(methodID: string, value: Credential.OAuth) {
  const tokens = await postToken({ grant_type: "refresh_token", client_id: CLIENT_ID, refresh_token: value.refresh })
  const next = credential(methodID, tokens)
  return {
    ...next,
    refresh: tokens.refresh_token ?? value.refresh,
    metadata: { ...value.metadata, ...next.metadata },
  } as Credential.OAuth
}

async function postToken(body: Record<string, string>): Promise<TokenResponse> {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`Anthropic token request failed (${response.status}): ${text.slice(0, 500)}`)
  const parsed = JSON.parse(text) as TokenResponse
  if (!parsed.access_token) throw new Error("Anthropic token response did not contain an access token")
  return parsed
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
  code.finally(() => clearTimeout(timer)).catch(() => {})
  return { server, code }
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
