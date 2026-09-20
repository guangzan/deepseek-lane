import { createHash } from "crypto";
import { ChatMessage, ToolCall, ToolDefinition, PreparedRequest } from "./types.js";
import { ProxyConfig } from "./types.js";
import {
  ReasoningStore,
  conversationScope,
  messageSignature,
  toolCallIds,
  toolCallNames,
  toolCallSignature,
  turnContextSignature,
} from "./reasoning-store.js";
import { normalizeReasoningEffort, foldReasoningIntoContent } from "./streaming.js";
import { logVerbose, logWarn } from "./logging.js";

function safeString(v: unknown, def = ""): string {
  if (v == null) return def;
  if (typeof v === "string") return v;
  return JSON.stringify(v) ?? def;
}

const SUPPORTED_REQUEST_FIELDS = new Set([
  "model",
  "messages",
  "stream",
  "stream_options",
  "max_tokens",
  "response_format",
  "stop",
  "tools",
  "tool_choice",
  "thinking",
  "reasoning_effort",
  "temperature",
  "top_p",
  "presence_penalty",
  "frequency_penalty",
  "logprobs",
  "top_logprobs",
  "user",
  "seed",
  "n",
  "logit_bias",
]);

const MESSAGE_FIELDS = new Set([
  "role",
  "content",
  "name",
  "tool_call_id",
  "tool_calls",
  "reasoning_content",
  "prefix",
]);

const ROLE_MESSAGE_FIELDS: Record<string, Set<string>> = {
  system: new Set(["role", "content", "name"]),
  user: new Set(["role", "content", "name"]),
  assistant: new Set(["role", "content", "name", "tool_calls", "reasoning_content", "prefix"]),
  tool: new Set(["role", "content", "tool_call_id"]),
};

const CURSOR_THINKING_RE =
  /(?:<(?:think|thinking)\b[^>]*>[\s\S]*?(?:<\/(?:think|thinking)>|Z)|<details\b[^>]*>\s*<summary\b[^>]*>\s*Thinking\s*<\/summary>[\s\S]*?(?:<\/details>|Z))\s*/gi;

export const RECOVERY_NOTICE_TEXT = "[cursor-deepseek] Refreshed reasoning_content history.";
export const RECOVERY_NOTICE_CONTENT = `${RECOVERY_NOTICE_TEXT}\n\n`;
export const RECOVERY_SYSTEM_CONTENT =
  "cursor-deepseek recovered this request because older DeepSeek thinking-mode tool-call reasoning_content was unavailable. Older unrecoverable tool-call history was omitted; continue using only the remaining recovered context.";

export function stripCursorThinkingBlocks(content: string): string {
  return content.replace(CURSOR_THINKING_RE, "").replace(/^[\r\n]+/, "");
}

export function extractTextContent(content: unknown): string | null {
  if (content === null || content === undefined) return null;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const item of content) {
      if (typeof item === "string") {
        parts.push(item);
        continue;
      }
      if (typeof item !== "object" || item === null) {
        parts.push(String(item));
        continue;
      }
      const it = item as Record<string, unknown>;
      const text = it.text ?? it.content;
      if (it.type === "text" || it.type === "input_text") {
        if (typeof text === "string") parts.push(text);
      } else if (typeof text === "string") {
        parts.push(text);
      } else if (it.type) {
        parts.push(`[${safeString(it.type)} omitted by DeepSeek proxy]`);
      }
    }
    return parts.filter(Boolean).join("\n");
  }
  if (typeof content === "object") return JSON.stringify(content);
  return safeString(content);
}

function normalizeToolCall(tc: unknown): ToolCall {
  if (typeof tc !== "object" || tc === null) return { function: { name: "", arguments: "" } };
  const t = tc as Record<string, unknown>;
  const fn = (t.function !== undefined ? (t.function as Record<string, unknown>) : {}) as Record<
    string,
    unknown
  >;
  const rawArgs: unknown = fn.arguments;
  const args = typeof rawArgs === "string" ? rawArgs : JSON.stringify(rawArgs);
  return {
    id: safeString(t.id),
    type: safeString(t.type, "function"),
    function: {
      name: safeString(fn.name),
      arguments: args,
    },
  };
}

