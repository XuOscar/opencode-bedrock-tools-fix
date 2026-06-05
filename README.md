# opencode-bedrock-tools-fix

An [OpenCode](https://opencode.ai) plugin that fixes the LiteLLM → AWS Bedrock
error triggered during conversation **compaction**:

```
litellm.UnsupportedParamsError: Bedrock doesn't support tool calling without
`tools=` param specified. Pass `tools=` param OR set
`litellm.modify_params = True` // `litellm_settings::modify_params: True`
to add dummy tool to the request.
```

## The Problem

When a session approaches the context-window limit, OpenCode automatically
**compacts** (summarizes) the conversation. That compaction request includes the
full message history — which contains `tool_use` / `tool_result` blocks from
earlier tool calls — but it sends an **empty `tools` array**.

Strict gateways that route to AWS Bedrock via **LiteLLM** reject this
combination (history has tool calls, but no `tools` declared) with a
`400 UnsupportedParamsError`. The same thing happens with a manual `/compact`.

The "official" gateway-side fix is `litellm_settings: { modify_params: true }`,
but if the LiteLLM proxy isn't under your control (e.g. a hosted/enterprise
endpoint), you can't change it.

## The Fix

This plugin does **client-side** what `modify_params` does server-side. It
registers a custom `fetch` for the configured provider(s) — using the same
`auth.loader` mechanism OpenCode's own built-in providers (GitHub Copilot,
Codex, xAI, Snowflake) use — and, for any outgoing POST whose body has
tool-call history but an empty/missing `tools` array, it injects a single
harmless **no-op placeholder tool** so the request passes validation.

- ✅ Only patches the offending requests (compaction / tool-history-without-tools).
  Normal requests pass through **untouched**.
- ✅ Does **not** touch your API key — it only adds a `fetch` wrapper; OpenCode
  keeps using the key you already configured for the provider.
- ✅ Does **not** set `tool_choice`. Bedrock's `ToolChoice` only supports
  `auto`/`any`/`tool` (no `none`); sending `none` would cause a *new* 400 unless
  the proxy has `drop_params=true`. Omitting it lets Bedrock default to `auto`,
  which still returns normal text.
- ✅ The placeholder tool's description tells the model **never to call it**
  (the same approach as OpenCode's merged fix,
  [PR #18539](https://github.com/anomalyco/opencode/pull/18539)), so summaries
  stay intact — no empty-summary regression.
- ✅ Cross-platform: Windows, macOS, Linux (uses only `node:fs`/`node:os`/
  `node:path` and standard `fetch`).

## Installation

Add it to the `plugin` array in your `opencode.json`
(`~/.config/opencode/opencode.json`):

```jsonc
{
  "plugin": [
    ["github:XuOscar/opencode-bedrock-tools-fix", {
      "providers": ["ibm"],
      "debug": false
    }]
  ]
}
```

Then restart OpenCode.

## Configuration

The plugin accepts an options object:

| Option      | Type       | Default   | Description                                                                 |
| ----------- | ---------- | --------- | --------------------------------------------------------------------------- |
| `providers` | `string[]` | `["ibm"]` | The provider key(s) in your `opencode.json` `provider` block to patch.      |
| `debug`     | `boolean`  | `false`   | When `true`, writes a capped (~1 MB) debug log to your OS temp directory.    |

### Finding your provider key

The `providers` value must match the **key** you use under `provider` in
`opencode.json`. For example, if your config has:

```jsonc
{
  "provider": {
    "ibm": {
      "npm": "@ai-sdk/openai-compatible",
      "options": { "baseURL": "https://your-litellm-gateway/v1" },
      "models": { "claude-opus-4-8": {} }
    }
  }
}
```

then use `"providers": ["ibm"]`.

> **Requirement:** the provider must have a stored auth credential (e.g. you ran
> `opencode auth login <provider>` or it has an API key). The loader only runs
> for providers that have authentication configured.

### Multiple providers

OpenCode allows only one `auth` block per plugin instance, so this plugin hooks
**one** provider per instance. To cover several providers, add the plugin once
per provider:

```jsonc
{
  "plugin": [
    ["github:XuOscar/opencode-bedrock-tools-fix", { "providers": ["ibm"] }],
    ["github:XuOscar/opencode-bedrock-tools-fix", { "providers": ["bedrock-claude"] }]
  ]
}
```

## Debugging

Set `"debug": true` to log what the plugin does. The log is written to:

- Windows: `%TEMP%\opencode-bedrock-tools-fix.log`
- macOS / Linux: `$TMPDIR/opencode-bedrock-tools-fix.log` (usually `/tmp/...`)

Look for lines like:

```
loader() invoked for provider=ibm
[ibm] PATCHED: injected noop tool (model=claude-opus-4-8, messages=1634)
```

The log is capped at ~1 MB and is **off by default**.

## How it works (technical)

OpenCode spreads an `auth.loader` return value into the provider's SDK options.
By returning `{ fetch }`, our wrapper sits in front of every request to that
provider. We parse `init.body`, detect the "tool history + empty tools" case,
add a single no-op function tool, and forward the request. Everything else is
passed through unchanged.

This mirrors how OpenCode's own Snowflake Cortex provider rewrites request
bodies via `options.fetch`.

## License

MIT © XuOscar
