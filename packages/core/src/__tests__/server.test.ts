import { describe, it, expect, vi } from "vite-plus/test";
import { createApp } from "../server.js";
import { ReasoningStore } from "../reasoning-store.js";
import { ProxyConfig } from "../types.js";

const mockConfig: ProxyConfig = {
  host: "127.0.0.1",
  port: 9000,
  upstreamBaseUrl: "https://api.test.com",
  upstreamModel: "deepseek-v4-pro",
  strictModelNames: false,
  thinking: "enabled",
  reasoningEffort: "max",
  requestTimeout: 300,
  maxConcurrency: 4,
  maxRequestBodyBytes: 20 * 1024 * 1024,
  reasoningContentPath: ":memory:",
  missingReasoningStrategy: "recover",
  reasoningCacheMaxAgeSeconds: 2592000,
  reasoningCacheMaxRows: 100000,
  displayReasoning: false,
  collapsibleReasoning: true,
  ngrok: false,
  verbose: false,
};

function createTestApp() {
  const store = new ReasoningStore(":memory:");
  return { app: createApp(mockConfig, store), store };
}

describe("GET /healthz", () => {
  it("returns 200", async () => {
    const { app } = createTestApp();
    const res = await app.request("/healthz");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});

describe("GET /v1/healthz", () => {
  it("returns 200", async () => {
    const { app } = createTestApp();
    const res = await app.request("/v1/healthz");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});

describe("GET /v1/models", () => {
  it("returns model list", async () => {
    const { app } = createTestApp();
    const res = await app.request("/v1/models");
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.object).toBe("list");
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data.length).toBeGreaterThanOrEqual(1);
  });

  it("includes deepseek-v4-pro", async () => {
    const { app } = createTestApp();
    const res = await app.request("/v1/models");
    const body = (await res.json()) as any;
    const ids = body.data.map((m: any) => m.id);
    expect(ids).toContain("deepseek-v4-pro");
  });

  it("includes deepseek-v4-flash", async () => {
    const { app } = createTestApp();
    const res = await app.request("/v1/models");
    const body = (await res.json()) as any;
    const ids = body.data.map((m: any) => m.id);
    expect(ids).toContain("deepseek-v4-flash");
  });
});

describe("POST /v1/chat/completions", () => {
  it("rejects requests without Authorization header", async () => {
    const { app } = createTestApp();
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
    });
    expect(res.status).toBe(401);
  });

  it("rejects requests with empty Authorization", async () => {
    const { app } = createTestApp();
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer ",
      },
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
    });
    expect(res.status).toBe(401);
  });

  it("rejects invalid JSON body", async () => {
    const { app } = createTestApp();
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test-key",
      },
      body: "not json",
    });
    expect(res.status).toBe(400);
  });

  it("rejects body exceeding size limit", async () => {
    const { app } = createTestApp();
    const bigPayload = {
      messages: [{ role: "user", content: "x".repeat(mockConfig.maxRequestBodyBytes) }],
    };
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test-key",
      },
      body: JSON.stringify(bigPayload),
    });
    expect(res.status).toBe(413);
  });

  it("accepts valid non-streaming request", async () => {
    const mockResponse = new Response(
      JSON.stringify({
        id: "test-1",
        object: "chat.completion",
        model: "deepseek-v4-pro",
        choices: [{ index: 0, message: { role: "assistant", content: "Hello!" } }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockResponse));

    const { app } = createTestApp();
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test-key",
      },
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.model).toBe("deepseek-v4-pro");
    expect(body.choices[0].message.content).toBe("Hello!");

    vi.unstubAllGlobals();
  });
});

describe("POST /v1/chat/completions with strict model names", () => {
  function strictApp() {
    const store = new ReasoningStore(":memory:");
    return { app: createApp({ ...mockConfig, strictModelNames: true }, store), store };
  }

  function stubbedUpstream() {
    const mockResponse = new Response(
      JSON.stringify({
        id: "test-1",
        object: "chat.completion",
        model: "deepseek-v4-pro",
        choices: [{ index: 0, message: { role: "assistant", content: "Hello!" } }],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockResponse));
  }

  it("rejects model names the proxy does not serve", async () => {
    const { app } = strictApp();
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test-key",
      },
      body: JSON.stringify({ model: "gpt-5.5", messages: [{ role: "user", content: "hi" }] }),
    });

    expect(res.status).toBe(404);
    const body = (await res.json()) as any;
    expect(body.error.code).toBe("model_not_found");
  });

  it("serves deepseek model names", async () => {
    stubbedUpstream();
    const { app } = strictApp();
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test-key",
      },
      body: JSON.stringify({
        model: "deepseek-v4-flash",
        messages: [{ role: "user", content: "hi" }],
      }),
    });

    expect(res.status).toBe(200);
    vi.unstubAllGlobals();
  });

  it("serves requests without a model field", async () => {
    stubbedUpstream();
    const { app } = strictApp();
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test-key",
      },
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
    });

    expect(res.status).toBe(200);
    vi.unstubAllGlobals();
  });
});

describe("POST /v1/chat/completions concurrency limit", () => {
  function upstreamResponse() {
    return new Response(
      JSON.stringify({
        id: "test-1",
        object: "chat.completion",
        model: "deepseek-v4-pro",
        choices: [{ index: 0, message: { role: "assistant", content: "Hello!" } }],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }

  function chatRequest(app: ReturnType<typeof createApp>) {
    return app.request("/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test-key",
      },
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
    });
  }

  async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error("condition was not met in time");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  function gatedUpstream() {
    let openGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    let calls = 0;
    const fetchMock = vi.fn(async () => {
      calls++;
      if (calls === 1) await gate;
      return upstreamResponse();
    });
    vi.stubGlobal("fetch", fetchMock);
    return { openGate, calls: () => calls };
  }

  it("queues requests beyond max_concurrency instead of hitting the upstream", async () => {
    const upstream = gatedUpstream();
    const store = new ReasoningStore(":memory:");
    const app = createApp({ ...mockConfig, maxConcurrency: 1 }, store);

    const first = chatRequest(app);
    await waitFor(() => upstream.calls() === 1);

    const second = chatRequest(app);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(upstream.calls()).toBe(1);

    upstream.openGate();
    const [firstRes, secondRes] = await Promise.all([first, second]);

    expect(firstRes.status).toBe(200);
    expect(secondRes.status).toBe(200);
    expect(upstream.calls()).toBe(2);

    vi.unstubAllGlobals();
  });

  it("rejects a queued request when no slot frees up in time", async () => {
    const upstream = gatedUpstream();
    const store = new ReasoningStore(":memory:");
    const app = createApp({ ...mockConfig, maxConcurrency: 1, requestTimeout: 0.05 }, store);

    const first = chatRequest(app);
    await waitFor(() => upstream.calls() === 1);

    const queued = await chatRequest(app);
    expect(queued.status).toBe(429);
    const body = (await queued.json()) as any;
    expect(body.error.code).toBe("concurrency_limit");

    upstream.openGate();
    expect((await first).status).toBe(200);

    vi.unstubAllGlobals();
  });
});
