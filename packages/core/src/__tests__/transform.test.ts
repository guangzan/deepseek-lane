import { describe, it, expect, vi } from "vite-plus/test";
import {
  prepareUpstreamRequest,
  rewriteResponseBody,
  stripCursorThinkingBlocks,
  extractTextContent,
  isServedModel,
} from "../transform.js";
import { ReasoningStore } from "../reasoning-store.js";
import { ProxyConfig } from "../types.js";

const defaultConfig: ProxyConfig = {
  host: "127.0.0.1",
  port: 9000,
  upstreamBaseUrl: "https://api.test.com",
  upstreamModel: "deepseek-v4-pro",
  strictModelNames: false,
  thinking: "enabled",
  reasoningEffort: "medium",
  requestTimeout: 300,
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

describe("stripCursorThinkingBlocks", () => {
  it("strips <details> thinking blocks", () => {
    const input =
      "<details>\n<summary>Thinking</summary>\n\nthinking text\n</details>\n\nactual content";
    expect(stripCursorThinkingBlocks(input)).toBe("actual content");
  });

  it("strips <think> blocks", () => {
    const input = "<think>\nthinking text\n</think>\n\nactual content";
    expect(stripCursorThinkingBlocks(input)).toBe("actual content");
  });

  it("strips <thinking> blocks", () => {
    const input = "<thinking>\nthinking text\n</thinking>\n\nactual content";
    expect(stripCursorThinkingBlocks(input)).toBe("actual content");
  });

  it("returns original when no thinking blocks", () => {
    const input = "just regular content";
    expect(stripCursorThinkingBlocks(input)).toBe("just regular content");
  });

  it("handles empty string", () => {
    expect(stripCursorThinkingBlocks("")).toBe("");
  });
});

describe("extractTextContent", () => {
  it("returns string as-is", () => {
    expect(extractTextContent("hello")).toBe("hello");
  });

  it("returns null for null", () => {
    expect(extractTextContent(null)).toBeNull();
  });

  it("returns null for undefined", () => {
    expect(extractTextContent(undefined)).toBeNull();
  });

  it("extracts text from content array", () => {
    const input = [
      { type: "text", text: "Hello" },
      { type: "text", text: "World" },
    ];
    expect(extractTextContent(input)).toBe("Hello\nWorld");
  });

  it("handles input_text type", () => {
    const input = [{ type: "input_text", text: "hi" }];
    expect(extractTextContent(input)).toBe("hi");
  });

  it("handles unknown type with [omitted] marker", () => {
    const input = [{ type: "image_url" }];
    expect(extractTextContent(input)).toContain("omitted");
  });

  it("handles object content with JSON stringify", () => {
    const obj = { x: 1 };
    expect(extractTextContent(obj)).toBe(JSON.stringify(obj));
  });
});

describe("isServedModel", () => {
  it("accepts deepseek model names", () => {
    expect(isServedModel("deepseek-v4-pro", defaultConfig)).toBe(true);
    expect(isServedModel("deepseek-v4-flash", defaultConfig)).toBe(true);
  });

  it("accepts the configured default model", () => {
    const config: ProxyConfig = { ...defaultConfig, upstreamModel: "my-alias" };
    expect(isServedModel("my-alias", config)).toBe(true);
  });

  it("rejects model names the proxy does not serve", () => {
    expect(isServedModel("gpt-5.5", defaultConfig)).toBe(false);
  });
});

describe("substituted model names", () => {
  it("warns once per substituted model name", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const payload = {
      model: "gpt-5.5-unique-to-this-test",
      messages: [{ role: "user", content: "hi" }],
    };

    prepareUpstreamRequest(payload, defaultConfig, null);
    prepareUpstreamRequest(payload, defaultConfig, null);

    const warnings = spy.mock.calls.filter((call) =>
      String(call[1] ?? "").includes("is not served by this proxy"),
    );
    expect(warnings).toHaveLength(1);
    spy.mockRestore();
  });

  it("does not warn when the requested model is the configured default", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const config: ProxyConfig = { ...defaultConfig, upstreamModel: "my-alias" };

    prepareUpstreamRequest({ messages: [{ role: "user", content: "hi" }] }, config, null);

    const warnings = spy.mock.calls.filter((call) =>
      String(call[1] ?? "").includes("is not served by this proxy"),
    );
    expect(warnings).toHaveLength(0);
    spy.mockRestore();
  });
});

