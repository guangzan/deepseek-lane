import { z } from "zod";

export const ToolCallSchema = z.object({
  id: z.string().optional(),
  type: z.string().optional(),
  function: z.object({
    name: z.string(),
    arguments: z.string(),
  }),
});

export const ChatMessageSchema = z.object({
  role: z.string(),
  content: z.string().nullable().optional(),
  name: z.string().optional(),
  tool_call_id: z.string().optional(),
  tool_calls: z.array(ToolCallSchema).optional(),
  reasoning_content: z.string().nullable().optional(),
  prefix: z.string().optional(),
});

export const ToolDefinitionSchema = z.object({
  type: z.string().optional(),
  function: z.object({
    name: z.string(),
    description: z.string().optional(),
    parameters: z.record(z.string(), z.unknown()).optional(),
  }),
});

export const ChatCompletionRequestSchema = z.object({
  model: z.string().optional(),
  messages: z.array(ChatMessageSchema),
  stream: z.boolean().optional(),
  stream_options: z.object({ include_usage: z.boolean().optional() }).optional(),
  max_tokens: z.number().optional(),
  max_completion_tokens: z.number().optional(),
  response_format: z.unknown().optional(),
  stop: z.union([z.string(), z.array(z.string())]).optional(),
  tools: z.array(ToolDefinitionSchema).optional(),
  tool_choice: z.union([z.string(), z.record(z.string(), z.unknown())]).optional(),
  functions: z.array(ToolDefinitionSchema).optional(),
  function_call: z.union([z.string(), z.object({ name: z.string() })]).optional(),
  thinking: z.object({ type: z.string() }).optional(),
  reasoning_effort: z.string().optional(),
  temperature: z.number().optional(),
  top_p: z.number().optional(),
  presence_penalty: z.number().optional(),
  frequency_penalty: z.number().optional(),
  logprobs: z.boolean().optional(),
  top_logprobs: z.number().optional(),
  user: z.string().optional(),
  seed: z.number().optional(),
  n: z.number().optional(),
  logit_bias: z.record(z.string(), z.number()).optional(),
});

export const DeltaChoiceSchema = z.object({
  index: z.number(),
  delta: z.object({
    role: z.string().optional(),
    content: z.string().optional(),
    reasoning_content: z.string().optional(),
    tool_calls: z
      .array(
        z.object({
          index: z.number().optional(),
          id: z.string().optional(),
          type: z.string().optional(),
          function: z
            .object({
              name: z.string().optional(),
              arguments: z.string().optional(),
            })
            .optional(),
        }),
      )
      .optional(),
  }),
  finish_reason: z.string().nullable().optional(),
  logprobs: z.unknown().optional(),
});

export const ChatUsageSchema = z.object({
  prompt_tokens: z.number().optional(),
  completion_tokens: z.number().optional(),
  total_tokens: z.number().optional(),
  prompt_cache_hit_tokens: z.number().optional(),
  prompt_cache_miss_tokens: z.number().optional(),
  completion_tokens_details: z
    .object({
      reasoning_tokens: z.number().optional(),
    })
    .optional(),
});

export const ThinkingEnum = z.enum(["enabled", "disabled"]);
export const ReasoningEffortEnum = z.enum(["low", "medium", "high", "max", "xhigh"]);
export const MissingReasoningStrategyEnum = z.enum(["recover", "reject"]);

export const ProxyConfigSchema = z.object({
  host: z.string().default("127.0.0.1"),
  port: z.coerce.number().int().default(19199),
  upstreamBaseUrl: z.string().default("https://opencode.ai/zen/go/v1"),
  upstreamModel: z.string().default("deepseek-v4-pro"),
  strictModelNames: z.coerce.boolean().default(false),
  thinking: ThinkingEnum.default("enabled"),
  reasoningEffort: ReasoningEffortEnum.default("medium"),
  requestTimeout: z.coerce.number().default(300),
  maxRequestBodyBytes: z.coerce
    .number()
    .int()
    .default(20 * 1024 * 1024),
  reasoningContentPath: z.string(),
  missingReasoningStrategy: MissingReasoningStrategyEnum.default("recover"),
  reasoningCacheMaxAgeSeconds: z.coerce
    .number()
    .int()
    .default(30 * 24 * 60 * 60),
  reasoningCacheMaxRows: z.coerce.number().int().default(100000),
  displayReasoning: z.coerce.boolean().default(true),
  collapsibleReasoning: z.coerce.boolean().default(true),
  ngrok: z.coerce.boolean().default(true),
  verbose: z.coerce.boolean().default(false),
});

