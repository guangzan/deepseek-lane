<div align="center">

# deepseek-lane

A local proxy that connects [Cursor](https://cursor.com) to DeepSeek thinking models (`deepseek-v4-pro` / `deepseek-v4-flash`) via any OpenAI-compatible API. Designed for [opencode](https://opencode.ai) subscriptions, compatible with any DeepSeek API endpoint.

[![Node version](https://img.shields.io/badge/Node.js->=20-3c873a?style=flat-square)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-blue?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Vite+](https://img.shields.io/badge/Vite%2B-purple?style=flat-square)](https://viteplus.dev)
[![License](https://img.shields.io/badge/License-MIT-yellow?style=flat-square)](LICENSE)

[简体中文](./README.zh-CN.md) · [Why this exists](#why-this-exists) · [Features](#features) · [Getting started](#getting-started) · [Usage](#usage) · [Configuration](#configuration) · [Troubleshooting](#troubleshooting)

</div>

---

## Why this exists

DeepSeek [thinking-mode tool calls](https://api-docs.deepseek.com/guides/thinking_mode#tool-calls) require the complete multi-round `reasoning_content` chain to be sent back in later requests. Cursor omits that field, causing a 400 error:

```
Provider returned error: reasoning_content must be passed back to the API.
```

This proxy sits between Cursor and the upstream API, storing and restoring `reasoning_content` so DeepSeek thinking models work correctly in Cursor.

## Features

- **reasoning_content injection** — Restores `reasoning_content` that Cursor omits in tool-call requests, preventing DeepSeek's "reasoning_content must be passed back" error
- **Thinking display** — Mirrors reasoning tokens into Cursor-visible collapsible Markdown blocks (`<details><summary>Thinking</summary>...`)
- **ngrok tunnel** — Auto-starts a public HTTPS tunnel so Cursor can reach the proxy (Cursor blocks non-public API endpoints)
- **Conversation isolation** — Scopes reasoning caches per conversation via SHA-256 hashes, preventing tool-call ID collisions across concurrent threads
- **Context caching compatible** — Never injects synthetic thread IDs or timestamps, preserving DeepSeek's KV cache hit rates
- **Portable cache keys** — Backfills cross-scope portable aliases so reasoning can be recovered even when conversation scope changes
- **Auto-recovery** — Automatically recovers from history gaps when reasoning content is missing from cache, with a system notice explaining the truncated context
- **Legacy API compatibility** — Converts `functions`/`function_call` to `tools`/`tool_choice`, normalizes `reasoning_effort`, strips Cursor thinking blocks from upstream payloads
- **SQLite cache** — Persists reasoning content locally with configurable TTL and row limits
- **Interactive setup wizard** — First-run guided configuration for API provider, model, and tunnel settings

## How it works

Cursor sends requests to the proxy instead of the upstream API. The proxy:

1. **Receives** a `/v1/chat/completions` request from Cursor
2. **Normalizes** the payload — strips unsupported fields, converts legacy function calls, injects cached `reasoning_content` into tool-call messages that Cursor omitted it from
3. **Forwards** the transformed request to the upstream API
4. **Rewrites the response** — for streaming responses, accumulates SSE chunks, mirrors `reasoning_content` into visible Markdown blocks, and caches reasoning content to SQLite for future requests
5. **Returns** the rewritten response to Cursor

The proxy uses SHA-256 hashes of the conversation context as cache keys, ensuring reasoning content is correctly matched across concurrent conversations with overlapping tool-call IDs.

**Model names.** The proxy serves DeepSeek models: `deepseek-v4-pro`, `deepseek-v4-flash`, and the default model from your config. A request for any name that does not start with `deepseek-` is forwarded upstream as the configured default model, and the response keeps the name you requested. Use one of the DeepSeek model names in Cursor unless you intend that substitution, or set `strict_model_names: true` to reject such requests with a `model_not_found` error instead.

## Getting started

### Prerequisites

- [Node.js](https://nodejs.org) 20+

### Step 1: Set up ngrok

Cursor blocks non-public API URLs such as `localhost`, so the proxy needs a public HTTPS URL. [ngrok](https://ngrok.com/) can expose the local proxy without opening router ports.

1. Create a free account at [ngrok.com](https://ngrok.com/)
2. Find your authtoken on the [ngrok dashboard](https://dashboard.ngrok.com)
3. Install and authenticate ngrok once:

```bash
brew install ngrok
ngrok config add-authtoken <your-token>
```

> [!NOTE]
> You do not need to start ngrok manually — the proxy will start it automatically when you run `dsl start`.

> [!TIP]
> You can also use [Cloudflare Tunnel](https://developers.cloudflare.com/tunnel/setup/) as an alternative. If your tool allows localhost API endpoints, skip ngrok with the `--no-ngrok` flag.

### Step 2: Install and start the proxy

```bash
npm install -g deepseek-lane
dsl start
```

On first run, an interactive setup wizard will guide you through configuration: API provider, default model, port, thinking mode, reasoning effort, and ngrok settings. The config is saved to `~/.deepseek-lane/config.yaml`.

When ngrok is enabled, the proxy prints the public URL on startup:

```
✓ Model: deepseek-v4-pro (thinking, max)
▸ Local:  http://127.0.0.1:19199/v1
▸ Public: https://your-tunnel.ngrok-free.dev/v1
```

### Step 3: Configure Cursor

1. Open **Cursor Settings → Models → Add Custom Model**
2. Add a model with the name `deepseek-v4-pro` or `deepseek-v4-flash`
3. Set the API key to your opencode subscription key (or DeepSeek API key)
4. Set the base URL to the ngrok public URL with `/v1` suffix:
   `https://your-tunnel.ngrok-free.dev/v1`
5. Toggle the custom API with `Cmd+Shift+0` (macOS) or `Ctrl+Shift+0`

Select `deepseek-v4-pro` or `deepseek-v4-flash` in the model picker and start chatting.

> [!WARNING]
> Cursor applies **Override OpenAI Base URL** to every OpenAI-family request, not just to the model you added. While that setting is enabled, models picked from Cursor's built-in picker are sent to this proxy as well, and Cursor currently has no per-model carve-out for them. Since the proxy only routes to your configured DeepSeek upstream, built-in models like GPT-5.x will not behave as usual. Turn the override off (or toggle the custom API off with `Cmd+Shift+0` / `Ctrl+Shift+0`) while you use Cursor's built-in models, and turn it back on for `deepseek-v4-pro` / `deepseek-v4-flash`.

## Usage

### CLI commands

```bash
# Start with interactive setup wizard
dsl start

# Stop the proxy
dsl stop

# Restart in background
dsl restart

# Check if running
dsl status

# View recent logs
dsl log
```

### CLI options

```bash
# Use a different port
dsl start --port 9001

# Point to a custom API endpoint
dsl start --base-url https://api.deepseek.com/v1

# Verbose logging
dsl start --verbose

# Run without ngrok (local-only)
dsl start --no-ngrok

# Clear the reasoning cache
dsl start --clear-reasoning-cache

# Skip interactive wizard
dsl start --no-interactive
```

| Option                                                   | Description                                 |
| -------------------------------------------------------- | ------------------------------------------- |
| `--config <path>`                                        | Config file path                            |
| `--host <host>`                                          | Bind host (default: `127.0.0.1`)            |
| `--port <port>`                                          | Bind port (default: `19199`)                |
| `--model <model>`                                        | Upstream model name                         |
| `--strict-model-names` / `--no-strict-model-names`       | Reject model names the proxy does not serve |
| `--base-url <url>`                                       | Upstream API base URL                       |
| `--thinking <mode>`                                      | Thinking mode: `enabled` / `disabled`       |
| `--reasoning-effort <level>`                             | `low` / `medium` / `high` / `max` / `xhigh` |
| `--request-timeout <s>`                                  | Upstream request timeout in seconds         |
| `--missing-reasoning-strategy <s>`                       | `recover` (default) or `reject`             |
| `--clear-reasoning-cache`                                | Clear the local reasoning cache and exit    |
| `--ngrok` / `--no-ngrok`                                 | Enable/disable ngrok tunnel                 |
| `--verbose` / `--no-verbose`                             | Enable/disable verbose logging              |
| `--display-reasoning` / `--no-display-reasoning`         | Show reasoning in visible content           |
| `--collapsible-reasoning` / `--no-collapsible-reasoning` | Use collapsible Markdown for reasoning      |

## Configuration

Auto-generated at `~/.deepseek-lane/config.yaml` on first run:

```yaml
base_url: https://opencode.ai/zen/go/v1
model: deepseek-v4-pro
strict_model_names: false
thinking: enabled
reasoning_effort: medium
display_reasoning: true
collapsible_reasoning: true

host: 127.0.0.1
port: 19199
ngrok: true
verbose: false
request_timeout: 300
max_request_body_bytes: 20971520

missing_reasoning_strategy: recover
reasoning_cache_max_age_seconds: 2592000
reasoning_cache_max_rows: 100000
```

CLI flags override config file values.

### Data files

| Path                                         | Description             |
| -------------------------------------------- | ----------------------- |
| `~/.deepseek-lane/config.yaml`               | Configuration file      |
| `~/.deepseek-lane/reasoning_content.sqlite3` | Reasoning content cache |
| `~/.deepseek-lane/pid`                       | Process ID file         |
| `~/.deepseek-lane/log`                       | Log output              |

## API endpoints

### `POST /v1/chat/completions`

Main endpoint. Accepts the standard OpenAI chat completions format. Requires `Authorization: Bearer <key>` header.

### `GET /v1/models`

Returns available model list.

### `GET /healthz`

Health check — returns `{"ok": true}`.

## Project structure

```
deepseek-lane/
├── packages/
│   ├── core/                 @deepseek-lane/core
│   │   ├── src/config.ts           YAML config loading, CLI arg merging
│   │   ├── src/logging.ts          Colored terminal output
│   │   ├── src/reasoning-store.ts  SQLite reasoning cache
│   │   ├── src/server.ts           Hono HTTP server, request routing, streaming
│   │   ├── src/streaming.ts        SSE stream accumulator, display adapter
│   │   ├── src/transform.ts        Request normalization, recovery logic
│   │   ├── src/tunnel.ts           ngrok subprocess management
│   │   ├── src/types.ts            TypeScript type definitions
│   │   └── src/__tests__/          Test suite
│   └── cli/                  deepseek-lane
│       ├── src/cli.ts              Commander-based CLI entry point
│       ├── src/daemon.ts           PID management, background process
│       └── src/commands/           start, stop, restart, status, log
├── vite.config.ts                  Vite+ configuration
├── tsconfig.base.json              Shared TypeScript config
└── package.json                    Workspace root
```

## Troubleshooting

**Proxy won't start, port in use**

```bash
lsof -ti:19199 | xargs kill
```

**ngrok errors**

Ensure ngrok is installed and authenticated:

```bash
ngrok config check
```

The proxy looks for the ngrok API at `http://127.0.0.1:4040/api`.

**Built-in models (GPT-5.x, o-series) stopped working**

Cursor's **Override OpenAI Base URL** setting covers every OpenAI-family request, so models picked from the built-in picker are routed to this proxy while it is enabled. The proxy only forwards to your DeepSeek upstream, so those requests either come back from DeepSeek or are reported as unavailable. Turn the override off (or toggle the custom API off) while using Cursor's built-in models.

**"reasoning_content must be passed back"**

This error means the reasoning cache was cleared or missed. The default `recover` strategy handles this automatically. If the issue persists, clear the cache:

```bash
dsl start --clear-reasoning-cache
```

**Verbose debugging**

Run with full request/response logging:

```bash
dsl start --verbose --no-ngrok
```

## Development

```bash
git clone <your-repo-url>
cd deepseek-lane
vp install
```

| Command    | Description                             |
| ---------- | --------------------------------------- |
| `vp dev`   | Start with auto-reload and `--no-ngrok` |
| `vp test`  | Run test suite                          |
| `vp check` | Lint, format, and type check            |
| `vp fmt`   | Format all source files                 |
| `vp pack`  | Build the core library                  |

## Acknowledgments

Inspired by [yxlao/deepseek-cursor-proxy](https://github.com/yxlao/deepseek-cursor-proxy).