describe("prepareUpstreamRequest", () => {
  it("passes through basic request fields", () => {
    const payload = {
      model: "deepseek-v4-pro",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
    };
    const result = prepareUpstreamRequest(payload, defaultConfig, null);
    expect(result.upstreamModel).toBe("deepseek-v4-pro");
    expect(result.originalModel).toBe("deepseek-v4-pro");
    expect(result.payload.model).toBe("deepseek-v4-pro");
  });

  it("injects thinking config", () => {
    const payload = {
      messages: [{ role: "user", content: "hi" }],
    };
    const result = prepareUpstreamRequest(payload, defaultConfig, null);
    expect(result.payload.thinking).toEqual({ type: "enabled" });
    expect(result.payload.reasoning_effort).toBe("high");
  });

  it("disables thinking when configured", () => {
    const config = { ...defaultConfig, thinking: "disabled" as const };
    const payload = { messages: [{ role: "user", content: "hi" }] };
    const result = prepareUpstreamRequest(payload, config, null);
    expect(result.payload.thinking).toEqual({ type: "disabled" });
    expect(result.payload.reasoning_effort).toBeUndefined();
  });

  it("strips cursor thinking blocks from assistant messages", () => {
    const payload = {
      messages: [
        {
          role: "assistant",
          content: "<details>\n<summary>Thinking</summary>\n\nold thinking\n</details>\n\nanswer",
          reasoning_content: "old thinking",
        },
      ],
    };
    const result = prepareUpstreamRequest(payload, defaultConfig, null);
    const msg = (result.payload.messages as any[])[0];
    expect(msg.content).toBe("answer");
  });

  it("handles tool normalization", () => {
    const payload = {
      messages: [{ role: "user", content: "hi" }],
      tools: [
        { function: { name: "test_tool", description: "a test", parameters: { type: "object" } } },
      ],
    };
    const result = prepareUpstreamRequest(payload, defaultConfig, null);
    expect(result.payload.tools).toHaveLength(1);
    expect((result.payload.tools as any[])[0].function.name).toBe("test_tool");
  });

  it("handles legacy functions field", () => {
    const payload = {
      messages: [{ role: "user", content: "hi" }],
      functions: [{ name: "legacy_fn", description: "old" }],
    };
    const result = prepareUpstreamRequest(payload, defaultConfig, null);
    expect(result.payload.tools).toHaveLength(1);
    expect((result.payload.tools as any[])[0].function.name).toBe("legacy_fn");
  });

  it("drops unsupported fields and logs", () => {
    const payload = {
      messages: [{ role: "user", content: "hi" }],
      unsupported_field: "should be dropped",
    };
    expect(() => prepareUpstreamRequest(payload, defaultConfig, null)).not.toThrow();
  });

  it("adds include_usage to stream_options", () => {
    const payload = {
      messages: [{ role: "user", content: "hi" }],
      stream: true,
    };
    const result = prepareUpstreamRequest(payload, defaultConfig, null);
    expect(result.payload.stream_options).toEqual({ include_usage: true });
  });

  it("preserves existing stream_options", () => {
    const payload = {
      messages: [{ role: "user", content: "hi" }],
      stream: true,
      stream_options: { include_usage: false, max_wait_ms: 500 },
    };
    const result = prepareUpstreamRequest(payload, defaultConfig, null);
    expect(result.payload.stream_options).toEqual({ include_usage: true, max_wait_ms: 500 });
  });

  it("repairs missing reasoning from cache (happy path)", () => {
    const store = new ReasoningStore(":memory:");
    const prior: any[] = [{ role: "user", content: "hi" }];

    const origMsg: any = {
      role: "assistant",
      content: "",
      reasoning_content: "thinking...",
      tool_calls: [{ id: "call_1", function: { name: "test", arguments: "{}" } }],
    };
    store.storeAssistantMessage(origMsg, "test-scope", "ns", prior);

    const payload = {
      messages: [
        ...prior,
        {
          role: "assistant",
          content: "",
          tool_calls: [{ id: "call_1", function: { name: "test", arguments: "{}" } }],
        },
        { role: "tool", content: "result", tool_call_id: "call_1" },
        { role: "user", content: "follow up" },
      ],
    };

    const result = prepareUpstreamRequest(payload, defaultConfig, store);
    expect(result.patchedReasoningMessages).toBeGreaterThanOrEqual(0);
    store.close();
  });

  it("recovers from missing reasoning when store has no entry", () => {
    const store = new ReasoningStore(":memory:");
    const payload = {
      messages: [
        { role: "user", content: "hi" },
        {
          role: "assistant",
          content: "",
          tool_calls: [{ id: "call_1", function: { name: "test", arguments: "{}" } }],
        },
        { role: "tool", content: "result", tool_call_id: "call_1" },
        { role: "user", content: "follow up" },
      ],
    };
    const result = prepareUpstreamRequest(payload, defaultConfig, store);
    expect(result.recoveryNotice).toBeTruthy();
    expect(result.recoveredReasoningMessages).toBeGreaterThan(0);
    expect(result.recoveryDroppedMessages).toBeGreaterThan(0);
    store.close();
  });

  it("rejects missing reasoning when strategy is reject", () => {
    const config = { ...defaultConfig, missingReasoningStrategy: "reject" as const };
    const payload = {
      messages: [
        { role: "user", content: "hi" },
        {
          role: "assistant",
          content: "",
          tool_calls: [{ id: "call_1", function: { name: "test", arguments: "{}" } }],
        },
        { role: "tool", content: "result", tool_call_id: "call_1" },
        { role: "user", content: "follow up" },
      ],
    };
    const result = prepareUpstreamRequest(payload, config, null);
    expect(result.missingReasoningMessages).toBeGreaterThanOrEqual(1);
  });

  it("handles empty messages array", () => {
    const payload = { messages: [] };
    const result = prepareUpstreamRequest(payload, defaultConfig, null);
    expect(result.payload.messages).toEqual([]);
  });

  it("upstreamModel uses original for deepseek- prefixed", () => {
    const payload = { messages: [{ role: "user", content: "hi" }], model: "deepseek-v4-flash" };
    const result = prepareUpstreamRequest(payload, defaultConfig, null);
    expect(result.upstreamModel).toBe("deepseek-v4-flash");
  });

  it("upstreamModel uses config fallback for non-deepseek", () => {
    const payload = { messages: [{ role: "user", content: "hi" }], model: "gpt-4" };
    const result = prepareUpstreamRequest(payload, defaultConfig, null);
    expect(result.upstreamModel).toBe("deepseek-v4-pro");
  });
});

