# opencode-bedrock-tools-fix

**English** | [中文](#中文说明)

An [OpenCode](https://opencode.ai) plugin that fixes **two** errors hit by
Claude models served through a LiteLLM → AWS Bedrock gateway (via the
`@ai-sdk/openai-compatible` transport, where OpenCode's own request
normalizers don't apply):

**Problem 1 — missing `tools` on compaction:**

```
litellm.UnsupportedParamsError: Bedrock doesn't support tool calling without
`tools=` param specified. Pass `tools=` param OR set
`litellm.modify_params = True` // `litellm_settings::modify_params: True`
to add dummy tool to the request.
```

**Problem 2 — assistant message prefill (often shows only as "terminated"):**

```
This model does not support assistant message prefill.
The conversation must end with a user message.
```

## Problem 1 — missing `tools` array

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

## Problem 2 — assistant message prefill

Anthropic removed **assistant message prefill** support in Claude Opus 4.6+
(including Opus 4.8). The API now rejects any request whose `messages` array
**ends with an `assistant` message**:

```
This model does not support assistant message prefill.
The conversation must end with a user message.
```

OpenCode's agentic loop sometimes builds a request that ends with an assistant
turn (a finished text reply with no following tool call, an interrupted turn,
or a max-steps hint), which triggers this 400.

OpenCode *does* strip trailing assistant messages before sending — **but only
for the `@ai-sdk/anthropic` and `@ai-sdk/amazon-bedrock` transports**
(see `normalizeMessages` in `provider/transform.ts`). A custom provider using
`@ai-sdk/openai-compatible` (e.g. an IBM / LiteLLM gateway) is **not** covered,
so the trailing assistant is never stripped and the request fails.

Worse, because OpenCode streams by default, this 400 is returned with an empty
body and surfaces in the UI only as a generic **"terminated"** — the session
appears to stop with no clear error.

## The Fix

This plugin registers a custom `fetch` for the configured provider(s) — using
the same `auth.loader` mechanism OpenCode's own built-in providers (GitHub
Copilot, Codex, xAI, Snowflake) use — and patches each outgoing POST:

**For Problem 1:** if the body has tool-call history but an empty/missing
`tools` array, it injects a single harmless **no-op placeholder tool** so the
request passes validation.

**For Problem 2:** it **strips any trailing prefill assistant message(s)** so
the conversation ends on a non-assistant message — replicating client-side what
OpenCode's `stripTrailingAssistant()` does, but for the openai-compatible
transport it skips. An assistant turn that carries **tool calls** is a
legitimate tool-use turn and is **never stripped**.

- ✅ Only patches the offending requests. Normal requests pass through **untouched**.
- ✅ Never strips an assistant message that has `tool_calls` / `tool_use` blocks
  (only pure prefill text turns are removed), so tool-use loops keep working.
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
[ibm] TOOLS-FIX: injected noop tool (model=claude-opus-4-8, messages=1634)
[ibm] PREFILL-FIX: stripped 1 trailing assistant message(s) (model=claude-opus-4-8, messages now=715)
```

The log is capped at ~1 MB and is **off by default**.

## How it works (technical)

OpenCode spreads an `auth.loader` return value into the provider's SDK options.
By returning `{ fetch }`, our wrapper sits in front of every request to that
provider. For each outgoing POST we parse `init.body` and:

1. **strip trailing prefill assistant message(s)** — any assistant turn at the
   end of `messages` that has no tool calls (Problem 2); then
2. **inject a no-op tool** if there is tool-call history but an empty `tools`
   array (Problem 1).

Then we forward the request. Everything else is passed through unchanged. This
mirrors how OpenCode's own Snowflake Cortex provider rewrites request bodies via
`options.fetch`.

> **Note:** the plugin entry is the compiled `index.js`. Node cannot strip
> TypeScript types for files under `node_modules`, so plugins referenced from
> git/npm must ship compiled JavaScript (the source `index.ts` is included for
> reference only).

## License

MIT © XuOscar

---

# 中文说明

[English](#opencode-bedrock-tools-fix) | **中文**

一个 [OpenCode](https://opencode.ai) 插件，修复经由 LiteLLM → AWS Bedrock 网关
（走 `@ai-sdk/openai-compatible` 传输，OpenCode 自带的请求规范化逻辑对它不生效）
使用 Claude 模型时遇到的**两个**错误：

**问题 1 —— 压缩时缺少 `tools`：**

```
litellm.UnsupportedParamsError: Bedrock doesn't support tool calling without
`tools=` param specified. Pass `tools=` param OR set
`litellm.modify_params = True` // `litellm_settings::modify_params: True`
to add dummy tool to the request.
```

**问题 2 —— assistant 消息 prefill（界面上常只显示为 “terminated”）：**

```
This model does not support assistant message prefill.
The conversation must end with a user message.
```

## 问题 1 —— 缺少 `tools` 数组

当会话接近上下文窗口上限时，OpenCode 会自动**压缩（总结）**对话。这个压缩请求
会带上完整的历史消息——其中包含之前工具调用产生的 `tool_use` / `tool_result`
块——但它发送的是一个**空的 `tools` 数组**。

经由 **LiteLLM** 转发到 AWS Bedrock 的严格网关会拒绝这种组合（历史里有工具调用，
却没有声明 `tools`），返回 `400 UnsupportedParamsError`。手动执行 `/compact` 也会
触发同样的错误。

网关侧的“官方”修复方法是设置 `litellm_settings: { modify_params: true }`，
但如果这个 LiteLLM 代理不归你控制（例如托管/企业版端点），你就改不了它。

## 问题 2 —— assistant 消息 prefill

Anthropic 在 Claude Opus 4.6+（含 Opus 4.8）移除了 **assistant 消息 prefill**
支持。现在只要请求的 `messages` 数组**以 `assistant` 消息结尾**，API 就会拒绝：

```
This model does not support assistant message prefill.
The conversation must end with a user message.
```

OpenCode 的 agentic 循环有时会构造出以 assistant 结尾的请求（一条已完成、后面没有
工具调用的文本回复；被中断的回合；或 max-steps 提示），从而触发这个 400。

OpenCode **确实**会在发送前剥掉末尾的 assistant 消息——**但只对
`@ai-sdk/anthropic` 和 `@ai-sdk/amazon-bedrock` 这两种传输生效**
（见 `provider/transform.ts` 的 `normalizeMessages`）。使用
`@ai-sdk/openai-compatible` 的自定义 provider（例如 IBM / LiteLLM 网关）**不在
覆盖范围内**，末尾 assistant 不会被剥掉，于是请求失败。

更糟的是：由于 OpenCode 默认流式传输，这个 400 返回的响应体是空的，界面上往往
只表现为一个笼统的 **“terminated”**——会话像是无故停住，看不到明确错误。

## 解决方案

本插件为配置的 provider 注册一个自定义 `fetch`——使用的正是 OpenCode 自带
provider（GitHub Copilot、Codex、xAI、Snowflake）所用的同一套 `auth.loader`
机制——对每个发出的 POST 请求做两件事：

**针对问题 1：** 若请求体中含有工具调用历史、但 `tools` 数组为空/缺失，注入一个
无害的 **no-op 占位工具**，让请求通过校验。

**针对问题 2：** **剥掉末尾的 prefill assistant 消息**，让对话以非 assistant 结尾
——在客户端复刻 OpenCode 的 `stripTrailingAssistant()`，补上它对 openai-compatible
传输漏做的那部分。带有**工具调用**的 assistant 回合是合法的工具使用消息，**绝不
会被剥掉**。

- ✅ 只修补有问题的请求。普通请求**原样放行**。
- ✅ 绝不剥掉带 `tool_calls` / `tool_use` 块的 assistant 消息（只移除纯 prefill
  文本回合），因此工具调用循环照常工作。
- ✅ **不碰**你的 API key——只是加了一层 `fetch` 包装；OpenCode 仍使用你已为该
  provider 配置好的 key。
- ✅ **不设置** `tool_choice`。Bedrock 的 `ToolChoice` 只支持 `auto`/`any`/`tool`
  （没有 `none`）；发送 `none` 会导致**新的** 400 错误，除非代理开启了
  `drop_params=true`。省略它会让 Bedrock 默认用 `auto`，仍能正常输出文本。
- ✅ 占位工具的描述明确告诉模型**绝不要调用它**（与 OpenCode 已合并的修复
  [PR #18539](https://github.com/anomalyco/opencode/pull/18539) 思路一致），
  因此摘要内容完好——不会出现空摘要的回归问题。
- ✅ 跨平台：Windows、macOS、Linux（仅用 `node:fs`/`node:os`/`node:path` 和标准
  `fetch`）。

## 安装

把它加到 `opencode.json`（`~/.config/opencode/opencode.json`）的 `plugin` 数组里：

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

然后重启 OpenCode。

## 配置项

插件接受一个 options 对象：

| 选项        | 类型       | 默认值    | 说明                                                                  |
| ----------- | ---------- | --------- | --------------------------------------------------------------------- |
| `providers` | `string[]` | `["ibm"]` | 需要修补的 provider key（对应 `opencode.json` 中 `provider` 下的键）。 |
| `debug`     | `boolean`  | `false`   | 设为 `true` 时，会向系统临时目录写入一份带上限（~1 MB）的调试日志。    |

### 如何确定你的 provider key

`providers` 的值必须与你 `opencode.json` 中 `provider` 下使用的**键名**一致。
例如，如果你的配置是：

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

那么就用 `"providers": ["ibm"]`。

> **前提条件：** 该 provider 必须有已存储的认证凭证（例如你运行过
> `opencode auth login <provider>`，或它配置了 API key）。loader 只会对已配置
> 认证的 provider 运行。

### 多个 provider

OpenCode 每个插件实例只允许一个 `auth` 块，所以本插件每个实例只 hook **一个**
provider。若要覆盖多个 provider，请按 provider 多次添加本插件：

```jsonc
{
  "plugin": [
    ["github:XuOscar/opencode-bedrock-tools-fix", { "providers": ["ibm"] }],
    ["github:XuOscar/opencode-bedrock-tools-fix", { "providers": ["bedrock-claude"] }]
  ]
}
```

## 调试

设置 `"debug": true` 可记录插件的行为。日志写入位置：

- Windows：`%TEMP%\opencode-bedrock-tools-fix.log`
- macOS / Linux：`$TMPDIR/opencode-bedrock-tools-fix.log`（通常是 `/tmp/...`）

留意类似这样的行：

```
loader() invoked for provider=ibm
[ibm] TOOLS-FIX: injected noop tool (model=claude-opus-4-8, messages=1634)
[ibm] PREFILL-FIX: stripped 1 trailing assistant message(s) (model=claude-opus-4-8, messages now=715)
```

日志有 ~1 MB 上限，且**默认关闭**。

## 工作原理（技术细节）

OpenCode 会把 `auth.loader` 的返回值展开合并进该 provider 的 SDK 选项。通过返回
`{ fetch }`，我们的包装函数就坐落在发往该 provider 的每个请求之前。对每个发出的
POST 请求，我们解析 `init.body` 并：

1. **剥掉末尾的 prefill assistant 消息**——`messages` 末尾任何没有工具调用的
   assistant 回合（问题 2）；然后
2. **注入 no-op 工具**——若存在工具调用历史但 `tools` 数组为空（问题 1）。

随后转发请求。其余一切原样放行。

这与 OpenCode 自带的 Snowflake Cortex provider 通过 `options.fetch` 改写请求体的
做法如出一辙。

> **注意：** 插件入口是编译后的 `index.js`。Node 无法对 `node_modules` 下的
> TypeScript 文件做类型剥离，因此通过 git/npm 引用的插件必须发布编译好的
> JavaScript（源码 `index.ts` 仅作参考保留）。

## 许可证

MIT © XuOscar
