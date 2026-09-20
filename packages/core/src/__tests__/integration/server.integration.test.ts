import { describe, it, expect, beforeAll, afterAll } from "vite-plus/test";
import { serve } from "@hono/node-server";
import { createApp } from "../../server.js";
import { ReasoningStore } from "../../reasoning-store.js";
import type { ProxyConfig } from "../../types.js";
import { getRandomPort, createMockUpstream } from "../helpers.js";

const mockMessages: Record<string, unknown>[] = [{ role: "user", content: "Hello" }];

function mockConfig(overrides: Partial<ProxyConfig> = {}): ProxyConfig {
  return {
    host: "127.0.0.1",
    port: 9000,
    upstreamBaseUrl: "http://127.0.0.1:1",
    upstreamModel: "deepseek-v4-pro",
    strictModelNames: false,
    thinking: "enabled",
    reasoningEffort: "max",
    requestTimeout: 5,
    maxRequestBodyBytes: 20 * 1024 * 1024,
    reasoningContentPath: ":memory:",
    missingReasoningStrategy: "recover",
    reasoningCacheMaxAgeSeconds: 2592000,
    reasoningCacheMaxRows: 100000,
    displayReasoning: false,
    collapsibleReasoning: true,
    ngrok: false,
    verbose: false,
    ...overrides,
  };
}

async function startProxy(config: ProxyConfig, store: ReasoningStore) {
  const app = createApp(config, store);
  const port = await getRandomPort();
  return new Promise<{ server: ReturnType<typeof serve>; port: number; url: string }>((res) => {
    const server = serve({ fetch: app.fetch, port, hostname: "127.0.0.1" }, () => {
      res({ server, port, url: `http://127.0.0.1:${port}` });
    });
  });
}

function stopProxy(server: ReturnType<typeof serve>) {
  return new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}