function normalizeTool(tool: unknown): ToolDefinition {
  if (typeof tool !== "object" || tool === null) {
    return { type: "function", function: { name: "", description: "", parameters: {} } };
  }
  const t = { ...(tool as Record<string, unknown>) } as Record<string, unknown>;
  t.type = safeString(t.type, "function");
  if (typeof t.function !== "object" || t.function === null) t.function = {};
  return t as unknown as ToolDefinition;
}

function legacyFunctionToTool(fn: unknown): ToolDefinition {
  return {
    type: "function",
    function: (fn as Record<string, unknown>) ?? {},
  } as unknown as ToolDefinition;
}

function convertFunctionCall(fc: unknown): string | Record<string, unknown> | undefined {
  if (typeof fc === "string") {
    if (["auto", "none", "required"].includes(fc)) return fc;
    return undefined;
  }
  if (typeof fc === "object" && fc !== null) {
    const f = fc as Record<string, unknown>;
    if (f.name) return { type: "function", function: { name: safeString(f.name) } };
  }
  return undefined;
}

function normalizeToolChoice(tc: unknown): unknown {
  if (typeof tc === "string") {
    if (["auto", "none", "required"].includes(tc)) return tc;
    return undefined;
  }
  if (typeof tc === "object" && tc !== null) {
    const t = tc as Record<string, unknown>;
    if (t.type === "function") {
      const fn = t.function as Record<string, unknown> | undefined;
      if (fn?.name) return { type: "function", function: { name: safeString(fn.name) } };
    }
    return tc;
  }
  return tc;
}

function normalizeMessage(
  message: unknown,
  store: ReasoningStore | null,
  priorMessages: ChatMessage[],
  cacheNamespace: string,
  repairReasoning: boolean,
  keepReasoning: boolean,
): {
  normalized: ChatMessage;
  patched: boolean;
  missing: boolean;
  diagnostic: Record<string, unknown> | null;
} {
  if (typeof message !== "object" || message === null) {
    message = { role: "user", content: String(message) };
  }

  const raw = message as Record<string, unknown>;
  const normalized: Record<string, unknown> = {};
  for (const key of Object.keys(raw)) {
    if (MESSAGE_FIELDS.has(key)) normalized[key] = (raw as Record<string, unknown>)[key];
  }

  let role = safeString(normalized.role, "user");
  if (role === "function") role = "tool";
  normalized.role = role;

  if ("content" in normalized) {
    normalized.content = extractTextContent(normalized.content) ?? "";
  } else if (["assistant", "tool", "system", "user"].includes(role)) {
    normalized.content = "";
  }

  if (role === "assistant" && typeof normalized.content === "string") {
    normalized.content = stripCursorThinkingBlocks(normalized.content);
  }

  if (normalized.tool_calls) {
    normalized.tool_calls = (normalized.tool_calls as unknown[]).map(normalizeToolCall);
  }

  let patched = false;
  let missing = false;
  let diagnostic: Record<string, unknown> | null = null;

  const asChatMsg = () => normalized as unknown as ChatMessage;

  if (role === "assistant") {
    if (!keepReasoning) {
      delete normalized.reasoning_content;
    } else if (repairReasoning) {
      const reasoning = normalized.reasoning_content;
      if (typeof reasoning !== "string" || !reasoning) {
        delete normalized.reasoning_content;
        const needsReasoning = assistantNeedsReasoningForToolContext(asChatMsg(), priorMessages);
        const lookupScope = conversationScope(priorMessages, cacheNamespace);
        const lookupKeys: Record<string, unknown>[] = needsReasoning
          ? reasoningLookupKeys(asChatMsg(), lookupScope, cacheNamespace, priorMessages)
          : [];

        let hitKind: string | undefined;
        if (needsReasoning && store) {
          for (const lk of lookupKeys) {
            const restored = store.get(String(lk.key));
            if (restored) {
              lk.hit = true;
              hitKind = String(lk.kind);
              normalized.reasoning_content = restored;
              patched = true;
              if (!lk.portable) {
                store.backfillPortableAliases(asChatMsg(), restored, cacheNamespace, priorMessages);
              }
              break;
            }
          }
        }
        if (needsReasoning && !patched) missing = true;
        if (needsReasoning) {
          diagnostic = {
            message_index: priorMessages.length,
            role: "assistant",
            needs_reasoning: true,
            had_reasoning_content: false,
            patched,
            missing,
            lookup_scope: lookupScope,
            message_signature: messageSignature(asChatMsg()),
            tool_call_ids: toolCallIds(asChatMsg()),
            lookup_keys: lookupKeys,
            hit_kind: hitKind,
          };
        }
      } else if (assistantNeedsReasoningForToolContext(asChatMsg(), priorMessages)) {
        diagnostic = {
          message_index: priorMessages.length,
          role: "assistant",
          needs_reasoning: true,
          had_reasoning_content: true,
          patched: false,
          missing: false,
          lookup_scope: conversationScope(priorMessages, cacheNamespace),
          message_signature: messageSignature(asChatMsg()),
          tool_call_ids: toolCallIds(asChatMsg()),
          lookup_keys: [],
          hit_kind: "request",
        };
      }
    }
  }

  const allowedFields = ROLE_MESSAGE_FIELDS[normalized.role as string] ?? MESSAGE_FIELDS;
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(normalized)) {
    if (allowedFields.has(key)) result[key] = normalized[key];
  }

  return {
    normalized: result as unknown as ChatMessage,
    patched,
    missing,
    diagnostic,
  };
}

