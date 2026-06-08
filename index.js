// index.ts
import { appendFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
var LOG_FILE = join(tmpdir(), "opencode-bedrock-tools-fix.log");
var LOG_MAX_BYTES = 1e6;
function makeLogger(debug) {
  return (line) => {
    if (!debug)
      return;
    try {
      try {
        if (statSync(LOG_FILE).size > LOG_MAX_BYTES)
          return;
      } catch {}
      appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${line}
`);
    } catch {}
  };
}
function hasToolHistory(body) {
  if (!body || !Array.isArray(body.messages))
    return false;
  return body.messages.some((m) => {
    if (!m)
      return false;
    if (m.role === "tool")
      return true;
    if (Array.isArray(m.tool_calls) && m.tool_calls.length > 0)
      return true;
    if (Array.isArray(m.content)) {
      return m.content.some((p) => p && (p.type === "tool_use" || p.type === "tool_result"));
    }
    return false;
  });
}
function toolsEmpty(body) {
  return !Array.isArray(body?.tools) || body.tools.length === 0;
}
function isAssistant(m) {
  return m && m.role === "assistant";
}
function hasToolCalls(m) {
  if (Array.isArray(m?.tool_calls) && m.tool_calls.length > 0)
    return true;
  if (Array.isArray(m?.content)) {
    return m.content.some((p) => p && p.type === "tool_use");
  }
  return false;
}
function stripTrailingPrefill(body) {
  if (!body || !Array.isArray(body.messages))
    return 0;
  let stripped = 0;
  while (body.messages.length > 0 && isAssistant(body.messages[body.messages.length - 1]) && !hasToolCalls(body.messages[body.messages.length - 1])) {
    body.messages.pop();
    stripped++;
  }
  return stripped;
}
var NOOP_TOOL = {
  type: "function",
  function: {
    name: "noop",
    description: "Do not call this tool. It exists only for API compatibility and must never be invoked. Respond only with your normal text output.",
    parameters: { type: "object", properties: {}, additionalProperties: false }
  }
};
var plugin = async (_input, options) => {
  const opts = options ?? {};
  const providers = Array.isArray(opts.providers) && opts.providers.length > 0 ? opts.providers : ["ibm"];
  const debug = opts.debug === true;
  const log = makeLogger(debug);
  log(`plugin loaded; providers=[${providers.join(",")}] debug=${debug}`);
  const makeFetch = (providerID2) => {
    return async (input, init) => {
      try {
        const method = (init?.method || "GET").toUpperCase();
        if (method === "POST" && typeof init?.body === "string") {
          let body;
          try {
            body = JSON.parse(init.body);
          } catch {
            body = undefined;
          }
          if (body) {
            let changed = false;
            const strippedCount = stripTrailingPrefill(body);
            if (strippedCount > 0) {
              changed = true;
              log(`[${providerID2}] PREFILL-FIX: stripped ${strippedCount} trailing assistant message(s) (model=${body.model ?? "?"}, messages now=${Array.isArray(body.messages) ? body.messages.length : "?"})`);
            }
            if (hasToolHistory(body) && toolsEmpty(body)) {
              body.tools = [NOOP_TOOL];
              changed = true;
              log(`[${providerID2}] TOOLS-FIX: injected noop tool (model=${body.model ?? "?"}, messages=${Array.isArray(body.messages) ? body.messages.length : "?"})`);
            }
            if (changed) {
              init = { ...init, body: JSON.stringify(body) };
            }
          }
        }
      } catch (e) {
        log(`[${providerID2}] fetch error: ${String(e)}`);
      }
      return fetch(input, init);
    };
  };
  if (providers.length === 1) {
    const providerID2 = providers[0];
    return {
      auth: {
        provider: providerID2,
        methods: [{ type: "api", label: `${providerID2} API Key` }],
        async loader() {
          log(`loader() invoked for provider=${providerID2}`);
          return { fetch: makeFetch(providerID2) };
        }
      }
    };
  }
  if (providers.length > 1) {
    log(`WARNING: multiple providers configured (${providers.join(",")}). Only "${providers[0]}" is hooked by this instance. ` + `Add the plugin once per provider to cover all of them (see README).`);
  }
  const providerID = providers[0];
  return {
    auth: {
      provider: providerID,
      methods: [{ type: "api", label: `${providerID} API Key` }],
      async loader() {
        log(`loader() invoked for provider=${providerID}`);
        return { fetch: makeFetch(providerID) };
      }
    }
  };
};
var repo8_default = plugin;
export {
  repo8_default as default
};
