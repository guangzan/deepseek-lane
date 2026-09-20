import { Hono } from "hono";
import type { Context } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { serve } from "@hono/node-server";
import type { Ora } from "ora";
import { ProxyConfig, ChatMessage } from "./types.js";
import type { PreparedRequest } from "./schemas.js";
import { ReasoningStore, conversationScope } from "./reasoning-store.js";
import { prepareUpstreamRequest, rewriteResponseBody, isServedModel } from "./transform.js";
import { StreamAccumulator, CursorReasoningDisplayAdapter } from "./streaming.js";
import {
  log,
  logInfo,
  logWarn,
  logError,
  logVerbose,
  logJson,
  createSpinner,
  boxChar,
} from "./logging.js";
import { NgrokTunnel, localTunnelTarget } from "./tunnel.js";
import { setVerbose } from "./logging.js";

const RECOVERY_NOTICE_CONTENT = "[cursor-deepseek] Refreshed reasoning_content history.\n\n";

function sseData(payload: Record<string, unknown>): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function recoveryNoticeChunk(model: string): Record<string, unknown> {
  return {
    id: "chatcmpl-cursor-deepseek-recovery",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta: { content: RECOVERY_NOTICE_CONTENT }, finish_reason: null }],
  };
}

function injectRecoveryNotice(chunk: Record<string, unknown>, notice: string): boolean {
  const choices = chunk.choices as unknown[];
  if (!Array.isArray(choices)) return false;

  for (const choice of choices) {
    if (typeof choice !== "object" || choice === null) continue;
    const c = choice as Record<string, unknown>;
    const delta = c.delta as Record<string, unknown> | undefined;
    if (!delta) continue;
    if (!("content" in delta) && !delta.tool_calls) continue;
    const existing = delta.content;
    delta.content = notice + (typeof existing === "string" ? existing : "");
    return true;
  }
  return false;
}

interface UsageInfo {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  completion_tokens_details?: { reasoning_tokens?: number };
}

async function proxyToUpstream(
  url: string,
  body: string,
  headers: Record<string, string>,
  timeout: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout * 1000);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body,
      signal: controller.signal,
    });
    return response;
  } finally {
    clearTimeout(timer);
  }
}

// Models this proxy advertises over /v1/models and accepts by name.
function servedModelIds(config: ProxyConfig): string[] {
  return [...new Set([config.upstreamModel, "deepseek-v4-pro", "deepseek-v4-flash"])];
}