function reasoningLookupKeys(
  message: ChatMessage,
  scope: string,
  cacheNamespace = "",
  priorMessages?: ChatMessage[],
): Record<string, unknown>[] {
  const keys: Record<string, unknown>[] = [
    {
      kind: "message_signature",
      key: `scope:${scope}:signature:${messageSignature(message)}`,
      portable: false,
      hit: false,
    },
  ];

  for (const id of toolCallIds(message)) {
    keys.push({
      kind: "tool_call_id",
      tool_call_id: id,
      key: `scope:${scope}:tool_call:${id}`,
      portable: false,
      hit: false,
    });
  }
  for (const tc of message.tool_calls ?? []) {
    keys.push({
      kind: "tool_call_signature",
      function_name: tc.function?.name ?? "",
      key: `scope:${scope}:tool_call_signature:${toolCallSignature(tc)}`,
      portable: false,
      hit: false,
    });
  }
  for (const name of toolCallNames(message)) {
    keys.push({
      kind: "tool_name",
      function_name: name,
      key: `scope:${scope}:tool_name:${name}`,
      portable: false,
      hit: false,
    });
  }

  if (cacheNamespace && priorMessages) {
    const turnSig = turnContextSignature(priorMessages);
    keys.push({
      kind: "portable_message_signature",
      key: `namespace:${cacheNamespace}:turn:${turnSig}:signature:${messageSignature(message)}`,
      turn_context_signature: turnSig,
      portable: true,
      hit: false,
    });
    for (const id of toolCallIds(message)) {
      keys.push({
        kind: "portable_tool_call_id",
        tool_call_id: id,
        key: `namespace:${cacheNamespace}:turn:${turnSig}:tool_call:${id}`,
        turn_context_signature: turnSig,
        portable: true,
        hit: false,
      });
    }
    for (const tc of message.tool_calls ?? []) {
      keys.push({
        kind: "portable_tool_call_signature",
        function_name: tc.function?.name ?? "",
        key: `namespace:${cacheNamespace}:turn:${turnSig}:tool_call_signature:${toolCallSignature(tc)}`,
        turn_context_signature: turnSig,
        portable: true,
        hit: false,
      });
    }
    for (const name of toolCallNames(message)) {
      keys.push({
        kind: "portable_tool_name",
        function_name: name,
        key: `namespace:${cacheNamespace}:turn:${turnSig}:tool_name:${name}`,
        turn_context_signature: turnSig,
        portable: true,
        hit: false,
      });
    }
  }

  return keys;
}

