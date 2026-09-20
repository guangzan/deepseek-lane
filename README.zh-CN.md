<div align="center">

# deepseek-lane

本地代理，将 [Cursor](https://cursor.com) 连接到 DeepSeek 推理模型（`deepseek-v4-pro` / `deepseek-v4-flash`），支持任意 OpenAI 兼容 API。专为 [opencode](https://opencode.ai) 订阅设计，也兼容任意 DeepSeek API 端点。

[![Node version](https://img.shields.io/badge/Node.js->=20-3c873a?style=flat-square)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-blue?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Vite+](https://img.shields.io/badge/Vite%2B-purple?style=flat-square)](https://viteplus.dev)
[![License](https://img.shields.io/badge/License-MIT-yellow?style=flat-square)](LICENSE)

[English](./README.md) · [为什么需要它](#为什么需要它) · [功能特性](#功能特性) · [快速开始](#快速开始) · [使用说明](#使用说明) · [配置](#配置) · [常见问题](#常见问题)

</div>

---

## 为什么需要它

DeepSeek [思考模式工具调用](https://api-docs.deepseek.com/guides/thinking_mode#tool-calls)要求在后续请求中回传完整的多轮 `reasoning_content` 链。Cursor 遗漏了该字段，导致 400 错误：

```
Provider returned error: reasoning_content must be passed back to the API.
```

本代理位于 Cursor 和上游 API 之间，存储并恢复 `reasoning_content`，使 DeepSeek 推理模型在 Cursor 中正常工作。

## 功能特性

- **reasoning_content 注入** — 自动补全 Cursor 在 tool-call 请求中遗漏的 `reasoning_content` 字段，避免 DeepSeek 报 "reasoning_content must be passed back" 错误
- **推理过程显示** — 将推理 token 转换为 Cursor 可折叠 Markdown 块（`<details><summary>Thinking</summary>...`）
- **ngrok 隧道** — 自动启动公网 HTTPS 隧道，满足 Cursor 的公网 API 限制
- **会话隔离** — 通过 SHA-256 哈希对推理缓存进行会话级隔离，避免并发对话中 tool-call ID 冲突
- **上下文缓存兼容** — 不注入额外线程 ID 或时间戳，保留 DeepSeek 的 KV 缓存命中率
- **便携缓存键** — 自动回填跨作用域的便携别名，即使会话作用域变化也能恢复推理内容
- **自动恢复** — 当缓存中找不到推理内容时自动恢复对话历史，并通过系统消息告知上下文截断
- **旧版 API 兼容** — 自动转换 `functions`/`function_call` 为 `tools`/`tool_choice`，标准化 `reasoning_effort`，清除 Cursor 思考块
- **SQLite 缓存** — 将推理内容持久化到本地 SQLite，支持 TTL 和行数限制
- **交互式安装向导** — 首次运行时引导配置 API 提供商、模型和隧道设置

## 工作原理

Cursor 将请求发送给代理而非直接调用上游 API。代理的执行流程：

1. **接收** Cursor 的 `/v1/chat/completions` 请求
2. **规范化** — 过滤不支持的字段、转换旧版 function calls、从缓存注入 Cursor 遗漏的 `reasoning_content`
3. **转发** 转换后的请求到上游 API
4. **改写响应** — 对流式响应进行 SSE 累积，将 `reasoning_content` 镜像到可见 Markdown 块中，同时缓存到 SQLite
5. **返回** 改写后的响应给 Cursor

代理使用对话上下文的 SHA-256 哈希作为缓存键，确保在并发对话中也能正确匹配推理内容。

**模型名称。** 代理服务的是 DeepSeek 模型：`deepseek-v4-pro`、`deepseek-v4-flash`，以及你配置中的默认模型。任何不以 `deepseek-` 开头的模型名都会被当作默认模型发往上游，而响应会保留你请求时用的名字。除非你确实想要这种替换，否则请在 Cursor 里使用 DeepSeek 模型名；也可以把 `strict_model_names` 设为 `true`，让这类请求直接收到 `model_not_found` 错误。

## 快速开始

### 前置要求

- [Node.js](https://nodejs.org) 20+

### 第一步：设置 ngrok

Cursor 不允许使用 `localhost` 等非公网 API 地址，因此代理需要一个公网 HTTPS 地址。[ngrok](https://ngrok.com/) 可以暴露本地代理而无需开放路由端口。

1. 在 [ngrok.com](https://ngrok.com/) 注册免费账户
2. 在 [ngrok 控制台](https://dashboard.ngrok.com)获取 authtoken
3. 安装并认证 ngrok（只需一次）：

```bash
brew install ngrok
ngrok config add-authtoken <你的-token>
```

> [!NOTE]
> 无需手动启动 ngrok — 运行 `dsl start` 时代理会自动启动 ngrok。

> [!TIP]
> 你也可以使用 [Cloudflare Tunnel](https://developers.cloudflare.com/tunnel/setup/) 作为替代方案。如果你使用的工具允许 localhost API 端点，可以通过 `--no-ngrok` 跳过 ngrok。

### 第二步：安装并启动代理

```bash
npm install -g deepseek-lane
dsl start
```

首次运行时，交互式安装向导会引导你配置：API 提供商、默认模型、端口、思考模式、推理力度和 ngrok 设置。配置保存到 `~/.deepseek-lane/config.yaml`。

启用 ngrok 时，启动后会打印公网地址：

```
✓ Model: deepseek-v4-pro (thinking, max)
▸ Local:  http://127.0.0.1:19199/v1
▸ Public: https://你的隧道.ngrok-free.dev/v1
```

### 第三步：配置 Cursor

1. 打开 **Cursor Settings → Models → Add Custom Model**
2. 添加模型，名称填写 `deepseek-v4-pro` 或 `deepseek-v4-flash`
3. API Key 填写你的 opencode 订阅密钥（或 DeepSeek API Key）
4. Base URL 填写启动时打印的 ngrok 公网地址，加上 `/v1` 后缀：
   `https://你的隧道.ngrok-free.dev/v1`
5. 使用 `Cmd+Shift+0`（Mac）或 `Ctrl+Shift+0`（Windows/Linux）切换自定义 API

在模型选择器中选择 `deepseek-v4-pro` 或 `deepseek-v4-flash` 即可开始对话。

> [!WARNING]
> Cursor 的 **Override OpenAI Base URL** 作用于**全部** OpenAI 系列请求，而不只是你添加的那个模型。该设置开启期间，从内置模型选择器里选中的模型同样会被发到本代理，且 Cursor 目前没有为内置模型保留例外。本代理只会把请求转发到你配置的 DeepSeek 上游，因此 GPT-5.x 这类内置模型不会按平常的方式工作。使用内置模型时请关闭该覆盖（或用 `Cmd+Shift+0` / `Ctrl+Shift+0` 关闭自定义 API），使用 `deepseek-v4-pro` / `deepseek-v4-flash` 时再打开。

## 使用说明

### CLI 命令

```bash
# 启动（带交互式向导）
dsl start

# 停止代理
dsl stop

# 后台重启
dsl restart

# 查看运行状态
dsl status

# 查看日志
dsl log
```

### CLI 选项

```bash
# 使用不同端口
dsl start --port 9001

# 自定义 API 端点
dsl start --base-url https://api.deepseek.com/v1

# 详细日志
dsl start --verbose

# 不带 ngrok 启动（仅本地）
dsl start --no-ngrok

# 清空推理缓存
dsl start --clear-reasoning-cache

# 跳过交互式向导
dsl start --no-interactive
```

| 选项                                                     | 说明                                        |
| -------------------------------------------------------- | ------------------------------------------- |
| `--config <path>`                                        | 配置文件路径                                |
| `--host <host>`                                          | 绑定地址（默认 `127.0.0.1`）                |
| `--port <port>`                                          | 绑定端口（默认 `19199`）                    |
| `--model <model>`                                        | 上游模型名称                                |
| `--strict-model-names` / `--no-strict-model-names`       | 拒绝本代理不服务的模型名                    |
| `--base-url <url>`                                       | 上游 API 地址                               |
| `--thinking <mode>`                                      | 思考模式：`enabled` / `disabled`            |
| `--reasoning-effort <level>`                             | `low` / `medium` / `high` / `max` / `xhigh` |
| `--request-timeout <s>`                                  | 上游请求超时（秒）                          |
| `--missing-reasoning-strategy <s>`                       | `recover`（默认）或 `reject`                |
| `--clear-reasoning-cache`                                | 清空本地推理缓存                            |
| `--ngrok` / `--no-ngrok`                                 | 启用/禁用 ngrok 隧道                        |
| `--verbose` / `--no-verbose`                             | 启用/禁用详细日志                           |
| `--display-reasoning` / `--no-display-reasoning`         | 在可见内容中显示推理过程                    |
| `--collapsible-reasoning` / `--no-collapsible-reasoning` | 使用可折叠 Markdown 显示推理                |

## 配置

首次运行自动生成 `~/.deepseek-lane/config.yaml`：

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

CLI 参数优先级高于配置文件。

### 数据文件

| 路径                                         | 说明         |
| -------------------------------------------- | ------------ |
| `~/.deepseek-lane/config.yaml`               | 配置文件     |
| `~/.deepseek-lane/reasoning_content.sqlite3` | 推理内容缓存 |
| `~/.deepseek-lane/pid`                       | 进程 ID 文件 |
| `~/.deepseek-lane/log`                       | 日志输出     |

## API 接口

### `POST /v1/chat/completions`

主接口。接受标准 OpenAI chat completions 格式，需要 `Authorization: Bearer <密钥>` 请求头。

### `GET /v1/models`

返回可用模型列表。

### `GET /healthz`

健康检查 — 返回 `{"ok": true}`。

## 项目结构

```
deepseek-lane/
├── packages/
│   ├── core/                 @deepseek-lane/core
│   │   ├── src/config.ts           YAML 配置加载
│   │   ├── src/logging.ts          彩色终端输出
│   │   ├── src/reasoning-store.ts  SQLite 推理缓存
│   │   ├── src/server.ts           Hono HTTP 服务
│   │   ├── src/streaming.ts        SSE 流处理
│   │   ├── src/transform.ts        请求规范化与恢复
│   │   ├── src/tunnel.ts           ngrok 管理
│   │   ├── src/types.ts            类型定义
│   │   └── src/__tests__/          测试套件
│   └── cli/                  deepseek-lane
│       ├── src/cli.ts              Commander CLI 入口
│       ├── src/daemon.ts           PID 管理、后台进程
│       └── src/commands/           start, stop, restart, status, log
├── vite.config.ts                  Vite+ 配置
├── tsconfig.base.json              共享 TypeScript 配置
└── package.json                    工作区根
```

## 常见问题

**代理无法启动，端口被占用**

```bash
lsof -ti:19199 | xargs kill
```

**ngrok 错误**

确保 ngrok 已安装并认证：

```bash
ngrok config check
```

代理访问 ngrok API 的地址为 `http://127.0.0.1:4040/api`。

**内置模型（GPT-5.x、o 系列）不可用**

Cursor 的 **Override OpenAI Base URL** 覆盖全部 OpenAI 系列请求，因此该设置开启时，从内置模型选择器里选中的模型也会被发到本代理。本代理只会转发到你配置的 DeepSeek 上游，这些请求要么由 DeepSeek 回答，要么被告知模型不可用。使用 Cursor 内置模型时请关闭该覆盖（或关闭自定义 API）。

**"reasoning_content must be passed back" 错误**

此错误说明推理缓存已清除或未命中。默认的 `recover` 策略会自动恢复。如果问题持续存在，可清空缓存：

```bash
dsl start --clear-reasoning-cache
```

**调试模式**

开启完整请求/响应日志：

```bash
dsl start --verbose --no-ngrok
```

## 开发

```bash
git clone <你的仓库地址>
cd deepseek-lane
vp install
```

| 命令       | 说明                                  |
| ---------- | ------------------------------------- |
| `vp dev`   | 开发模式（热重载 + `--no-ngrok`）     |
| `vp test`  | 运行测试                              |
| `vp check` | 代码检查（lint + format + typecheck） |
| `vp fmt`   | 格式化代码                            |
| `vp pack`  | 构建核心库                            |

## 致谢

灵感来源于 [yxlao/deepseek-cursor-proxy](https://github.com/yxlao/deepseek-cursor-proxy)。