export function createApp(config: ProxyConfig, store: ReasoningStore) {
  const app = new Hono();

  app.use(
    "/v1/*",
    cors({
      origin: "*",
      allowMethods: ["POST", "GET", "OPTIONS"],
      allowHeaders: ["Origin", "Content-Type", "Accept", "Authorization"],
      exposeHeaders: ["Content-Length"],
      credentials: true,
    }),
  );

  app.use("/v1/*", async (c, next) => {
    setVerbose(config.verbose);
    await next();
  });

  // Health check
  app.get("/healthz", (c) => c.json({ ok: true }));
  app.get("/v1/healthz", (c) => c.json({ ok: true }));

  // Models list
  app.get("/v1/models", (c) => {
    const created = Math.floor(Date.now() / 1000);
    const modelIds = servedModelIds(config);
    const models = modelIds.map((id) => ({
      id,
      object: "model",
      created,
      owned_by: "deepseek",
    }));
    return c.json({ object: "list", data: models });
  });

  // Chat completions
  app.post("/v1/chat/completions", async (c) => {
    const started = Date.now();

    // Auth
    const authHeader = c.req.header("Authorization") || "";
    if (!authHeader.toLowerCase().startsWith("bearer ") || !authHeader.slice(7).trim()) {
      return c.json(
        { error: { message: "Missing Authorization bearer token" } },
        401 as ContentfulStatusCode,
      );
    }

    // Read body
    let payload: Record<string, unknown>;
    try {
      payload = await c.req.json();
    } catch {
      return c.json({ error: { message: "Invalid JSON body" } }, 400 as ContentfulStatusCode);
    }

    const bodyStr = JSON.stringify(payload);
    if (bodyStr.length > config.maxRequestBodyBytes) {
      return c.json(
        {
          error: {
            message: `Request body is too large; limit is ${config.maxRequestBodyBytes} bytes`,
          },
        },
        413 as ContentfulStatusCode,
      );
    }

    if (config.verbose) {
      logJson("cursor request body", payload);
    }

    const model = typeof payload.model === "string" ? payload.model : config.upstreamModel;
    if (config.strictModelNames && !isServedModel(model, config)) {
      logWarn(`rejecting unsupported model ${model}; strict_model_names is enabled`);
      return c.json(
        {
          error: {
            message: `The model \`${model}\` is not served by this proxy. Use ${servedModelIds(config).join(", ")}.`,
            type: "invalid_request_error",
            code: "model_not_found",
          },
        },
        404 as ContentfulStatusCode,
      );
    }
    logInfo(
      `${boxChar.topLeft} request model=${model} effort=${config.reasoningEffort} messages=${(payload.messages as unknown[])?.length ?? 0}`,
    );

    // Prepare upstream request
    const prepared = prepareUpstreamRequest(payload, config, store, authHeader);

    if (config.verbose) {
      logJson("upstream request body", prepared.payload);
    }

    const upstreamBody = JSON.stringify(prepared.payload);
    const upstreamUrl = `${config.upstreamBaseUrl}/chat/completions`;
    const isStream = Boolean(prepared.payload.stream);

    const upstreamHeaders: Record<string, string> = {
      Authorization: authHeader,
      "Content-Type": "application/json",
      Accept: isStream ? "text/event-stream" : "application/json",
      "Accept-Encoding": "identity",
      "User-Agent": "cursor-deepseek/0.1",
    };

    const acceptLang = c.req.header("Accept-Language");
    if (acceptLang) upstreamHeaders["Accept-Language"] = acceptLang;

    if (config.verbose) {
      logInfo(
        `${boxChar.tee} send upstream_model=${prepared.upstreamModel} patched_reasoning=${prepared.patchedReasoningMessages} missing_reasoning=${prepared.missingReasoningMessages}`,
      );
    }

    const spinner = createSpinner(`${boxChar.bottomTee} waiting...`);

    try {
      const upstreamRes = await proxyToUpstream(
        upstreamUrl,
        upstreamBody,
        upstreamHeaders,
        config.requestTimeout,
      );

      if (!upstreamRes.ok) {
        const errorBody = await upstreamRes.text();
        logWarn(`upstream error status=${upstreamRes.status} elapsed=${Date.now() - started}ms`);
        try {
          return c.json(JSON.parse(errorBody), upstreamRes.status as ContentfulStatusCode);
        } catch {
          return c.json(
            { error: { message: `Upstream returned status ${upstreamRes.status}` } },
            upstreamRes.status as ContentfulStatusCode,
          );
        }
      }

      if (isStream) {
        return handleStreamingResponse(c, upstreamRes, prepared, config, store, spinner);
      } else {
        return handleRegularResponse(c, upstreamRes, prepared, config, store, started);
      }
    } catch (err) {
      spinner.stop();
      const msg = err instanceof Error ? err.message : String(err);
      logError(`upstream request failed: ${msg}`);
      return c.json(
        { error: { message: `Upstream request failed: ${msg}` } },
        502 as ContentfulStatusCode,
      );
    }
  });

  return app;
}

async function handleStreamingResponse(
  c: Context,
  upstreamRes: Response,
  prepared: PreparedRequest,
  config: ProxyConfig,
  store: ReasoningStore,
  spinner: Ora,
): Promise<Response> {
  return streamSSE(c, async (stream) => {
    let usage: UsageInfo | undefined;
    const accumulator = new StreamAccumulator();
    const displayAdapter = config.displayReasoning
      ? new CursorReasoningDisplayAdapter(config.collapsibleReasoning)
      : null;
    const scope =
      prepared.recordResponseScope ??
      conversationScope(prepared.recordResponseMessages, prepared.cacheNamespace);
    const responsePriorMessages = prepared.recordResponseMessages;
    const responseContexts: [string, ChatMessage[]][] = prepared.recordResponseContexts ?? [
      [scope, responsePriorMessages],
    ];
    let finalized = false;
    let pendingRecoveryNotice: string | null = prepared.recoveryNotice;

    try {
      const reader = upstreamRes.body?.getReader();
      if (!reader) {
        spinner.stop();
        return;
      }

      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (line.trim().startsWith("data:")) {
            const data = line.trim().slice(5).trim();
            if (data === "[DONE]") {
              const stored = responseContexts.reduce(
                (sum, [ctxScope, ctxPrior]) =>
                  sum +
                  accumulator.storeReasoning(store, ctxScope, prepared.cacheNamespace, ctxPrior),
                0,
              );
              if (config.verbose && stored) logVerbose(`stored ${stored} reasoning cache key(s)`);

              let prefix = "";
              if (displayAdapter) {
                const closingChunk = displayAdapter.flushChunk(prepared.originalModel);
                if (closingChunk) prefix += sseData(closingChunk);
              }
              if (pendingRecoveryNotice) {
                prefix += sseData(recoveryNoticeChunk(prepared.originalModel));
              }
              await stream.write(prefix + "data: [DONE]\n\n");
              finalized = true;
              break;
            }

            try {
              const chunk = JSON.parse(data) as Record<string, unknown>;
              if (pendingRecoveryNotice && injectRecoveryNotice(chunk, pendingRecoveryNotice)) {
                pendingRecoveryNotice = null;
              }

              accumulator.ingestChunk(chunk);

              const stored = responseContexts.reduce(
                (sum, [ctxScope, ctxPrior]) =>
                  sum +
                  accumulator.storeReadyReasoning(
                    store,
                    ctxScope,
                    prepared.cacheNamespace,
                    ctxPrior,
                  ),
                0,
              );
              if (config.verbose && stored)
                logVerbose(`stored ${stored} streaming reasoning cache key(s)`);

              const chunkUsage = chunk.usage as UsageInfo | undefined;
              if (chunkUsage) usage = chunkUsage;

              if (displayAdapter) {
                displayAdapter.rewriteChunk(chunk);
              }

              if ("model" in chunk) {
                chunk.model = prepared.originalModel;
              }

              await stream.write(sseData(chunk));
            } catch {
              // pass through unparseable lines
            }
          }
        }
      }

      if (!finalized) {
        for (const [ctxScope, ctxPrior] of responseContexts) {
          accumulator.storeReasoning(store, ctxScope, prepared.cacheNamespace, ctxPrior);
        }
      }
    } finally {
      spinner.stop();
    }

    // Log stats
    const promptTokens = usage?.prompt_tokens ?? "?";
    const completionTokens = usage?.completion_tokens ?? "?";
    const reasoningTokens = usage?.completion_tokens_details?.reasoning_tokens ?? "?";
    logInfo(
      `${boxChar.bottomTee} stats prompt=${promptTokens} output=${completionTokens} reasoning=${reasoningTokens}`,
    );
  });
}

