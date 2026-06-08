/**
 * opencode-bedrock-tools-fix
 * ---------------------------------------------------------------------------
 * Client-side fixes for two OpenCode issues that hit Claude models served
 * through a LiteLLM -> AWS Bedrock gateway via the @ai-sdk/openai-compatible
 * transport (where OpenCode's own normalizers don't apply):
 *
 *   #1 UnsupportedParamsError: "Bedrock doesn't support tool calling without
 *      `tools=` param specified." — happens on compaction / any request with
 *      tool-call history but an empty tools array.
 *
 *   #2 "This model does not support assistant message prefill. The
 *      conversation must end with a user message." — Claude Opus 4.6+ rejects
 *      requests whose messages array ends with an assistant message. Often
 *      surfaces only as "terminated" because the 400 has an empty streamed body.
 *
 * HOW IT WORKS
 * ------------
 * The plugin registers a custom `fetch` for the configured provider(s) via the
 * auth.loader mechanism OpenCode's built-in providers use. On every outgoing
 * POST it:
 *   - strips trailing prefill assistant message(s) (no tool_calls) so the
 *     conversation ends on a non-assistant message (fix #2); and
 *   - injects a harmless noop tool when there is tool-call history but an empty
 *     tools array (fix #1).
 * Assistant turns that carry tool calls are never stripped. It does NOT set
 * tool_choice (Bedrock has no "none"; that would cause a new 400). Normal
 * requests pass through untouched.
 *
 * Cross-platform: uses only node:fs / node:os / node:path and standard fetch.
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

/**
 * Fix for issue #3 (assistant message prefill / "terminated").
 *
 * Claude Opus 4.6+ rejects requests whose messages array ends with an
 * assistant message: "This model does not support assistant message prefill.
 * The conversation must end with a user message." OpenCode strips trailing
 * assistants only for @ai-sdk/anthropic and @ai-sdk/amazon-bedrock, NOT for
 * @ai-sdk/openai-compatible gateways — so the fix never runs for such
 * providers and the request fails (often surfacing only as "terminated"
 * because the 400 is returned with an empty streamed body).
 *
 * We replicate OpenCode's stripTrailingAssistant() client-side: remove any
 * trailing assistant message(s) that are pure prefill, i.e. that do NOT carry
 * tool calls. An assistant message WITH tool_calls is a legitimate tool-use
 * turn (its tool results follow) and must never be stripped.
 */
function isAssistant(m: any): boolean {
  return m && m.role === "assistant"
}

function hasToolCalls(m: any): boolean {
  // OpenAI-style tool_calls
  if (Array.isArray(m?.tool_calls) && m.tool_calls.length > 0) return true
  // Anthropic-style content blocks
  if (Array.isArray(m?.content)) {
    return m.content.some((p: any) => p && p.type === "tool_use")
  }
  return false
}

/**
 * Removes trailing prefill assistant messages (assistant turns with no tool
 * calls) so the conversation ends on a non-assistant message. Returns the
 * number of messages stripped. Mutates body.messages in place.
 */
function stripTrailingPrefill(body: any): number {
  if (!body || !Array.isArray(body.messages)) return 0
  let stripped = 0
  while (
    body.messages.length > 0 &&
    isAssistant(body.messages[body.messages.length - 1]) &&
    !hasToolCalls(body.messages[body.messages.length - 1])
  ) {
    body.messages.pop()
    stripped++
  }
  return stripped
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
          if (body) {
            let changed = false

            // Fix #3: strip trailing prefill assistant message(s) so the
            // conversation ends on a non-assistant message (Claude Opus 4.6+
            // rejects assistant-prefill). Tool-call assistant turns are kept.
            const strippedCount = stripTrailingPrefill(body)
            if (strippedCount > 0) {
              changed = true
              log(
                `[${providerID}] PREFILL-FIX: stripped ${strippedCount} trailing assistant message(s) (model=${
                  body.model ?? "?"
                }, messages now=${
                  Array.isArray(body.messages) ? body.messages.length : "?"
                })`,
              )
            }

            // Fix #1: if there is tool-call history but an empty tools array,
            // inject a harmless noop tool so the gateway accepts the request.
            if (hasToolHistory(body) && toolsEmpty(body)) {
              body.tools = [NOOP_TOOL]
              changed = true
              log(
                `[${providerID}] TOOLS-FIX: injected noop tool (model=${
                  body.model ?? "?"
                }, messages=${
                  Array.isArray(body.messages) ? body.messages.length : "?"
                })`,
              )
            }

            if (changed) {
              init = { ...init, body: JSON.stringify(body) }
            }
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