describe("rewriteResponseBody", () => {
  it("rewrites model name in response", () => {
    const body = new TextEncoder().encode(
      JSON.stringify({
        id: "test",
        model: "upstream-model",
        choices: [{ index: 0, message: { role: "assistant", content: "Hello" } }],
      }),
    );
    const result = rewriteResponseBody(body, "original-model", null, []);
    const decoded = JSON.parse(new TextDecoder().decode(result));
    expect(decoded.model).toBe("original-model");
  });

  it("injects content prefix", () => {
    const body = new TextEncoder().encode(
      JSON.stringify({
        choices: [{ index: 0, message: { role: "assistant", content: "Hello" } }],
      }),
    );
    const result = rewriteResponseBody(body, "m", null, [], "", "PREFIX: ");
    const decoded = JSON.parse(new TextDecoder().decode(result));
    expect(decoded.choices[0].message.content).toBe("PREFIX: Hello");
  });

  it("folds reasoning into content when displayReasoning is true", () => {
    const body = new TextEncoder().encode(
      JSON.stringify({
        choices: [
          {
            message: { role: "assistant", content: "Hello", reasoning_content: "thinking..." },
          },
        ],
      }),
    );
    const result = rewriteResponseBody(
      body,
      "m",
      null,
      [],
      "",
      null,
      null,
      undefined,
      undefined,
      true,
      true,
    );
    const decoded = JSON.parse(new TextDecoder().decode(result));
    expect(decoded.choices[0].message.content).toContain("<details>");
    expect(decoded.choices[0].message.content).toContain("</details>");
  });
});