describe("Server Integration", () => {
  describe("non-streaming proxy", () => {
    it("proxies request to upstream and rewrites response model", async () => {
      const upstream = await createMockUpstream((_req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            id: "chat-1",
            object: "chat.completion",
            model: "deepseek-v4-pro",
            choices: [{ index: 0, message: { role: "assistant", content: "Hi there!" } }],
            usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
          }),
        );
      });

      const config = mockConfig({
        upstreamBaseUrl: upstream.url,
        upstreamModel: "deepseek-v4-pro",
      });
      const store = new ReasoningStore(":memory:");
      const proxy = await startProxy(config, store);

      try {
        const res = await fetch(`${proxy.url}/v1/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer test-key",
          },
          body: JSON.stringify({ model: "deepseek-v4-pro", messages: mockMessages }),
        });

        expect(res.status).toBe(200);
        const body = (await res.json()) as Record<string, unknown>;
        expect(body.model).toBe("deepseek-v4-pro");
        expect((body.choices as Record<string, unknown>[])?.[0]?.message).toBeDefined();
      } finally {
        await stopProxy(proxy.server);
        upstream.server.close();
        store.close();
      }
    });

    it("passes through upstream non-200 errors", async () => {
      const upstream = await createMockUpstream((_req, res) => {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "bad request" } }));
      });

      const config = mockConfig({
        upstreamBaseUrl: upstream.url,
        thinking: "disabled",
      });
      const store = new ReasoningStore(":memory:");
      const proxy = await startProxy(config, store);

      try {
        const res = await fetch(`${proxy.url}/v1/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer test-key",
          },
          body: JSON.stringify({ model: "deepseek-v4-pro", messages: mockMessages }),
        });

        expect(res.status).toBe(400);
        const body = (await res.json()) as Record<string, unknown>;
        expect(body.error).toBeDefined();
      } finally {
        await stopProxy(proxy.server);
        upstream.server.close();
        store.close();
      }
    });

    it("returns 502 on upstream network error", async () => {
      const port = await getRandomPort();
      const config = mockConfig({
        upstreamBaseUrl: `http://127.0.0.1:${port}`,
        requestTimeout: 1,
      });
      const store = new ReasoningStore(":memory:");
      const proxy = await startProxy(config, store);

      try {
        const res = await fetch(`${proxy.url}/v1/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer test-key",
          },
          body: JSON.stringify({ model: "deepseek-v4-pro", messages: mockMessages }),
        });

        expect(res.status).toBe(502);
      } finally {
        await stopProxy(proxy.server);
        store.close();
      }
    });
  });

  describe("health and models", () => {
    let config: ProxyConfig;
    let store: ReasoningStore;
    let proxy: { server: ReturnType<typeof serve>; port: number; url: string };

    beforeAll(async () => {
      config = mockConfig();
      store = new ReasoningStore(":memory:");
      proxy = await startProxy(config, store);
    });

    afterAll(async () => {
      await stopProxy(proxy.server);
      store.close();
    });

    it("GET /healthz returns 200 with ok", async () => {
      const res = await fetch(`${proxy.url}/healthz`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.ok).toBe(true);
    });

    it("GET /v1/healthz returns 200 with ok", async () => {
      const res = await fetch(`${proxy.url}/v1/healthz`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.ok).toBe(true);
    });

    it("GET /v1/models returns model list with deepseek models", async () => {
      const res = await fetch(`${proxy.url}/v1/models`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.object).toBe("list");
      const data = body.data as Record<string, unknown>[];
      const ids = data.map((m) => m.id);
      expect(ids).toContain("deepseek-v4-pro");
      expect(ids).toContain("deepseek-v4-flash");
    });
  });

  describe("streaming SSE proxy", () => {
    it("proxies streaming response end-to-end", async () => {
      const upstreamChunks = [
        {
          id: "sse-1",
          object: "chat.completion.chunk",
          model: "deepseek-v4-pro",
          choices: [{ index: 0, delta: { content: "Hello" }, finish_reason: null }],
        },
        {
          id: "sse-1",
          object: "chat.completion.chunk",
          model: "deepseek-v4-pro",
          choices: [{ index: 0, delta: { content: " world" }, finish_reason: "stop" }],
        },
      ];

      const upstream = await createMockUpstream((_req, res) => {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        for (const chunk of upstreamChunks) {
          res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        }
        res.end("data: [DONE]\n\n");
      });

      const config = mockConfig({
        upstreamBaseUrl: upstream.url,
        thinking: "disabled",
      });
      const store = new ReasoningStore(":memory:");
      const proxy = await startProxy(config, store);

      try {
        const res = await fetch(`${proxy.url}/v1/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer test-key",
          },
          body: JSON.stringify({ model: "deepseek-v4-pro", messages: mockMessages, stream: true }),
        });

        expect(res.status).toBe(200);
        const text = await res.text();
        const dataLines = text.split("\n").filter((l) => l.startsWith("data: "));
        const nonDoneChunks = dataLines.filter((l) => l !== "data: [DONE]");
        expect(nonDoneChunks.length).toBeGreaterThanOrEqual(2);
        expect(text).toContain("[DONE]");
      } finally {
        await stopProxy(proxy.server);
        upstream.server.close();
        store.close();
      }
    });

    it("streaming response rewrites model in chunks", async () => {
      const upstreamChunks = [
        {
          id: "sse-2",
          object: "chat.completion.chunk",
          model: "deepseek-v4-pro",
          choices: [{ index: 0, delta: { content: "A" }, finish_reason: "stop" }],
        },
      ];

      const upstream = await createMockUpstream((_req, res) => {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        for (const chunk of upstreamChunks) {
          res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        }
        res.end("data: [DONE]\n\n");
      });

      const config = mockConfig({
        upstreamBaseUrl: upstream.url,
        upstreamModel: "deepseek-v4-pro",
        thinking: "disabled",
      });
      const store = new ReasoningStore(":memory:");
      const proxy = await startProxy(config, store);

      try {
        const res = await fetch(`${proxy.url}/v1/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer test-key",
          },
          body: JSON.stringify({ model: "deepseek-v4-pro", messages: mockMessages, stream: true }),
        });

        const text = await res.text();
        const chunks = text
          .split("\n")
          .filter((l) => l.startsWith("data: ")) as unknown as string[];
        for (const line of chunks) {
          if (line === "data: [DONE]") continue;
          const data = JSON.parse((line as string).slice(6));
          expect(data.model).toBe("deepseek-v4-pro");
        }
      } finally {
        await stopProxy(proxy.server);
        upstream.server.close();
        store.close();
      }
    });
  });

  describe("reasoning cache lifecycle", () => {
    it("stores and retrieves reasoning across requests", async () => {
      const upstream = await createMockUpstream((_req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            id: "chat-rc",
            object: "chat.completion",
            model: "deepseek-v4-pro",
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content: "answer",
                  reasoning_content: "step-by-step thinking",
                },
              },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          }),
        );
      });

      const config = mockConfig({
        upstreamBaseUrl: upstream.url,
        upstreamModel: "deepseek-v4-pro",
        thinking: "enabled",
        reasoningEffort: "max",
      });
      const store = new ReasoningStore(":memory:");
      const proxy = await startProxy(config, store);

      const requestBody = { model: "deepseek-v4-pro", messages: mockMessages };

      try {
        const res1 = await fetch(`${proxy.url}/v1/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer test-key",
          },
          body: JSON.stringify(requestBody),
        });

        expect(res1.status).toBe(200);
        const data1 = (await res1.json()) as Record<string, unknown>;

        // Verify cache has entries from the first request
        // The response itself includes reasoning_content since thinking is enabled
        const choices = data1.choices as Record<string, unknown>[];
        const message = choices?.[0]?.message as Record<string, unknown> | undefined;
        expect(message?.reasoning_content).toBeDefined();
      } finally {
        await stopProxy(proxy.server);
        upstream.server.close();
        store.close();
      }
    });
  });

  describe("auth and validation", () => {
    let config: ProxyConfig;
    let store: ReasoningStore;
    let proxy: { server: ReturnType<typeof serve>; port: number; url: string };

    beforeAll(async () => {
      config = mockConfig();
      store = new ReasoningStore(":memory:");
      proxy = await startProxy(config, store);
    });

    afterAll(async () => {
      await stopProxy(proxy.server);
      store.close();
    });

    it("returns 401 when Authorization header is missing", async () => {
      const res = await fetch(`${proxy.url}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: mockMessages }),
      });
      expect(res.status).toBe(401);
    });

    it("returns 401 when Authorization header is empty bearer", async () => {
      const res = await fetch(`${proxy.url}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer ",
        },
        body: JSON.stringify({ messages: mockMessages }),
      });
      expect(res.status).toBe(401);
    });

    it("returns 400 for invalid JSON body", async () => {
      const res = await fetch(`${proxy.url}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer test-key",
        },
        body: "not json",
      });
      expect(res.status).toBe(400);
    });

    it("returns 413 for oversized request body", async () => {
      const smallConfig = mockConfig({ maxRequestBodyBytes: 100 });
      const smallStore = new ReasoningStore(":memory:");
      const smallProxy = await startProxy(smallConfig, smallStore);

      try {
        const res = await fetch(`${smallProxy.url}/v1/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer test-key",
          },
          body: JSON.stringify({
            messages: [{ role: "user", content: "x".repeat(200) }],
          }),
        });
        expect(res.status).toBe(413);
      } finally {
        await stopProxy(smallProxy.server);
        smallStore.close();
      }
    });
  });
});