export const CliArgsSchema = z.object({
  config: z.string().optional(),
  host: z.string().optional(),
  port: z.coerce.number().int().optional(),
  model: z.string().optional(),
  baseUrl: z.string().optional(),
  strictModelNames: z.coerce.boolean().optional(),
  thinking: z.string().optional(),
  reasoningEffort: z.string().optional(),
  ngrok: z.coerce.boolean().optional(),
  verbose: z.coerce.boolean().optional(),
  displayReasoning: z.coerce.boolean().optional(),
  collapsibleReasoning: z.coerce.boolean().optional(),
  requestTimeout: z.coerce.number().optional(),
  maxRequestBodyBytes: z.coerce.number().int().optional(),
  missingReasoningStrategy: z.string().optional(),
  noNgrok: z.coerce.boolean().optional(),
  noVerbose: z.coerce.boolean().optional(),
  noDisplayReasoning: z.coerce.boolean().optional(),
  noCollapsibleReasoning: z.coerce.boolean().optional(),
  clearReasoningCache: z.coerce.boolean().optional(),
});

export const ToolCallDeltaSchema = z.object({
  index: z.number().optional(),
  id: z.string().optional(),
  type: z.string().optional(),
  function: z
    .object({
      name: z.string().optional(),
      arguments: z.string().optional(),
    })
    .optional(),
});

export const ChatChoiceSchema = z.object({
  index: z.number(),
  finish_reason: z.string().nullable(),
  message: ChatMessageSchema,
  logprobs: z.unknown().optional(),
});

export const ChatCompletionResponseSchema = z.object({
  id: z.string(),
  object: z.string(),
  created: z.number(),
  model: z.string(),
  choices: z.array(ChatChoiceSchema),
  usage: ChatUsageSchema.optional(),
});

export const StreamChunkSchema = z.object({
  id: z.string(),
  object: z.string(),
  created: z.number(),
  model: z.string(),
  choices: z.array(DeltaChoiceSchema),
  usage: ChatUsageSchema.optional(),
});

export interface PreparedRequest {
  payload: Record<string, unknown>;
  originalModel: string;
  upstreamModel: string;
  cacheNamespace: string;
  patchedReasoningMessages: number;
  missingReasoningMessages: number;
  recoveredReasoningMessages: number;
  recoveryDroppedMessages: number;
  recoveryNotice: string | null;
  recordResponseScope: string | null;
  recordResponseMessages: ChatMessage[];
  recordResponseContexts: [string, ChatMessage[]][];
  reasoningDiagnostics: Record<string, unknown>[];
  recoverySteps: Record<string, unknown>[];
  continuedRecoveryBoundary: boolean;
  retiredPrefixMessages: number;
}

export interface ReasoningLookupKey {
  kind: string;
  key: string;
  portable: boolean;
  hit: boolean;
  [key: string]: unknown;
}

export type ToolCall = z.infer<typeof ToolCallSchema>;
export type ChatMessage = z.infer<typeof ChatMessageSchema>;
export type ToolDefinition = z.infer<typeof ToolDefinitionSchema>;
export type ChatCompletionRequest = z.infer<typeof ChatCompletionRequestSchema>;
export type DeltaChoice = z.infer<typeof DeltaChoiceSchema>;
export type ChatUsage = z.infer<typeof ChatUsageSchema>;
export type ProxyConfig = z.infer<typeof ProxyConfigSchema>;
export type CliArgs = z.infer<typeof CliArgsSchema>;
export type ToolCallDelta = z.infer<typeof ToolCallDeltaSchema>;
export type ChatChoice = z.infer<typeof ChatChoiceSchema>;
export type ChatCompletionResponse = z.infer<typeof ChatCompletionResponseSchema>;
export type StreamChunk = z.infer<typeof StreamChunkSchema>;