describe("prepareUpstreamRequest recovery edge cases", () => {
  const config: ProxyConfig = { ...defaultConfig, missingReasoningStrategy: "recover" };

  it("recovers from multiple missing reasoning messages", () => {
    const store = new ReasoningStore(":memory:");
    const payload = {
      messages: [
        { role: "system", content: "You are helpful." },
        { role: "user", content: "hello" },
        {
          role: "assistant",
          content: "",
          tool_calls: [{ id: "call_1", function: { name: "search", arguments: "{}" } }],
        },
        { role: "tool", content: "result 1", tool_call_id: "call_1" },
        {
          role: "assistant",
          content: "",
          tool_calls: [{ id: "call_2", function: { name: "search", arguments: "{}" } }],
        },
        { role: "tool", content: "result 2", tool_call_id: "call_2" },
        { role: "user", content: "follow up" },
      ],
    };
    const result = prepareUpstreamRequest(payload, config, store);
    expect(result.recoveredReasoningMessages).toBeGreaterThanOrEqual(0);
    expect(result.recoveryNotice).toBeTruthy();
    expect(result.recoveryDroppedMessages).toBeGreaterThan(0);
    store.close();
  });

  it("keeps system messages at start after recovery", () => {
    const store = new ReasoningStore(":memory:");
    const payload = {
      messages: [
        { role: "system", content: "You are helpful." },
        { role: "system", content: "Always be concise." },
        { role: "user", content: "hello" },
        {
          role: "assistant",
          content: "",
          tool_calls: [{ id: "call_1", function: { name: "test", arguments: "{}" } }],
        },
        { role: "tool", content: "result", tool_call_id: "call_1" },
        { role: "user", content: "follow up" },
      ],
    };
    const result = prepareUpstreamRequest(payload, config, store);
    const msgs = result.payload.messages as any[];
    expect(msgs[0].role).toBe("system");
    expect(msgs[0].content).toBe("You are helpful.");
    expect(msgs[1].role).toBe("system");
    expect(msgs[1].content).toBe("Always be concise.");
    store.close();
  });

  it("reject strategy returns missingReasoningMessages without recovery", () => {
    const rejectConfig: ProxyConfig = { ...defaultConfig, missingReasoningStrategy: "reject" };
    const payload = {
      messages: [
        { role: "user", content: "hi" },
        {
          role: "assistant",
          content: "",
          tool_calls: [{ id: "call_1", function: { name: "test", arguments: "{}" } }],
        },
        { role: "tool", content: "result", tool_call_id: "call_1" },
        { role: "user", content: "follow up" },
      ],
    };
    const result = prepareUpstreamRequest(payload, rejectConfig, null);
    expect(result.missingReasoningMessages).toBeGreaterThanOrEqual(1);
    expect(result.recoveryNotice).toBeNull();
    expect(result.recoveredReasoningMessages).toBe(0);
  });

  it("handles messages with only system role (no recovery needed)", () => {
    const payload = {
      messages: [
        { role: "system", content: "Be helpful." },
        { role: "user", content: "hello" },
      ],
    };
    const result = prepareUpstreamRequest(payload, config, null);
    expect(result.missingReasoningMessages).toBe(0);
    expect(result.recoveryNotice).toBeNull();
  });

  it("sets thinking type for disabled config", () => {
    const disabledConfig = { ...defaultConfig, thinking: "disabled" as const };
    const payload = { messages: [{ role: "user", content: "hi" }] };
    const result = prepareUpstreamRequest(payload, disabledConfig, null);
    expect(result.payload.thinking).toEqual({ type: "disabled" });
  });
});
