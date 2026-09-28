/**
 * Translates wire tool names in an Anthropic response back to OpenCode's names.
 * Only `tool_use` block starts carry a name; every other event passes through unchanged.
 */
export async function restoreToolNames(response: Response, fromWire: ReadonlyMap<string, string>) {
  if (!response.body || fromWire.size === 0 || !response.ok) return response
  const type = response.headers.get("content-type") ?? ""
  const headers = new Headers(response.headers)
  headers.delete("content-length")
  const init = { status: response.status, statusText: response.statusText, headers }
  if (type.includes("text/event-stream")) return new Response(rewriteStream(response.body, fromWire), init)
  if (type.includes("application/json")) return new Response(rewriteJson(await response.text(), fromWire), init)
  return response
}

export function rewriteStream(body: ReadableStream<Uint8Array>, fromWire: ReadonlyMap<string, string>) {
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let buffer = ""
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        buffer += decoder.decode(chunk, { stream: true })
        let end = boundary(buffer)
        while (end) {
          controller.enqueue(encoder.encode(rewriteEvent(buffer.slice(0, end.index + end.length), fromWire)))
          buffer = buffer.slice(end.index + end.length)
          end = boundary(buffer)
        }
      },
      flush(controller) {
        buffer += decoder.decode()
        if (buffer) controller.enqueue(encoder.encode(rewriteEvent(buffer, fromWire)))
      },
    }),
  )
}

function boundary(text: string) {
  const match = /\r?\n\r?\n/.exec(text)
  return match ? { index: match.index, length: match[0].length } : undefined
}

export function rewriteEvent(event: string, fromWire: ReadonlyMap<string, string>) {
  if (!event.includes('"tool_use"')) return event
  return event.replace(/^data:(.*)$/gm, (line, data: string) => {
    try {
      const parsed = JSON.parse(data)
      const block = parsed?.content_block
      if (parsed?.type !== "content_block_start" || block?.type !== "tool_use") return line
      const name = fromWire.get(block.name)
      if (!name) return line
      block.name = name
      return `data: ${JSON.stringify(parsed)}`
    } catch {
      return line
    }
  })
}

export function rewriteJson(text: string, fromWire: ReadonlyMap<string, string>) {
  try {
    const parsed = JSON.parse(text)
    if (!Array.isArray(parsed?.content)) return text
    for (const block of parsed.content)
      if (block?.type === "tool_use" && fromWire.has(block.name)) block.name = fromWire.get(block.name)
    return JSON.stringify(parsed)
  } catch {
    return text
  }
}

export const AUTH_HINT =
  "Your Claude subscription login is expired or was revoked. Run `opencode auth login anthropic` again, or run `claude` once if you use the Claude Code login."

/** Adds a next step to Anthropic's 401 for subscription requests; other responses pass through. */
export async function explainAuthError(response: Response) {
  if (response.status !== 401) return response
  const text = await response.text()
  const headers = new Headers(response.headers)
  headers.delete("content-length")
  const init = { status: response.status, statusText: response.statusText, headers }
  try {
    const parsed = JSON.parse(text)
    if (typeof parsed?.error?.message !== "string") return new Response(text, init)
    parsed.error.message = `${parsed.error.message} ${AUTH_HINT}`
    return new Response(JSON.stringify(parsed), init)
  } catch {
    return new Response(text, init)
  }
}