function normalizeMessages(
  messages: unknown,
  store: ReasoningStore | null,
  cacheNamespace: string,
  repairReasoning: boolean,
  keepReasoning: boolean,
): {
  messages: ChatMessage[];
  patchedCount: number;
  missingIndexes: number[];
  diagnostics: Record<string, unknown>[];
} {
  if (!Array.isArray(messages))
    return { messages: [], patchedCount: 0, missingIndexes: [], diagnostics: [] };

  const result: ChatMessage[] = [];
  let patchedCount = 0;
  const missingIndexes: number[] = [];
  const diagnostics: Record<string, unknown>[] = [];

  for (const msg of messages) {
    const { normalized, patched, missing, diagnostic } = normalizeMessage(
      msg,
      store,
      result,
      cacheNamespace,
      repairReasoning,
      keepReasoning,
    );
    result.push(normalized);
    if (patched) patchedCount++;
    if (missing) missingIndexes.push(result.length - 1);
    if (diagnostic) diagnostics.push(diagnostic);
  }

  return { messages: result, patchedCount, missingIndexes, diagnostics };
}

function hasRecoveryNotice(msg: ChatMessage): boolean {
  return (
    msg.role === "assistant" &&
    typeof msg.content === "string" &&
    msg.content.startsWith(RECOVERY_NOTICE_TEXT)
  );
}

function stripRecoveryNoticeForUpstream(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((msg) => {
    if (msg.role !== "assistant") return msg;
    if (typeof msg.content !== "string" || !msg.content.startsWith(RECOVERY_NOTICE_TEXT))
      return msg;
    return {
      ...msg,
      content: msg.content.slice(RECOVERY_NOTICE_TEXT.length).replace(/^[\r\n]+/, ""),
    };
  });
}

function leadingSystemMessages(messages: ChatMessage[]): ChatMessage[] {
  const result: ChatMessage[] = [];
  for (const msg of messages) {
    if (msg.role === "system") result.push(msg);
    else break;
  }
  return result;
}

function activeMessagesFromRecoveryBoundary(messages: ChatMessage[]): {
  activeMessages: ChatMessage[];
  retiredPrefixMessages: number;
  step: Record<string, unknown>;
} | null {
  let recoveryBoundaryIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (hasRecoveryNotice(messages[i])) {
      recoveryBoundaryIndex = i;
      break;
    }
  }
  if (recoveryBoundaryIndex === -1) return null;

  let contextUserIndex = -1;
  for (let i = recoveryBoundaryIndex - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      contextUserIndex = i;
      break;
    }
  }

  const leading = leadingSystemMessages(messages);
  const recoveredTail: ChatMessage[] = [];
  if (contextUserIndex !== -1) recoveredTail.push(messages[contextUserIndex]);
  recoveredTail.push(...messages.slice(recoveryBoundaryIndex));

  const activeMessages = [
    ...leading,
    { role: "system" as const, content: RECOVERY_SYSTEM_CONTENT },
    ...recoveredTail,
  ];

  const keptContextMessages = contextUserIndex !== -1 ? 1 : 0;
  const retiredMessages = Math.max(recoveryBoundaryIndex - leading.length - keptContextMessages, 0);

  return {
    activeMessages,
    retiredPrefixMessages: retiredMessages,
    step: {
      strategy: "continued_recovery_boundary",
      recovery_boundary_index: recoveryBoundaryIndex,
      context_user_index: contextUserIndex,
      retired_prefix_messages: retiredMessages,
    },
  };
}