async function handleRegularResponse(
  c: Context,
  upstreamRes: Response,
  prepared: PreparedRequest,
  config: ProxyConfig,
  store: ReasoningStore,
  started: number,
): Promise<Response> {
  const upstreamBody = new Uint8Array(await upstreamRes.arrayBuffer());

  let body: Uint8Array = upstreamBody;
  let usage: UsageInfo | undefined;

  try {
    const parsed = JSON.parse(new TextDecoder().decode(upstreamBody)) as Record<string, unknown>;
    usage = parsed.usage as UsageInfo | undefined;

    body = rewriteResponseBody(
      upstreamBody as unknown as Uint8Array,
      prepared.originalModel,
      store,
      prepared.recordResponseMessages ?? [],
      prepared.cacheNamespace,
      prepared.recoveryNotice,
      prepared.recordResponseScope,
      prepared.recordResponseMessages,
      prepared.recordResponseContexts,
      config.displayReasoning,
      config.collapsibleReasoning,
    );
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logWarn(`failed to rewrite upstream JSON response: ${errMsg}`);
  }

  // Log stats
  const promptTokens = usage?.prompt_tokens ?? "?";
  const completionTokens = usage?.completion_tokens ?? "?";
  const reasoningTokens = usage?.completion_tokens_details?.reasoning_tokens ?? "?";
  logInfo(
    `${boxChar.bottomTee} stats prompt=${promptTokens} output=${completionTokens} reasoning=${reasoningTokens} elapsed=${Date.now() - started}ms`,
  );

  return c.newResponse(body as any, upstreamRes.status as ContentfulStatusCode, {
    "Content-Type": upstreamRes.headers.get("content-type") || "application/json",
    "Content-Length": String(body.byteLength),
  });
}

export async function startServer(
  config: ProxyConfig,
  store: ReasoningStore,
): Promise<{ server: any; tunnel: NgrokTunnel | null; publicUrl: string | null }> {
  const app = createApp(config, store);

  let tunnel: NgrokTunnel | null = null;
  let publicUrl: string | null = null;

  if (config.ngrok) {
    const targetUrl = localTunnelTarget(config.host, config.port);
    tunnel = new NgrokTunnel(targetUrl);
    try {
      publicUrl = await tunnel.start();
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logError(`Failed to start ngrok tunnel: ${errMsg}`);
      throw err;
    }
  }

  const localBaseUrl = `http://${config.host}:${config.port}/v1`;
  const apiBaseUrl = publicUrl ? `${publicUrl.replace(/\/+$/, "")}/v1` : localBaseUrl;

  return new Promise((resolve) => {
    const server = serve(
      {
        fetch: app.fetch,
        port: config.port,
        hostname: config.host,
      },
      () => {
        log(
          `default_model: ${config.upstreamModel} (${config.thinking === "enabled" ? "thinking" : "no thinking"}, ${config.reasoningEffort})`,
        );
        if (!config.ngrok) logInfo("public_tunnel: off");
        logInfo(`local_base_url: ${localBaseUrl}`);
        logInfo(`api_base_url: ${apiBaseUrl}`);

        resolve({ server, tunnel, publicUrl });
      },
    );
  });
}
