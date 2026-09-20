import { Command } from "commander";
import * as p from "@clack/prompts";
import { spawn } from "child_process";
import { existsSync } from "fs";
import { createConfig, ReasoningStore, startServer } from "@deepseek-lane/core";
import type { CliArgs } from "@deepseek-lane/core";
import {
  writeConfig,
  writePidFile,
  removePidFile,
  detectNgrokUrl,
  CONFIG_PATH,
  LOG_PATH,
  PID_PATH,
} from "../daemon.js";
import { writeFileSync } from "fs";

const startCmd = new Command("start")
  .description("Setup and start the proxy")
  .option("--no-interactive", "Skip interactive setup wizard")
  .option("-d, --detach", "Run in background")
  .option("--config <path>", "Config file path")
  .option("--host <host>", "Bind host", "127.0.0.1")
  .option("--port <port>", "Bind port", (v: string) => parseInt(v, 10), 19199)
  .option("--model <model>", "Default model", "deepseek-v4-pro")
  .option("--strict-model-names", "Reject model names this proxy does not serve")
  .option("--no-strict-model-names", "Answer unsupported model names with the default model")
  .option("--base-url <url>", "Upstream API base URL")
  .option("--thinking <mode>", "Thinking mode: enabled|disabled", "enabled")
  .option("--reasoning-effort <level>", "Reasoning effort: low|medium|high|max|xhigh", "medium")
  .option(
    "--request-timeout <seconds>",
    "Upstream request timeout",
    (v: string) => parseFloat(v),
    300,
  )
  .option(
    "--max-request-body-bytes <bytes>",
    "Max request body size (default 20MB)",
    (v: string) => parseInt(v, 10),
    20971520,
  )
  .option(
    "--missing-reasoning-strategy <strategy>",
    "Missing reasoning strategy: recover|reject",
    "recover",
  )
  .option("--clear-reasoning-cache", "Clear reasoning cache and exit")
  .option("--no-ngrok", "Disable ngrok tunnel")
  .option("--verbose", "Enable verbose logging", false)
  .option("--no-display-reasoning", "Hide reasoning from visible content")
  .option("--no-collapsible-reasoning", "Disable collapsible Markdown for reasoning")
  .action(async function (this: Command) {
    await startAction(this.opts());
  });

async function startAction(rawOpts: Record<string, unknown>) {
  const noInteractive = rawOpts.interactive === false;
  const detach = rawOpts.detach ?? false;

  let wizardDetach = false;
  if (!noInteractive) {
    wizardDetach = await interactiveWizard();
  } else {
    if (existsSync(CONFIG_PATH)) {
      p.log.step(`Using existing config: ${CONFIG_PATH}`);
    }
  }

  if (detach || wizardDetach) {
    spawnBackgroundProcess();
    return;
  }

  writePidFile();

  try {
    const cliArgs = parseArgs(rawOpts);
    const config = createConfig(cliArgs);

    p.log.step(`Model: ${config.upstreamModel} (${config.thinking}, ${config.reasoningEffort})`);
    p.log.step(`Local:  http://${config.host}:${config.port}/v1`);

    const store = new ReasoningStore(
      config.reasoningContentPath,
      config.reasoningCacheMaxAgeSeconds,
      config.reasoningCacheMaxRows,
    );

    if (cliArgs.clearReasoningCache) {
      const deleted = store.clear();
      p.log.success(`Cleared ${deleted} reasoning cache row(s)`);
      store.close();
      process.exit(0);
    }

    const { tunnel, publicUrl } = await startServer(config, store);

    if (publicUrl) {
      p.log.step(`Public: ${publicUrl}/v1`);
      writeFileSync(LOG_PATH, `ngrok_url: ${publicUrl}/v1\n`, "utf-8");
    }

    p.outro("Proxy is running. Press Ctrl+C to stop.");

    const shutdown = () => {
      p.log.info("Shutting down...");
      if (tunnel) tunnel.stop();
      store.close();
      removePidFile();
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);

    // Keep the process alive until SIGINT/SIGTERM
    await new Promise(() => {});
  } catch (err) {
    p.log.error(`Failed to start: ${String(err)}`);
    removePidFile();
    process.exit(1);
  }
}