function recoverMessagesFromMissingReasoning(
  messages: ChatMessage[],
  missingIndexes: number[],
): {
  recovered: ChatMessage[];
  droppedMessages: number;
  notice: string | null;
  step: Record<string, unknown>;
} {
  let recoveryBoundaryIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (hasRecoveryNotice(messages[i]) && missingIndexes.some((mi) => mi < i)) {
      recoveryBoundaryIndex = i;
      break;
    }
  }

  if (recoveryBoundaryIndex !== -1) {
    let contextUserIndex = -1;
    for (let i = recoveryBoundaryIndex - 1; i >= 0; i--) {
      if (messages[i].role === "user") {
        contextUserIndex = i;
        break;
      }
    }

    const leading = leadingSystemMessages(messages);
    const recoveredTail: ChatMessage[] = [];
    if (contextUserIndex !== -1) recoveredTail.push(messages[contextUserIndex]);
    recoveredTail.push(...messages.slice(recoveryBoundaryIndex));

    const recovered = [
      ...leading,
      { role: "system" as const, content: RECOVERY_SYSTEM_CONTENT },
      ...recoveredTail,
    ];

    const keptContextMessages = contextUserIndex !== -1 ? 1 : 0;
    const omittedMessages = recoveryBoundaryIndex - leading.length - keptContextMessages;

    return {
      recovered,
      droppedMessages: Math.max(omittedMessages, 0),
      notice: null,
      step: {
        strategy: "recovery_boundary",
        missing_indexes: missingIndexes,
        recovery_boundary_index: recoveryBoundaryIndex,
        context_user_index: contextUserIndex,
        dropped_messages: Math.max(omittedMessages, 0),
        notice: null,
      },
    };
  }

  let lastUserIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      lastUserIndex = i;
      break;
    }
  }

  if (lastUserIndex === -1) {
    return {
      recovered: messages,
      droppedMessages: 0,
      notice: null,
      step: {
        strategy: "none",
        missing_indexes: missingIndexes,
        last_user_index: null,
        dropped_messages: 0,
        notice: null,
      },
    };
  }

  const recovered = leadingSystemMessages(messages);
  const omittedMessages = messages.length - recovered.length - 1;
  recovered.push({ role: "system" as const, content: RECOVERY_SYSTEM_CONTENT });
  recovered.push(messages[lastUserIndex]);

  return {
    recovered,
    droppedMessages: omittedMessages,
    notice: RECOVERY_NOTICE_CONTENT,
    step: {
      strategy: "latest_user",
      missing_indexes: missingIndexes,
      last_user_index: lastUserIndex,
      dropped_messages: omittedMessages,
      notice: RECOVERY_NOTICE_CONTENT,
    },
  };
}

function assistantNeedsReasoningForToolContext(
  message: ChatMessage,
  priorMessages: ChatMessage[],
): boolean {
  if (message.tool_calls) return true;
  for (let i = priorMessages.length - 1; i >= 0; i--) {
    const role = priorMessages[i].role;
    if (role === "tool") return true;
    if (role === "user" || role === "system") return false;
  }
  return false;
}

// Pass through deepseek- prefixed models as-is, otherwise use the configured
// default model. OpenCode AI and other upstream providers accept deepseek- models.
function upstreamModelFor(originalModel: string, config: ProxyConfig): string {
  if (originalModel.startsWith("deepseek-")) return originalModel;
  if (originalModel !== config.upstreamModel) {
    warnModelSubstitution(originalModel, config.upstreamModel);
  }
  return config.upstreamModel;
}

// Whether a requested model name is one this proxy actually serves: either a
// DeepSeek model name, or the configured default model itself.
export function isServedModel(model: string, config: ProxyConfig): boolean {
  return model.startsWith("deepseek-") || model === config.upstreamModel;
}

const reportedSubstitutions = new Set<string>();

// Requests for models this proxy does not serve are answered by the default
// model, which is easy to miss when reading only the model picker. Report each
// substituted name once per process.
function warnModelSubstitution(originalModel: string, upstreamModel: string): void {
  const key = `${originalModel}->${upstreamModel}`;
  if (reportedSubstitutions.has(key)) return;
  reportedSubstitutions.add(key);
  logWarn(
    `model ${originalModel} is not served by this proxy; requests are answered by ${upstreamModel}`,
  );
}

function reasoningModelFamily(model: string): string {
  if (["deepseek-v4-pro", "deepseek-v4-flash"].includes(model)) return "deepseek-v4";
  return model;
}

function reasoningCacheNamespace(
  config: ProxyConfig,
  upstreamModel: string,
  thinking: unknown,
  reasoningEffort: unknown,
  authorization?: string,
): string {
  const authHash = authorization ? createHash("sha256").update(authorization).digest("hex") : "";
  const payload = {
    base_url: config.upstreamBaseUrl,
    model: reasoningModelFamily(upstreamModel),
    thinking,
    reasoning_effort: reasoningEffort,
    authorization_hash: authHash,
  };
  return createHash("sha256")
    .update(JSON.stringify(payload, Object.keys(payload).sort()))
    .digest("hex");
}

