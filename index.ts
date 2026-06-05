/**
 * opencode-bedrock-tools-fix
 * ---------------------------------------------------------------------------
 * Fixes the LiteLLM -> AWS Bedrock error that OpenCode hits during conversation
 * compaction (and any request that carries tool-call history but sends an empty
 * `tools` array):
 *
 *   litellm.UnsupportedParamsError: Bedrock doesn't support tool calling
 *   without `tools=` param specified.
 *
 * HOW IT WORKS
 * ------------
 * OpenCode's compaction request includes the conversation history (which
 * contains tool_use / tool_result blocks) but sends `tools: {}` (empty). Strict
 * LiteLLM -> Bedrock gateways reject this. This plugin registers a custom
 * `fetch` (via the auth.loader mechanism that OpenCode's own built-in providers
 * use) for the configured provider(s). When it sees an outgoing POST whose body
 * has tool-call history but an empty/missing `tools` array, it injects a single
 * harmless no-op placeholder tool so the request passes validation.
 *
 * It does NOT set `tool_choice`: Bedrock's ToolChoice union only supports
 * auto/any/tool (no "none"), and sending "none" makes LiteLLM raise a *new* 400
 * unless the proxy runs with drop_params=true. Omitting tool_choice lets Bedrock
 * default to "auto", which still permits normal text output. The placeholder
 * tool's description instructs the model never to call it (the same approach as
 * opencode's own merged fix, PR #18539), so summaries stay intact.
 *
 * Cross-platform: uses only node:fs / node:os / node:path and standard fetch.
 * Works on Windows, macOS, and Linux with no changes.
 *
 * CONFIG (in opencode.json):
 *   "plugin": [
 *     ["github:XuOscar/opencode-bedrock-tools-fix", {
 *       "providers": ["ibm"],   // provider key(s) to patch; default ["ibm"]
 *       "debug": false           // write a debug log to tmpdir; default false
 *     }]
 *   ]
 */
import type { Plugin } from "@opencode-ai/plugin"
import { appendFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

const LOG_FILE = join(tmpdir(), "opencode-bedrock-tools-fix.log")
// Cap the debug log so it can never grow unbounded.
const LOG_MAX_BYTES = 1_000_000 // ~1 MB

function makeLogger(debug: boolean) {
  return (line: string) => {
    if (!debug) return
    try {
      // Skip writing if the log already exceeds the cap.
      try {
        if (statSync(LOG_FILE).size > LOG_MAX_BYTES) return
      } catch {
        /* file may not exist yet; that's fine */
      }
      appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${line}\n`)
    } catch {
      /* never let logging break a request */
    }
  }
}

/**
 * True if the conversation history contains tool usage. Handles both
 * OpenAI-style (tool_calls / role:"tool") and Anthropic-style content blocks
 * (tool_use / tool_result).
 */
function hasToolHistory(body: any): boolean {
  if (!body || !Array.isArray(body.messages)) return false
  return body.messages.some((m: any) => {
    if (!m) return false
    if (m.role === "tool") return true
    if (Array.isArray(m.tool_calls) && m.tool_calls.length > 0) return true
    if (Array.isArray(m.content)) {
      return m.content.some(
        (p: any) => p && (p.type === "tool_use" || p.type === "tool_result"),
      )
    }
    return false
  })
}

function toolsEmpty(body: any): boolean {
  return !Array.isArray(body?.tools) || body.tools.length === 0
}

// OpenAI-compatible (chat/completions) placeholder tool. The description tells
// the model never to call it (mirrors opencode PR #18539, which steers via
// description rather than tool_choice).
const NOOP_TOOL = {
  type: "function",
  function: {
    name: "noop",
    description:
      "Do not call this tool. It exists only for API compatibility and must never be invoked. Respond only with your normal text output.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
}

type Options = {
  providers?: string[]
  debug?: boolean
}

const plugin: Plugin = async (_input, options?: Record<string, unknown>) => {
  const opts = (options ?? {}) as Options
  const providers =
    Array.isArray(opts.providers) && opts.providers.length > 0
      ? opts.providers
      : ["ibm"]
  const debug = opts.debug === true
  const log = makeLogger(debug)

  log(`plugin loaded; providers=[${providers.join(",")}] debug=${debug}`)

  const makeFetch = (providerID: string) => {
    return async (input: any, init?: any) => {
      try {
        const method = (init?.method || "GET").toUpperCase()
        if (method === "POST" && typeof init?.body === "string") {
          let body: any
          try {
            body = JSON.parse(init.body)
          } catch {
            body = undefined
          }
          if (body && hasToolHistory(body) && toolsEmpty(body)) {
            body.tools = [NOOP_TOOL]
            // Intentionally NOT setting tool_choice (see header comment).
            init = { ...init, body: JSON.stringify(body) }
            log(
              `[${providerID}] PATCHED: injected noop tool (model=${
                body.model ?? "?"
              }, messages=${
                Array.isArray(body.messages) ? body.messages.length : "?"
              })`,
            )
          }
        }
      } catch (e) {
        log(`[${providerID}] fetch error: ${String(e)}`)
      }
      return fetch(input, init)
    }
  }

  // Register one auth hook per configured provider. The loader return value is
  // spread into the provider's SDK options, so our `fetch` wraps every request.
  // We deliberately do NOT return apiKey, so OpenCode falls back to the key the
  // user already configured/stored for that provider.
  if (providers.length === 1) {
    const providerID = providers[0]
    return {
      auth: {
        provider: providerID,
        methods: [{ type: "api", label: `${providerID} API Key` }],
        async loader() {
          log(`loader() invoked for provider=${providerID}`)
          return { fetch: makeFetch(providerID) }
        },
      },
    }
  }

  // The auth hook targets a single provider. For multiple providers, OpenCode's
  // hook surface only allows one `auth` block per plugin, so users needing
  // several providers should add the plugin once per provider (see README).
  // We still default-handle the first; warn about the rest.
  if (providers.length > 1) {
    log(
      `WARNING: multiple providers configured (${providers.join(
        ",",
      )}). Only "${providers[0]}" is hooked by this instance. ` +
        `Add the plugin once per provider to cover all of them (see README).`,
    )
  }
  const providerID = providers[0]
  return {
    auth: {
      provider: providerID,
      methods: [{ type: "api", label: `${providerID} API Key` }],
      async loader() {
        log(`loader() invoked for provider=${providerID}`)
        return { fetch: makeFetch(providerID) }
      },
    },
  }
}

export default plugin
