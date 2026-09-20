import { readFileSync, existsSync, mkdirSync, writeFileSync, chmodSync } from "fs";
import { resolve, dirname } from "path";
import { homedir } from "os";
import { load } from "js-yaml";
import { ProxyConfigSchema } from "./schemas.js";
import type { ProxyConfig, CliArgs } from "./types.js";

export const APP_DIR = resolve(homedir(), ".deepseek-lane");
export const CONFIG_PATH = resolve(APP_DIR, "config.yaml");
export const REASONING_CONTENT_PATH = resolve(APP_DIR, "reasoning_content.sqlite3");

const DEFAULT_CONFIG_TEXT = `# deepseek-lane config
# API keys are read from Cursor's Authorization header and forwarded upstream.

base_url: https://opencode.ai/zen/go/v1
model: deepseek-v4-pro
# Reject model names this proxy does not serve instead of answering them with
# the default model above.
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
cors: false

missing_reasoning_strategy: recover
reasoning_cache_max_age_seconds: 2592000
reasoning_cache_max_rows: 100000
`;

function loadYamlConfig(configPath: string): Record<string, unknown> {
  if (!existsSync(configPath)) {
    const dir = dirname(configPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    writeFileSync(configPath, DEFAULT_CONFIG_TEXT, "utf-8");
    chmodSync(configPath, 0o600);
    return {};
  }
  const raw = readFileSync(configPath, "utf-8");
  const loaded = load(raw) as Record<string, unknown> | null;
  return loaded ?? {};
}

export function createConfig(cliArgs: CliArgs): ProxyConfig {
  const configPath = cliArgs.config ?? CONFIG_PATH;
  const fileConfig = loadYamlConfig(configPath);

  const fromFile = (key: string, def: unknown): unknown =>
    fileConfig[key] !== undefined ? fileConfig[key] : def;

  const reasoningContentPathVal = String(
    fromFile("reasoning_content_path", REASONING_CONTENT_PATH),
  );

  let thinking: string;
  if (cliArgs.thinking !== undefined) {
    thinking = cliArgs.thinking;
  } else {
    const fileThinking = fromFile("thinking", "enabled");
    thinking = String(fileThinking).toLowerCase();
  }

  if (thinking === "disabled") {
    thinking = "disabled";
  } else {
    thinking = "enabled";
  }

  let reasoningEffort: string;
  if (cliArgs.reasoningEffort !== undefined) {
    reasoningEffort = cliArgs.reasoningEffort.toLowerCase();
  } else {
    reasoningEffort = String(fromFile("reasoning_effort", "medium")).toLowerCase();
  }

  const validEfforts = ["low", "medium", "high", "max", "xhigh"];
  const validatedReasoningEffort = validEfforts.includes(reasoningEffort)
    ? reasoningEffort
    : "medium";

  let missingReasoningStrategy: string;
  if (cliArgs.missingReasoningStrategy !== undefined) {
    missingReasoningStrategy = cliArgs.missingReasoningStrategy.toLowerCase();
  } else {
    missingReasoningStrategy = String(
      fromFile("missing_reasoning_strategy", "recover"),
    ).toLowerCase();
  }

  const validStrategies = ["recover", "reject"];
  const validatedMissingReasoningStrategy = validStrategies.includes(missingReasoningStrategy)
    ? missingReasoningStrategy
    : "recover";

  const rawConfig: Record<string, unknown> = {};

  rawConfig.host = cliArgs.host ?? fromFile("host", "127.0.0.1");
  rawConfig.port = cliArgs.port ?? fromFile("port", 19199);
  rawConfig.upstreamBaseUrl = (
    cliArgs.baseUrl ?? (fromFile("base_url", "https://opencode.ai/zen/go/v1") as string)
  )
    .toString()
    .replace(/\/+$/, "");
  rawConfig.upstreamModel = cliArgs.model ?? fromFile("model", "deepseek-v4-pro");
  rawConfig.strictModelNames =
    cliArgs.strictModelNames !== undefined
      ? cliArgs.strictModelNames
      : fromFile("strict_model_names", false);
  rawConfig.thinking = thinking;
  rawConfig.reasoningEffort = validatedReasoningEffort;
  rawConfig.requestTimeout = cliArgs.requestTimeout ?? fromFile("request_timeout", 300);
  rawConfig.maxRequestBodyBytes =
    cliArgs.maxRequestBodyBytes ?? fromFile("max_request_body_bytes", 20 * 1024 * 1024);
  rawConfig.reasoningContentPath = reasoningContentPathVal;
  rawConfig.missingReasoningStrategy = validatedMissingReasoningStrategy;
  rawConfig.reasoningCacheMaxAgeSeconds = fromFile(
    "reasoning_cache_max_age_seconds",
    30 * 24 * 60 * 60,
  );
  rawConfig.reasoningCacheMaxRows = fromFile("reasoning_cache_max_rows", 100000);
  rawConfig.displayReasoning =
    cliArgs.displayReasoning !== undefined
      ? cliArgs.displayReasoning
      : fromFile("display_reasoning", true);
  rawConfig.collapsibleReasoning =
    cliArgs.collapsibleReasoning !== undefined
      ? cliArgs.collapsibleReasoning
      : // Backward-compat: "collasible" was a typo in older config versions
        fromFile("collapsible_reasoning", fromFile("collasible_reasoning", true));
  rawConfig.ngrok = cliArgs.ngrok !== undefined ? cliArgs.ngrok : fromFile("ngrok", true);
  rawConfig.verbose = cliArgs.verbose !== undefined ? cliArgs.verbose : fromFile("verbose", false);

  return ProxyConfigSchema.parse(rawConfig);
}