function responseRecordingContexts(
  ...items: ([string, ChatMessage[]] | null)[]
): [string, ChatMessage[]][] {
  const contexts: [string, ChatMessage[]][] = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (!item) continue;
    const [scope] = item;
    if (seen.has(scope)) continue;
    seen.add(scope);
    contexts.push(item);
  }
  return contexts;
}

export function prepareUpstreamRequest(
  payload: Record<string, unknown>,
  config: ProxyConfig,
  store: ReasoningStore | null,
  authorization?: string,
): PreparedRequest {
  const originalModel = safeString(payload.model, config.upstreamModel);
  const upstreamModel = upstreamModelFor(originalModel, config);

  const prepared: Record<string, unknown> = {};
  for (const key of Object.keys(payload)) {
    if (SUPPORTED_REQUEST_FIELDS.has(key)) prepared[key] = payload[key];
  }

  const droppedFields = Object.keys(payload).filter(
    (k) =>
      !SUPPORTED_REQUEST_FIELDS.has(k) &&
      !["max_completion_tokens", "functions", "function_call"].includes(k),
  );
  if (droppedFields.length > 0) {
    logVerbose(`dropping unsupported request field(s): ${droppedFields.join(", ")}`);
  }

  if (!("max_tokens" in prepared) && payload.max_completion_tokens !== undefined) {
    prepared.max_tokens = payload.max_completion_tokens;
  }

  prepared.model = upstreamModel;

  if (prepared.stream) {
    const streamOpts = {
      ...(prepared.stream_options as Record<string, unknown>),
      include_usage: true,
    };
    prepared.stream_options = streamOpts;
  }

  if (Array.isArray(prepared.tools)) {
    prepared.tools = (prepared.tools as unknown[]).map(normalizeTool);
  } else if (Array.isArray(payload.functions)) {
    prepared.tools = (payload.functions as unknown[]).map(legacyFunctionToTool);
  }

  if ("tool_choice" in prepared) {
    const tc = normalizeToolChoice(prepared.tool_choice);
    if (tc === undefined) delete prepared.tool_choice;
    else prepared.tool_choice = tc;
  } else if (payload.function_call !== undefined) {
    const tc = convertFunctionCall(payload.function_call);
    if (tc !== undefined) prepared.tool_choice = tc;
  }

  prepared.thinking = { type: config.thinking };
  const thinkingEnabled = config.thinking === "enabled";
  const thinkingDisabled = config.thinking === "disabled";

  if (thinkingEnabled) {
    prepared.reasoning_effort = normalizeReasoningEffort(config.reasoningEffort);
  }

  const cacheNamespace = reasoningCacheNamespace(
    config,
    upstreamModel,
    prepared.thinking,
    prepared.reasoning_effort,
    authorization,
  );

  const { messages: preRepairMessages } = normalizeMessages(
    payload.messages,
    null,
    cacheNamespace,
    false,
    !thinkingDisabled,
  );

  const recordResponseMessages = preRepairMessages;
  const recordResponseScope = conversationScope(recordResponseMessages, cacheNamespace);
  let messagesForRepair = preRepairMessages;
  let continuedRecoveryBoundary = false;
  let retiredPrefixMessages = 0;
  let recoveredCount = 0;
  let recoveryDroppedMessages = 0;
  let recoveryNotice: string | null = null;
  const recoverySteps: Record<string, unknown>[] = [];

  if (thinkingEnabled && config.missingReasoningStrategy === "recover") {
    const boundary = activeMessagesFromRecoveryBoundary(preRepairMessages);
    if (boundary) {
      messagesForRepair = boundary.activeMessages;
      retiredPrefixMessages = boundary.retiredPrefixMessages;
      continuedRecoveryBoundary = true;
      recoverySteps.push(boundary.step);
    }
  }

  let {
    messages,
    patchedCount,
    missingIndexes,
    diagnostics: reasoningDiagnostics,
  } = normalizeMessages(
    messagesForRepair,
    store,
    cacheNamespace,
    thinkingEnabled,
    !thinkingDisabled,
  );

  while (missingIndexes.length > 0 && config.missingReasoningStrategy === "recover") {
    const { recovered, droppedMessages, notice, step } = recoverMessagesFromMissingReasoning(
      messages,
      missingIndexes,
    );
    recoverySteps.push(step);

    if (droppedMessages === 0) break;
    recoveredCount += missingIndexes.length;
    recoveryDroppedMessages += droppedMessages;
    if (notice) recoveryNotice = notice;

    const result = normalizeMessages(
      recovered,
      store,
      cacheNamespace,
      thinkingEnabled,
      !thinkingDisabled,
    );
    messages = result.messages;
    patchedCount = result.patchedCount;
    missingIndexes = result.missingIndexes;
    reasoningDiagnostics = reasoningDiagnostics.concat(result.diagnostics);
  }

  const activeRecordResponseScope = conversationScope(messages, cacheNamespace);
  const recordResponseContexts = responseRecordingContexts(
    [recordResponseScope, recordResponseMessages],
    [activeRecordResponseScope, messages],
  );

  const finalMessages = stripRecoveryNoticeForUpstream(messages);
  prepared.messages = finalMessages;

  return {
    payload: prepared,
    originalModel,
    upstreamModel,
    cacheNamespace,
    patchedReasoningMessages: patchedCount,
    missingReasoningMessages: missingIndexes.length,
    recoveredReasoningMessages: recoveredCount,
    recoveryDroppedMessages,
    recoveryNotice,
    recordResponseScope,
    recordResponseMessages,
    recordResponseContexts,
    reasoningDiagnostics,
    recoverySteps,
    continuedRecoveryBoundary,
    retiredPrefixMessages,
  };
}

