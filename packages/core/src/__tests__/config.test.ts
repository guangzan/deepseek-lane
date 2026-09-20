import { describe, it, expect, vi } from "vite-plus/test";
import { existsSync, readFileSync } from "fs";
import { createConfig } from "../config.js";

// Mock fs to avoid touching real filesystem
vi.mock("fs", () => {
  const fs = {
    existsSync: vi.fn().mockReturnValue(false),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    chmodSync: vi.fn(),
    readFileSync: vi.fn(),
  };
  return { default: fs, ...fs };
});

describe("createConfig", () => {
  it("returns default values with empty args", () => {
    const config = createConfig({});
    expect(config.host).toBe("127.0.0.1");
    expect(config.port).toBe(19199);
    expect(config.upstreamBaseUrl).toBe("https://opencode.ai/zen/go/v1");
    expect(config.upstreamModel).toBe("deepseek-v4-pro");
    expect(config.strictModelNames).toBe(false);
    expect(config.thinking).toBe("enabled");
    expect(config.reasoningEffort).toBe("medium");
    expect(config.ngrok).toBe(true);
    expect(config.verbose).toBe(false);
    expect(config.displayReasoning).toBe(true);
    expect(config.collapsibleReasoning).toBe(true);
    expect(config.requestTimeout).toBe(300);
    expect(config.maxRequestBodyBytes).toBe(20 * 1024 * 1024);
    expect(config.missingReasoningStrategy).toBe("recover");
  });

  it("overrides port via CLI", () => {
    const config = createConfig({ port: 4000 });
    expect(config.port).toBe(4000);
  });

  it("overrides host via CLI", () => {
    const config = createConfig({ host: "0.0.0.0" });
    expect(config.host).toBe("0.0.0.0");
  });

  it("overrides model via CLI", () => {
    const config = createConfig({ model: "deepseek-v4-flash" });
    expect(config.upstreamModel).toBe("deepseek-v4-flash");
  });

  it("enables strict model names via CLI", () => {
    const config = createConfig({ strictModelNames: true });
    expect(config.strictModelNames).toBe(true);
  });

  it("reads strict model names from the config file", () => {
    vi.mocked(existsSync).mockReturnValueOnce(true);
    vi.mocked(readFileSync).mockReturnValueOnce("strict_model_names: true\n" as never);
    const config = createConfig({});
    expect(config.strictModelNames).toBe(true);
  });

  it("overrides base URL via CLI", () => {
    const config = createConfig({ baseUrl: "https://custom.api.com/v1" });
    expect(config.upstreamBaseUrl).toBe("https://custom.api.com/v1");
  });

  it("strips trailing slash from base URL", () => {
    const config = createConfig({ baseUrl: "https://custom.api.com/v1/" });
    expect(config.upstreamBaseUrl).toBe("https://custom.api.com/v1");
  });

  it("disables thinking via CLI", () => {
    const config = createConfig({ thinking: "disabled" });
    expect(config.thinking).toBe("disabled");
  });

  it("accepts valid reasoning effort values", () => {
    expect(createConfig({ reasoningEffort: "low" }).reasoningEffort).toBe("low");
    expect(createConfig({ reasoningEffort: "medium" }).reasoningEffort).toBe("medium");
    expect(createConfig({ reasoningEffort: "high" }).reasoningEffort).toBe("high");
    expect(createConfig({ reasoningEffort: "max" }).reasoningEffort).toBe("max");
    expect(createConfig({ reasoningEffort: "xhigh" }).reasoningEffort).toBe("xhigh");
  });

  it("falls back to medium for invalid reasoning effort", () => {
    const config = createConfig({ reasoningEffort: "invalid" });
    expect(config.reasoningEffort).toBe("medium");
  });

  it("disables ngrok via CLI", () => {
    const config = createConfig({ ngrok: false });
    expect(config.ngrok).toBe(false);
  });

  it("enables verbose via CLI", () => {
    const config = createConfig({ verbose: true });
    expect(config.verbose).toBe(true);
  });

  it("disables displayReasoning via CLI", () => {
    const config = createConfig({ displayReasoning: false });
    expect(config.displayReasoning).toBe(false);
  });

  it("disables collapsibleReasoning via CLI", () => {
    const config = createConfig({ collapsibleReasoning: false });
    expect(config.collapsibleReasoning).toBe(false);
  });

  it("sets request timeout via CLI", () => {
    const config = createConfig({ requestTimeout: 60 });
    expect(config.requestTimeout).toBe(60);
  });

  it("sets max request body bytes via CLI", () => {
    const config = createConfig({ maxRequestBodyBytes: 1024 });
    expect(config.maxRequestBodyBytes).toBe(1024);
  });

  it("rejects missing reasoning via CLI", () => {
    const config = createConfig({ missingReasoningStrategy: "reject" });
    expect(config.missingReasoningStrategy).toBe("reject");
  });

  it("falls back to recover for invalid strategy", () => {
    const config = createConfig({ missingReasoningStrategy: "invalid" as any });
    expect(config.missingReasoningStrategy).toBe("recover");
  });

  it("handles clearReasoningCache flag", () => {
    createConfig({ clearReasoningCache: true });
    // doesn't affect config output, just a flag for main()
  });
});
