import { execFile } from "node:child_process"
import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import type { Credential } from "@opencode/plugin"
import type { IntegrationOAuthMethodRegistration } from "@opencode/plugin/promise/integration"
import { INTEGRATION_ID, METHOD } from "./constants.ts"

const REFRESH_MARGIN = 5 * 60 * 1000

interface StoredLogin {
  claudeAiOauth?: {
    accessToken?: string
    refreshToken?: string
    expiresAt?: number
    subscriptionType?: string
  }
}

/**
 * Uses the login Claude Code already stored on this machine, read-only.
 *
 * The plugin never refreshes this token itself: Anthropic rotates refresh tokens, so a
 * refresh here would silently log Claude Code out. Claude Code keeps it fresh instead.
 */
export function claudeCodeMethod(): IntegrationOAuthMethodRegistration {
  return {
    integrationID: INTEGRATION_ID,
    method: { id: METHOD.claudeCode, type: "oauth", label: "Claude Code login on this machine (read-only)" },
    authorize: async () => {
      const current = await readClaudeCode()
      return {
        mode: "auto",
        url: "https://claude.ai/settings/usage",
        instructions: `Using the Claude Code login (${current.metadata?.subscription ?? "subscription"}). Claude Code must keep running occasionally to refresh it.`,
        callback: Promise.resolve(current),
      }
    },
    refresh: async () => {
      const current = await readClaudeCode()
      if (current.expires > Date.now() + REFRESH_MARGIN) return current
      throw new Error("The Claude Code login has expired. Run `claude` once to refresh it, then retry.")
    },
    label: (value) => {
      const subscription = value.metadata?.subscription
      return typeof subscription === "string" ? `Claude Code (${subscription})` : "Claude Code"
    },
  }
}

export async function readClaudeCode(env = process.env): Promise<Credential.OAuth> {
  const raw = process.platform === "darwin" ? await readKeychain().catch(() => readCredentialsFile(env)) : await readCredentialsFile(env)
  const login = (JSON.parse(raw) as StoredLogin).claudeAiOauth
  if (!login?.accessToken || !login.expiresAt)
    throw new Error("No Claude Code login found. Run `claude` and log in with your subscription first.")
  return {
    type: "oauth",
    methodID: METHOD.claudeCode,
    access: login.accessToken,
    // Kept only to satisfy the credential shape; this plugin never uses it.
    refresh: "",
    expires: login.expiresAt,
    ...(login.subscriptionType ? { metadata: { subscription: login.subscriptionType } } : {}),
  } as Credential.OAuth
}

function readCredentialsFile(env: NodeJS.ProcessEnv) {
  const dir = env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude")
  return readFile(join(dir, ".credentials.json"), "utf8")
}

async function readKeychain() {
  const { stdout } = await promisify(execFile)("security", ["find-generic-password", "-s", "Claude Code-credentials", "-w"], {
    timeout: 5000,
  })
  return stdout.trim()
}