export function recordResponseReasoning(
  responsePayload: Record<string, unknown>,
  store: ReasoningStore | null,
  requestMessages: ChatMessage[],
  cacheNamespace = "",
  scope?: string,
  priorMessages?: ChatMessage[],
  recordingContexts?: [string, ChatMessage[]][],
): number {
  if (!store) return 0;
  const choices = responsePayload.choices as unknown[];
  if (!Array.isArray(choices)) return 0;

  const contexts = recordingContexts ?? [
    [
      scope ?? conversationScope(requestMessages, cacheNamespace),
      priorMessages ?? requestMessages,
    ] as [string, ChatMessage[]],
  ];

  let stored = 0;
  for (const choice of choices) {
    if (typeof choice !== "object" || choice === null) continue;
    const message = (choice as Record<string, unknown>).message as ChatMessage | undefined;
    if (!message) continue;
    for (const [ctxScope, ctxPrior] of contexts) {
      stored += store.storeAssistantMessage(message, ctxScope, cacheNamespace, ctxPrior);
    }
  }
  return stored;
}

export function rewriteResponseBody(
  body: Uint8Array,
  originalModel: string,
  store: ReasoningStore | null,
  requestMessages: ChatMessage[],
  cacheNamespace = "",
  contentPrefix?: string | null,
  scope?: string | null,
  priorMessages?: ChatMessage[],
  recordingContexts?: [string, ChatMessage[]][],
  displayReasoning = false,
  collapsibleReasoning = true,
): Uint8Array {
  const responsePayload = JSON.parse(new TextDecoder().decode(body)) as Record<string, unknown>;

  if (contentPrefix) {
    prefixResponseContent(responsePayload, contentPrefix);
  }

  recordResponseReasoning(
    responsePayload,
    store,
    requestMessages,
    cacheNamespace,
    scope ?? undefined,
    priorMessages,
    recordingContexts,
  );

  if (displayReasoning) {
    foldReasoningIntoContent(responsePayload, collapsibleReasoning);
  }

  if ("model" in responsePayload) {
    responsePayload.model = originalModel;
  }

  return new TextEncoder().encode(JSON.stringify(responsePayload));
}

function prefixResponseContent(payload: Record<string, unknown>, prefix: string): boolean {
  const choices = payload.choices as unknown[];
  if (!Array.isArray(choices)) return false;
  for (const choice of choices) {
    if (typeof choice !== "object" || choice === null) continue;
    const msg = (choice as Record<string, unknown>).message as Record<string, unknown> | undefined;
    if (!msg) continue;
    const content = msg.content;
    msg.content = prefix + (typeof content === "string" ? content : "");
    return true;
  }
  return false;
}