async function interactiveWizard() {
  p.intro("deepseek-lane  —  Local proxy for Cursor \u2194 DeepSeek");

  const provider = await p.select({
    message: "API provider",
    options: [
      { value: "opencode", label: "OpenCode API", hint: "opencode.ai/zen/go/v1" },
      { value: "deepseek", label: "DeepSeek Official API", hint: "api.deepseek.com" },
      { value: "custom", label: "Custom URL" },
    ],
  });
  if (p.isCancel(provider)) {
    p.cancel("Cancelled");
    process.exit(0);
  }

  let baseUrl: string;
  if (provider === "opencode") {
    baseUrl = "https://opencode.ai/zen/go/v1";
  } else if (provider === "deepseek") {
    baseUrl = "https://api.deepseek.com/v1";
  } else {
    const result = await p.text({ message: "Custom API base URL", placeholder: "https://..." });
    if (p.isCancel(result)) {
      p.cancel("Cancelled");
      process.exit(0);
    }
    baseUrl = String(result).replace(/\/+$/, "");
  }

  const model = String(
    await p.text({
      message: "Default model",
      placeholder: "deepseek-v4-pro",
      initialValue: "deepseek-v4-pro",
    }),
  );
  if (p.isCancel(model)) {
    p.cancel("Cancelled");
    process.exit(0);
  }

  const port = String(
    await p.text({
      message: "Port",
      placeholder: "19199",
      initialValue: "19199",
      validate: (v) => (isNaN(parseInt(v!, 10)) ? "Enter a number" : undefined),
    }),
  );
  if (p.isCancel(port)) {
    p.cancel("Cancelled");
    process.exit(0);
  }

  const thinking = await p.select({
    message: "Thinking mode",
    options: [
      { value: "enabled", label: "Enabled" },
      { value: "disabled", label: "Disabled" },
    ],
    initialValue: "enabled",
  });
  if (p.isCancel(thinking)) {
    p.cancel("Cancelled");
    process.exit(0);
  }

  const reasoningEffort = String(
    await p.select({
      message: "Reasoning effort",
      options: [
        { value: "medium", label: "Medium" },
        { value: "low", label: "Low" },
        { value: "high", label: "High" },
        { value: "max", label: "Max" },
        { value: "xhigh", label: "Extra High" },
      ],
      initialValue: "medium",
    }),
  );
  if (p.isCancel(reasoningEffort)) {
    p.cancel("Cancelled");
    process.exit(0);
  }

  const ngrok = await p.confirm({
    message: "Enable ngrok tunnel?",
    initialValue: true,
  });
  if (p.isCancel(ngrok)) {
    p.cancel("Cancelled");
    process.exit(0);
  }

  const displayReasoning = await p.confirm({
    message: "Display reasoning in Cursor?",
    initialValue: true,
  });
  if (p.isCancel(displayReasoning)) {
    p.cancel("Cancelled");
    process.exit(0);
  }

  const collapsibleReasoning = await p.confirm({
    message: "Use collapsible Markdown for reasoning?",
    initialValue: true,
  });
  if (p.isCancel(collapsibleReasoning)) {
    p.cancel("Cancelled");
    process.exit(0);
  }

  const detach = await p.confirm({
    message: "Run in background (detached mode)?",
    initialValue: false,
  });
  if (p.isCancel(detach)) {
    p.cancel("Cancelled");
    process.exit(0);
  }

  writeConfig({
    base_url: baseUrl,
    model,
    thinking,
    reasoning_effort: reasoningEffort,
    display_reasoning: displayReasoning,
    collapsible_reasoning: collapsibleReasoning,
    host: "127.0.0.1",
    port: parseInt(port, 10),
    ngrok,
    verbose: false,
    request_timeout: 300,
    max_request_body_bytes: 20971520,
    cors: false,
    missing_reasoning_strategy: "recover",
    reasoning_cache_max_age_seconds: 2592000,
    reasoning_cache_max_rows: 100000,
  });
  p.log.success(`Config saved: ${CONFIG_PATH}`);

  return detach;
}

function spawnBackgroundProcess(): void {
  const self = process.argv[1];
  const isBuilt = !self.endsWith(".ts");

  let child;
  if (isBuilt) {
    child = spawn(process.execPath, [self, "start", "--no-interactive"], {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, FORCE_COLOR: "0" },
    });
  } else {
    child = spawn("npx", ["tsx", self, "start", "--no-interactive"], {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, FORCE_COLOR: "0" },
    });
  }
  child.unref();

  writePidFile(child.pid);
  p.log.success(`Proxy started in background (PID ${child.pid})`);

  const ngrokUrl = detectNgrokUrl();
  if (ngrokUrl) {
    p.log.info(`Public URL: ${ngrokUrl}`);
  }
  p.log.info(`Log: ${LOG_PATH}`);
  p.log.info(`PID file: ${PID_PATH}`);
}

function parseArgs(rawOpts: Record<string, unknown>): CliArgs {
  const args: CliArgs = {};

  if (rawOpts.config) args.config = rawOpts.config as string;
  if (rawOpts.host) args.host = rawOpts.host as string;
  if (rawOpts.port) args.port = rawOpts.port as number;
  if (rawOpts.model) args.model = rawOpts.model as string;
  if (rawOpts.baseUrl) args.baseUrl = rawOpts.baseUrl as string;
  if (rawOpts.thinking) args.thinking = rawOpts.thinking as "enabled" | "disabled";
  if (rawOpts.reasoningEffort)
    args.reasoningEffort = rawOpts.reasoningEffort as "low" | "medium" | "high" | "max" | "xhigh";
  if (rawOpts.requestTimeout) args.requestTimeout = rawOpts.requestTimeout as number;
  if (rawOpts.maxRequestBodyBytes) args.maxRequestBodyBytes = rawOpts.maxRequestBodyBytes as number;
  if (rawOpts.missingReasoningStrategy)
    args.missingReasoningStrategy = rawOpts.missingReasoningStrategy as "recover" | "reject";
  if (rawOpts.clearReasoningCache) args.clearReasoningCache = true;

  if (rawOpts.strictModelNames === true) args.strictModelNames = true;
  if (rawOpts.strictModelNames === false) args.strictModelNames = false;
  if (rawOpts.ngrok === true) args.ngrok = true;
  if (rawOpts.ngrok === false) args.ngrok = false;
  if (rawOpts.verbose === true) args.verbose = true;
  if (rawOpts.verbose === false) args.verbose = false;
  if (rawOpts.displayReasoning === true) args.displayReasoning = true;
  if (rawOpts.displayReasoning === false) args.displayReasoning = false;
  if (rawOpts.collapsibleReasoning === true) args.collapsibleReasoning = true;
  if (rawOpts.collapsibleReasoning === false) args.collapsibleReasoning = false;

  return args;
}

export { startCmd };
