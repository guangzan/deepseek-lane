import { describe, it, expect, vi } from "vite-plus/test";

vi.mock("child_process", () => ({
  spawn: vi.fn().mockReturnValue({ unref: vi.fn() }),
}));

const { mockLog, mockIntro, mockOutro } = vi.hoisted(() => {
  const mockLog = {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    step: vi.fn(),
  };
  const mockIntro = vi.fn();
  const mockOutro = vi.fn();
  return { mockLog, mockIntro, mockOutro };
});

vi.mock("@clack/prompts", () => ({
  log: mockLog,
  intro: mockIntro,
  outro: mockOutro,
  select: vi.fn(),
  text: vi.fn(),
  confirm: vi.fn(),
  isCancel: vi.fn().mockReturnValue(false),
  cancel: vi.fn(),
}));

vi.mock("fs", () => ({
  existsSync: vi.fn().mockReturnValue(true),
  writeFileSync: vi.fn(),
  readFileSync: vi.fn().mockReturnValue(""),
}));

vi.mock("../daemon.js", () => ({
  writeConfig: vi.fn(),
  writePidFile: vi.fn(),
  removePidFile: vi.fn(),
  detectNgrokUrl: vi.fn().mockReturnValue(null),
  CONFIG_PATH: "/test/config.yaml",
  LOG_PATH: "/test/log",
  PID_PATH: "/test/pid",
}));

vi.mock("@deepseek-lane/core", () => ({
  createConfig: vi.fn().mockReturnValue({
    host: "127.0.0.1",
    port: 19199,
    upstreamBaseUrl: "https://api.test.com",
    upstreamModel: "deepseek-v4-pro",
    strictModelNames: false,
    thinking: "enabled",
    reasoningEffort: "medium",
    requestTimeout: 300,
    maxRequestBodyBytes: 20971520,
    reasoningContentPath: ":memory:",
    missingReasoningStrategy: "recover",
    reasoningCacheMaxAgeSeconds: 2592000,
    reasoningCacheMaxRows: 100000,
    displayReasoning: true,
    collapsibleReasoning: true,
    ngrok: false,
    verbose: false,
    cors: false,
  }),
  ReasoningStore: vi.fn().mockImplementation(() => ({
    clear: vi.fn().mockReturnValue(0),
    close: vi.fn(),
  })),
  startServer: vi.fn().mockResolvedValue({ tunnel: null, publicUrl: null }),
}));

import { startCmd } from "../commands/start.js";

describe("start command", () => {
  it("has correct name and description", () => {
    expect(startCmd.name()).toBe("start");
    expect(startCmd.description()).toBe("Setup and start the proxy");
  });

  it("has options configured", () => {
    const opts = startCmd.options;
    expect(opts.length).toBeGreaterThanOrEqual(17);
  });

  it("requires at least the essential options", () => {
    const optFlags = startCmd.options.map((o) => (o as { long: string }).long);
    const longFlags = optFlags.flatMap((f: string) => {
      const parts = f.split(", ").filter((p: string) => p.startsWith("--"));
      return parts;
    });
    expect(longFlags).toContain("--host");
    expect(longFlags).toContain("--port");
    expect(longFlags).toContain("--model");
    expect(longFlags).toContain("--base-url");
    expect(longFlags).toContain("--thinking");
    expect(longFlags).toContain("--reasoning-effort");
    expect(longFlags).toContain("--request-timeout");
    expect(longFlags).toContain("--max-request-body-bytes");
    expect(longFlags).toContain("--missing-reasoning-strategy");
    expect(longFlags).toContain("--verbose");
  });
});
