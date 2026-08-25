/**
 * Pi Cursor Provider Extension
 *
 * Routes Pi model requests through the Cursor Agent CLI (`agent`) so that any
 * active Cursor subscription can be used from inside Pi.
 *
 * Authentication is handled by the CLI itself — run `agent login` (or set the
 * CURSOR_API_KEY environment variable) before using this provider.
 *
 * Usage:
 *   pi install npm:@netandreus/pi-cursor-provider
 *   # Then /model cursor/<model-id>, e.g. /model cursor/claude-opus-4-8
 *
 * Configuration env vars:
 *   CURSOR_AGENT_PATH   Path to the Cursor Agent CLI binary (default: "agent")
 *   CURSOR_API_KEY      API key for Cursor (used by the agent subprocess if set)
 *   CURSOR_AGENT_FORCE  Set to "0" to disable --force (Run Everything) in print mode
 */

import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type {
  Api,
  AssistantMessage,
  AssistantMessageEventStream,
  Context,
  ImageContent,
  Model,
  SimpleStreamOptions,
  TextContent,
} from "@mariozechner/pi-ai";
import { createAssistantMessageEventStream } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

// ---------------------------------------------------------------------------
// Model definitions
// ---------------------------------------------------------------------------

interface CursorModelDef {
  id: string;
  name: string;
  reasoning: boolean;
  contextWindow: number;
  maxTokens: number;
}

interface ParsedCursorModelId {
  family: string;
  effort?: string;
  thinking: boolean;
  fast: boolean;
}

type ReasoningLevel = "minimal" | "low" | "medium" | "high" | "xhigh";

const EFFORT_SUFFIXES = [
  "extra-high",
  "xhigh",
  "minimal",
  "medium",
  "none",
  "low",
  "high",
  "max",
] as const;

/** Literal apiKey so Pi 0.77+ shows models without CURSOR_API_KEY. Never sent on the wire. */
const CURSOR_CLI_PLACEHOLDER_API_KEY = "cursor-cli";

/**
 * Static fallback list. Used when `agent models` fails or times out, and as
 * an attribute lookup table for models discovered dynamically.
 *
 * One default variant per family. Source: `agent models` (Cursor Agent CLI
 * v2026.08.11-e8db854).
 */
const STATIC_MODELS: CursorModelDef[] = [
  { id: "auto", name: "Auto", reasoning: false, contextWindow: 200000, maxTokens: 32768 },
  { id: "composer-2.5", name: "Composer 2.5", reasoning: false, contextWindow: 200000, maxTokens: 32768 },
  { id: "claude-opus-4-8-medium", name: "Claude Opus 4.8 1M Medium", reasoning: true, contextWindow: 1000000, maxTokens: 65536 },
  { id: "claude-opus-5-medium", name: "Claude Opus 5 1M Medium", reasoning: true, contextWindow: 1000000, maxTokens: 65536 },
  { id: "claude-sonnet-5-medium", name: "Claude Sonnet 5 1M Medium", reasoning: true, contextWindow: 1000000, maxTokens: 65536 },
  { id: "claude-fable-5-medium", name: "Claude Fable 5 1M Medium", reasoning: true, contextWindow: 1000000, maxTokens: 65536 },
  { id: "claude-opus-4-7-medium", name: "Claude Opus 4.7 1M Medium", reasoning: true, contextWindow: 1000000, maxTokens: 65536 },
  { id: "claude-4.6-opus-high", name: "Claude Opus 4.6 1M", reasoning: true, contextWindow: 1000000, maxTokens: 65536 },
  { id: "claude-4.6-sonnet-medium", name: "Claude Sonnet 4.6 1M", reasoning: true, contextWindow: 1000000, maxTokens: 65536 },
  { id: "claude-4.5-opus-high", name: "Claude Opus 4.5", reasoning: true, contextWindow: 200000, maxTokens: 32768 },
  { id: "claude-4.5-sonnet", name: "Claude Sonnet 4.5", reasoning: true, contextWindow: 200000, maxTokens: 32768 },
  { id: "claude-4-sonnet", name: "Claude Sonnet 4", reasoning: true, contextWindow: 200000, maxTokens: 32768 },
  { id: "gpt-5.6-sol-medium", name: "GPT-5.6 Sol 1M", reasoning: true, contextWindow: 1000000, maxTokens: 65536 },
  { id: "gpt-5.6-luna-medium", name: "GPT-5.6 Luna 1M", reasoning: true, contextWindow: 1000000, maxTokens: 65536 },
  { id: "gpt-5.6-terra-medium", name: "GPT-5.6 Terra 1M", reasoning: true, contextWindow: 1000000, maxTokens: 65536 },
  { id: "gpt-5.5-medium", name: "GPT-5.5 1M", reasoning: true, contextWindow: 1000000, maxTokens: 65536 },
  { id: "gpt-5.4-medium", name: "GPT-5.4 1M", reasoning: true, contextWindow: 1000000, maxTokens: 65536 },
  { id: "gpt-5.4-mini-medium", name: "GPT-5.4 Mini", reasoning: true, contextWindow: 200000, maxTokens: 32768 },
  { id: "gpt-5.4-nano-medium", name: "GPT-5.4 Nano", reasoning: true, contextWindow: 200000, maxTokens: 32768 },
  { id: "gpt-5.3-codex", name: "Codex 5.3", reasoning: true, contextWindow: 200000, maxTokens: 32768 },
  { id: "gpt-5.2", name: "GPT-5.2", reasoning: true, contextWindow: 200000, maxTokens: 32768 },
  { id: "gpt-5.1", name: "GPT-5.1", reasoning: true, contextWindow: 200000, maxTokens: 32768 },
  { id: "gpt-5-mini", name: "GPT-5 Mini", reasoning: false, contextWindow: 200000, maxTokens: 32768 },
  { id: "cursor-grok-4.6-medium", name: "Cursor Grok 4.6 Medium", reasoning: true, contextWindow: 200000, maxTokens: 32768 },
  { id: "cursor-grok-4.5-medium", name: "Cursor Grok 4.5 Medium", reasoning: true, contextWindow: 200000, maxTokens: 32768 },
  { id: "gemini-3.7-flash-medium", name: "Gemini 3.7 Flash Medium", reasoning: true, contextWindow: 1000000, maxTokens: 65536 },
  { id: "gemini-3.6-flash-medium", name: "Gemini 3.6 Flash Medium", reasoning: true, contextWindow: 1000000, maxTokens: 65536 },
  { id: "gemini-3.5-flash", name: "Gemini 3.5 Flash", reasoning: false, contextWindow: 1000000, maxTokens: 65536 },
  { id: "gemini-3.1-pro", name: "Gemini 3.1 Pro", reasoning: false, contextWindow: 1000000, maxTokens: 65536 },
  { id: "gemini-3-flash", name: "Gemini 3 Flash", reasoning: false, contextWindow: 1000000, maxTokens: 65536 },
  { id: "glm-5.2-high", name: "GLM 5.2", reasoning: true, contextWindow: 200000, maxTokens: 32768 },
  { id: "kimi-k3-high", name: "Kimi K3 High", reasoning: true, contextWindow: 200000, maxTokens: 32768 },
  { id: "kimi-k2.7-code", name: "Kimi K2.7 Code", reasoning: false, contextWindow: 200000, maxTokens: 32768 },
];

/** Old Pi / CLI ids → current family id. */
const COMPAT_CANONICAL: Record<string, string> = {
  "claude-sonnet-4-5": "claude-4.5-sonnet",
  "claude-sonnet-4-6": "claude-4.6-sonnet",
  "claude-opus-4-5": "claude-4.5-opus",
  "claude-opus-4-6": "claude-4.6-opus",
  "sonnet-4.5": "claude-4.5-sonnet",
  "sonnet-4.6": "claude-4.6-sonnet",
  "opus-4.5": "claude-4.5-opus",
  "opus-4.6": "claude-4.6-opus",
  "gemini-3-pro-preview": "gemini-3.1-pro",
  "gemini-3-flash-preview": "gemini-3-flash",
  "grok-code-fast-1": "cursor-grok-4.6",
  grok: "cursor-grok-4.6",
  "composer-1": "composer-2.5",
  "composer-1.5": "composer-2.5",
  "gpt-5.2-codex": "gpt-5.3-codex",
  "gpt-5.2-codex-fast": "gpt-5.3-codex",
  "gpt-5.1-codex-max": "gpt-5.3-codex",
};

const STATIC_MODELS_MAP = new Map<string, CursorModelDef>();
for (const m of STATIC_MODELS) {
  STATIC_MODELS_MAP.set(m.id, m);
  STATIC_MODELS_MAP.set(parseCursorModelId(m.id).family, m);
}

/** Discovered CLI variants grouped by family. Filled by indexModelDefs(). */
const familyVariants = new Map<string, CursorModelDef[]>();

function stripModelParams(id: string): string {
  const bracket = id.indexOf("[");
  return bracket >= 0 ? id.slice(0, bracket) : id;
}

function parseCursorModelId(id: string): ParsedCursorModelId {
  let rest = stripModelParams(id);
  let fast = false;
  let thinking = false;
  let effort: string | undefined;

  if (rest.endsWith("-fast")) {
    fast = true;
    rest = rest.slice(0, -5);
  }
  if (rest.endsWith("-thinking")) {
    thinking = true;
    rest = rest.slice(0, -9);
  }
  for (const suffix of EFFORT_SUFFIXES) {
    const token = `-${suffix}`;
    if (rest.endsWith(token)) {
      effort = suffix;
      rest = rest.slice(0, -token.length);
      break;
    }
  }
  if (rest.endsWith("-thinking")) {
    thinking = true;
    rest = rest.slice(0, -9);
  }

  return { family: rest, effort, thinking, fast };
}

function resolveFamily(modelId: string): string {
  const raw = stripModelParams(modelId);
  if (COMPAT_CANONICAL[raw]) return COMPAT_CANONICAL[raw];
  const family = parseCursorModelId(raw).family;
  return COMPAT_CANONICAL[family] ?? family;
}

function reasoningToEffort(level?: string): string | undefined {
  switch (level as ReasoningLevel | undefined) {
    case "minimal":
      return "low";
    case "low":
      return "low";
    case "medium":
      return "medium";
    case "high":
      return "high";
    case "xhigh":
      return "xhigh";
    default:
      return undefined;
  }
}

function pickVariant(family: string, reasoning?: string): string {
  const defs = familyVariants.get(family) ?? [];
  const wantThinking = Boolean(reasoning);
  const wantEffort = reasoningToEffort(reasoning);
  const familyHasThinking = defs.some((d) => parseCursorModelId(d.id).thinking);

  if (defs.length === 0) {
    if (wantEffort) return `${family}[effort=${wantEffort}]`;
    return family;
  }

  let bestId = defs[0].id;
  let bestScore = Number.NEGATIVE_INFINITY;

  for (const def of defs) {
    const parsed = parseCursorModelId(def.id);
    let score = 0;
    if (parsed.fast) score -= 100;
    if (familyHasThinking && wantThinking) {
      score += parsed.thinking ? 50 : -50;
    } else if (parsed.thinking) {
      score -= 50;
    }
    if (wantEffort) {
      if (parsed.effort === wantEffort) score += 40;
      else if (wantEffort === "xhigh" && (parsed.effort === "extra-high" || parsed.effort === "max"))
        score += 30;
      else if (wantEffort === "low" && (parsed.effort === "none" || parsed.effort === "minimal"))
        score += 20;
      else if (parsed.effort == null && wantEffort === "medium") score += 25;
    } else if (def.id === family || parsed.effort == null) {
      score += 40;
    } else if (parsed.effort === "medium") {
      score += 30;
    } else if (parsed.effort === "high") {
      score += 20;
    } else if (parsed.effort === "max") {
      score += 10;
    }
    if (score > bestScore) {
      bestScore = score;
      bestId = def.id;
    }
  }

  return bestId;
}

function toCursorId(canonicalId: string, reasoning?: string): string {
  return pickVariant(resolveFamily(canonicalId), reasoning);
}

function inferReasoning(id: string): boolean {
  return /(-thinking|-high|-xhigh|-extra-high|-max-high|-max)$/.test(id);
}

function inferAttrs(id: string, name: string): Pick<CursorModelDef, "reasoning" | "contextWindow" | "maxTokens"> {
  const family = parseCursorModelId(id).family;
  const known = STATIC_MODELS_MAP.get(id) ?? STATIC_MODELS_MAP.get(family);
  if (known) {
    return {
      reasoning: known.reasoning,
      contextWindow: known.contextWindow,
      maxTokens: known.maxTokens,
    };
  }
  const oneM = /1M|\b1m\b/i.test(name) || /^gemini/i.test(id);
  return {
    reasoning: inferReasoning(id),
    contextWindow: oneM ? 1_000_000 : 200_000,
    maxTokens: oneM ? 65_536 : 32_768,
  };
}

function familyDisplayName(name: string): string {
  return name
    .replace(/\s+\(NO ZDR\)$/i, "")
    .replace(/\s+(None|Minimal|Low|Medium|High|Extra High|Max)(\s+Fast)?$/i, "")
    .replace(/\s+Fast$/i, "")
    .trim();
}

function indexModelDefs(defs: CursorModelDef[]): void {
  familyVariants.clear();
  for (const def of defs) {
    const family = resolveFamily(def.id);
    const list = familyVariants.get(family) ?? [];
    list.push(def);
    familyVariants.set(family, list);
  }
}

// ---------------------------------------------------------------------------
// Dynamic model discovery via `agent models`
// ---------------------------------------------------------------------------

const DISCOVERY_TIMEOUT_MS = 15_000;

function parseAgentModelsOutput(output: string): CursorModelDef[] {
  const results: CursorModelDef[] = [];
  const lineRe =
    /^([a-zA-Z0-9][a-zA-Z0-9._-]*)\s+-\s+(.+?)(?:\s+\((?:current|default|current,\s*default)\))?$/;

  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("Available") || trimmed.startsWith("Tip:")) continue;
    const match = lineRe.exec(trimmed);
    if (!match) continue;

    const id = match[1].trim();
    const rawName = match[2].trim();
    const attrs = inferAttrs(id, rawName);
    results.push({
      id,
      name: rawName,
      reasoning: attrs.reasoning,
      contextWindow: attrs.contextWindow,
      maxTokens: attrs.maxTokens,
    });
  }
  return results;
}

function runAgentModels(agentPath: string): Promise<CursorModelDef[]> {
  return new Promise((resolve, reject) => {
    const args = ["models"];
    if (process.env["CURSOR_API_KEY"]) {
      args.unshift("--api-key", process.env["CURSOR_API_KEY"]);
    }

    let stdout = "";
    let stderr = "";
    const child = spawn(agentPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });

    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`agent models timed out after ${DISCOVERY_TIMEOUT_MS}ms`));
    }, DISCOVERY_TIMEOUT_MS);

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });

    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new Error(`agent models exited with code ${code}: ${stderr.trim()}`));
        return;
      }
      const models = parseAgentModelsOutput(stdout);
      if (models.length === 0) {
        reject(new Error("agent models returned no models"));
        return;
      }
      resolve(models);
    });
  });
}

// ---------------------------------------------------------------------------
// Prompt serialisation
// Prompt is delivered on stdin (not argv): a single Linux argv cannot exceed
// MAX_ARG_STRLEN (131072), and long Pi sessions hit that during compaction.
// Images are written to temp files; the CLI reads them via those paths.
// ---------------------------------------------------------------------------

const MIME_TYPE_TO_EXTENSION: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/svg+xml": "svg",
  "image/bmp": "bmp",
  "image/tiff": "tiff",
};

interface PromptTempFiles {
  dir: string | null;
  imageCount: number;
}

interface ImageBlock {
  type: "image";
  mimeType: string;
  data?: string;
  path?: string;
}

function spawnAgentPrint(agentPath: string, args: string[], prompt: string): ChildProcess {
  const child = spawn(agentPath, args, {
    stdio: ["pipe", "pipe", "pipe"],
    env: process.env,
  });
  child.stdin?.on("error", () => {});
  child.stdin?.end(prompt, "utf8");
  return child;
}

function stripDataUrlPrefix(data: string): string {
  return data.replace(/^data:[^;]+;base64,/, "").replace(/\s+/g, "");
}

function getImageExtension(mimeType: string): string {
  return MIME_TYPE_TO_EXTENSION[mimeType] ?? "bin";
}

async function ensurePromptTempDir(state: PromptTempFiles): Promise<string> {
  if (state.dir) return state.dir;
  state.dir = await mkdtemp(join(tmpdir(), "pi-cursor-provider-"));
  return state.dir;
}

async function cleanupPromptTempFiles(state: PromptTempFiles): Promise<void> {
  if (!state.dir) return;
  const dir = state.dir;
  state.dir = null;
  await rm(dir, { recursive: true, force: true });
}

async function imageBlockToPromptText(block: ImageBlock, state: PromptTempFiles): Promise<string> {
  if (block.path) return block.path;
  const data = block.data;
  if (!data) {
    return `[Image: ${block.mimeType} — no image data was provided]`;
  }
  const dir = await ensurePromptTempDir(state);
  state.imageCount += 1;
  const path = join(dir, `image-${state.imageCount}.${getImageExtension(block.mimeType)}`);
  await writeFile(path, Buffer.from(stripDataUrlPrefix(data), "base64"));
  return path;
}

async function contentBlockToText(
  block: TextContent | ImageContent,
  state: PromptTempFiles,
): Promise<string> {
  if (block.type === "text") return block.text;
  return imageBlockToPromptText(block as ImageBlock, state);
}

async function serializeContentBlocks(
  blocks: (TextContent | ImageContent)[],
  state: PromptTempFiles,
): Promise<string> {
  const parts: string[] = [];
  for (const block of blocks) {
    parts.push(await contentBlockToText(block, state));
  }
  return parts.join("\n");
}

async function serializeContext(context: Context, state: PromptTempFiles): Promise<string> {
  const lines: string[] = [];

  if (context.systemPrompt) {
    lines.push(`[System]\n${context.systemPrompt}\n`);
  }

  for (const msg of context.messages) {
    if (msg.role === "user") {
      const text =
        typeof msg.content === "string"
          ? msg.content
          : await serializeContentBlocks(msg.content, state);
      lines.push(`[User]\n${text}`);
    } else if (msg.role === "assistant") {
      const text = msg.content
        .filter((c): c is TextContent => c.type === "text")
        .map((c) => c.text)
        .join("\n");
      if (text.trim()) {
        lines.push(`[Assistant]\n${text}`);
      }
    } else if (msg.role === "toolResult") {
      const text = await serializeContentBlocks(msg.content, state);
      if (text.trim()) {
        lines.push(`[Tool result: ${msg.toolName}]\n${text}`);
      }
    }
  }

  return lines.join("\n\n");
}

// ---------------------------------------------------------------------------
// NDJSON event types — Cursor CLI stream-json shape
// ---------------------------------------------------------------------------

interface CursorAssistantEvent {
  type: "assistant";
  message: { role: "assistant"; content: Array<{ type: "text"; text: string }> };
  session_id: string;
  timestamp_ms?: number;
  model_call_id?: string;
}

interface CursorToolCallPayload {
  args?: Record<string, unknown>;
  name?: string;
  arguments?: string;
  result?: {
    success?: Record<string, unknown>;
    rejected?: { reason?: string };
    error?: { message?: string };
  };
}

interface CursorToolCallEvent {
  type: "tool_call";
  subtype: "started" | "completed";
  tool_call: Record<string, CursorToolCallPayload>;
}

interface CursorResultEvent {
  type: "result";
  subtype: string;
  duration_ms: number;
}

type CursorStreamEvent =
  | CursorAssistantEvent
  | CursorToolCallEvent
  | CursorResultEvent
  | { type: string };

function parseLine(line: string): CursorStreamEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as CursorStreamEvent;
  } catch {
    return null;
  }
}

/**
 * With --stream-partial-output, only timestamped deltas without model_call_id
 * contain new text. Buffered flushes are duplicates and must be skipped.
 * Aggregated mode (no partial flag) emits one unique assistant event per segment.
 */
function isNewAssistantDelta(event: CursorAssistantEvent): boolean {
  const hasTs = typeof event.timestamp_ms === "number";
  const hasMc = typeof event.model_call_id === "string" && event.model_call_id.length > 0;
  if (hasTs || hasMc) return hasTs && !hasMc;
  return true;
}

// ---------------------------------------------------------------------------
// Tool name mapping — CLI camelCase key → Pi display name
// ---------------------------------------------------------------------------

const TOOL_NAME_MAP: Record<string, string> = {
  shellToolCall: "Shell",
  readToolCall: "Read",
  editToolCall: "Edit",
  writeToolCall: "Write",
  deleteToolCall: "Delete",
  grepToolCall: "Grep",
  globToolCall: "Glob",
  lsToolCall: "Ls",
  todoToolCall: "Todo",
  updateTodosToolCall: "UpdateTodos",
  findToolCall: "Find",
  webFetchToolCall: "WebFetch",
  webSearchToolCall: "WebSearch",
  taskToolCall: "Task",
  generateImageToolCall: "GenerateImage",
};

function toPiToolName(cliKey: string): string {
  return TOOL_NAME_MAP[cliKey] ?? cliKey.replace(/ToolCall$/, "");
}

function describeToolCall(event: CursorToolCallEvent): { name: string; argsSnippet: string } | null {
  const cliKey = Object.keys(event.tool_call)[0];
  if (!cliKey) return null;
  const payload = event.tool_call[cliKey];
  if (cliKey === "function") {
    const name = payload.name ?? "Function";
    const raw = payload.arguments ?? JSON.stringify(payload.args ?? {});
    const argsSnippet = raw.length > 120 ? `${raw.slice(0, 120)}…` : raw;
    return { name, argsSnippet };
  }
  const argsSnippet = JSON.stringify(payload.args ?? {});
  const brief = argsSnippet.length > 120 ? `${argsSnippet.slice(0, 120)}…` : argsSnippet;
  return { name: toPiToolName(cliKey), argsSnippet: brief };
}

// ---------------------------------------------------------------------------
// streamSimple — the custom backend for the cursor provider
// ---------------------------------------------------------------------------

function streamCursorCli(
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();

  (async () => {
    const startTime = Date.now();
    let firstTokenTime: number | undefined;

    const output: AssistantMessage & { duration?: number; ttft?: number } = {
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    };

    const setTiming = () => {
      output.duration = Date.now() - startTime;
      output.ttft = firstTokenTime != null ? firstTokenTime - startTime : undefined;
    };

    const promptTempFiles: PromptTempFiles = { dir: null, imageCount: 0 };

    try {
      const agentPath =
        process.env["CURSOR_AGENT_PATH"] ?? process.env["AGENT_PATH"] ?? "agent";

      const workspacePath = process.cwd();
      const prompt = await serializeContext(context, promptTempFiles);
      const reasoningLevel = (options as { reasoning?: string })?.reasoning;
      const cliModelId = toCursorId(model.id, reasoningLevel);

      const args = [
        "--print",
        "--output-format",
        "stream-json",
        "--stream-partial-output",
        "--model",
        cliModelId,
        "--trust",
        "--workspace",
        workspacePath,
        "--approve-mcps",
      ];

      if (process.env["CURSOR_AGENT_FORCE"] !== "0") {
        args.push("--force");
      }

      if (process.env["CURSOR_API_KEY"]) {
        args.unshift("--api-key", process.env["CURSOR_API_KEY"]);
      }

      stream.push({ type: "start", partial: output });

      const child = spawnAgentPrint(agentPath, args, prompt);

      const onAbort = () => {
        child.kill("SIGTERM");
      };
      options?.signal?.addEventListener("abort", onAbort, { once: true });

      const stderrChunks: string[] = [];
      child.stderr?.on("data", (chunk: Buffer) => {
        stderrChunks.push(chunk.toString());
      });

      let textBlockOpen = false;
      let accumulatedText = "";

      const appendText = (delta: string) => {
        if (!delta) return;
        if (firstTokenTime === undefined) firstTokenTime = Date.now();
        if (!textBlockOpen) {
          output.content.push({ type: "text", text: "" });
          const idx = output.content.length - 1;
          stream.push({ type: "text_start", contentIndex: idx, partial: output });
          textBlockOpen = true;
        }
        const idx = output.content.length - 1;
        const textBlock = output.content[idx] as TextContent;
        textBlock.text += delta;
        accumulatedText += delta;
        stream.push({ type: "text_delta", contentIndex: idx, delta, partial: output });
      };

      const rl = createInterface({ input: child.stdout!, crlfDelay: Infinity });

      rl.on("line", (line: string) => {
        const event = parseLine(line);
        if (!event) return;

        if (event.type === "assistant") {
          const ae = event as CursorAssistantEvent;
          if (!isNewAssistantDelta(ae)) return;
          for (const block of ae.message.content) {
            if (block.type !== "text") continue;
            appendText(block.text);
          }
          return;
        }

        if (event.type === "tool_call") {
          const tce = event as CursorToolCallEvent;
          if (tce.subtype !== "started") return;
          const described = describeToolCall(tce);
          if (!described) return;
          appendText(`\n⏳ [${described.name}] ${described.argsSnippet}\n`);
        }
      });

      await new Promise<void>((resolve) => {
        child.on("close", (code) => {
          options?.signal?.removeEventListener("abort", onAbort);

          if (textBlockOpen) {
            const idx = output.content.length - 1;
            stream.push({
              type: "text_end",
              contentIndex: idx,
              content: accumulatedText,
              partial: output,
            });
            textBlockOpen = false;
          }

          if (options?.signal?.aborted) {
            output.stopReason = "aborted";
            setTiming();
            stream.push({ type: "error", reason: "aborted", error: output });
            stream.end();
            resolve();
            return;
          }

          if (code !== 0 && !accumulatedText) {
            const stderr = stderrChunks.join("").trim();
            output.stopReason = "error";
            output.errorMessage = stderr || `Cursor CLI exited with code ${code}`;
            setTiming();
            stream.push({ type: "error", reason: "error", error: output });
            stream.end();
            resolve();
            return;
          }

          setTiming();
          stream.push({ type: "done", reason: "stop", message: output });
          stream.end();
          resolve();
        });

        child.on("error", (err) => {
          options?.signal?.removeEventListener("abort", onAbort);
          output.stopReason = "error";
          output.errorMessage = err.message;
          setTiming();
          stream.push({ type: "error", reason: "error", error: output });
          stream.end();
          resolve();
        });
      });
    } catch (error) {
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      output.errorMessage = error instanceof Error ? error.message : String(error);
      setTiming();
      stream.push({ type: "error", reason: output.stopReason, error: output });
      stream.end();
    } finally {
      await cleanupPromptTempFiles(promptTempFiles);
    }
  })();

  return stream;
}

// ---------------------------------------------------------------------------
// Auth helpers
// ---------------------------------------------------------------------------

function runAgentLogin(agentPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const args: string[] = ["login"];
    const env = { ...process.env, NO_OPEN_BROWSER: "1" };

    const child = spawn(agentPath, args, {
      stdio: "inherit",
      env,
    });

    child.on("error", (err) => reject(err));
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`agent login exited with code ${code}`));
    });
  });
}

function runAgentStatus(agentPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let out = "";
    const child = spawn(agentPath, ["status"], {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    child.stdout?.on("data", (c: Buffer) => {
      out += c.toString();
    });
    child.stderr?.on("data", (c: Buffer) => {
      out += c.toString();
    });
    child.on("error", (err) => reject(err));
    child.on("close", () => resolve(out.trim()));
  });
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

function toProviderModels(defs: CursorModelDef[]) {
  indexModelDefs(defs);
  const seen = new Set<string>();
  const models: Array<{
    id: string;
    name: string;
    reasoning: boolean;
    input: ("text" | "image")[];
    cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
    contextWindow: number;
    maxTokens: number;
  }> = [];

  for (const [family, variants] of familyVariants) {
    if (seen.has(family)) continue;
    seen.add(family);

    const defaultId = pickVariant(family);
    const defaultDef = variants.find((v) => v.id === defaultId) ?? variants[0];
    const hasThinking = variants.some((v) => parseCursorModelId(v.id).thinking);
    const effortCount = new Set(
      variants.map((v) => parseCursorModelId(v.id).effort).filter(Boolean),
    ).size;
    const attrs = inferAttrs(defaultDef.id, defaultDef.name);

    models.push({
      id: family,
      name: `${familyDisplayName(defaultDef.name)} (Cursor)`,
      reasoning: hasThinking || effortCount > 1 || attrs.reasoning,
      input: ["text", "image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: attrs.contextWindow,
      maxTokens: attrs.maxTokens,
    });
  }

  return models;
}

export default async function (pi: ExtensionAPI) {
  const agentPath =
    process.env["CURSOR_AGENT_PATH"] ?? process.env["AGENT_PATH"] ?? "agent";

  let modelDefs: CursorModelDef[];
  try {
    modelDefs = await runAgentModels(agentPath);
  } catch {
    modelDefs = STATIC_MODELS;
  }

  pi.registerProvider("cursor", {
    baseUrl: "cli://cursor-agent",
    // Auth is handled by the Cursor CLI (`agent login` or CURSOR_API_KEY).
    // A literal non-empty value is required so Pi 0.77+ considers the
    // provider authenticated. This value is never sent on the wire.
    apiKey: CURSOR_CLI_PLACEHOLDER_API_KEY,
    oauth: {
      name: "Cursor CLI",
      async login() {
        throw new Error("Authenticate with Cursor using `agent login` or /cursor-login");
      },
      async refreshToken(credentials) {
        return { ...credentials, expires: Number.MAX_SAFE_INTEGER };
      },
      getApiKey() {
        return CURSOR_CLI_PLACEHOLDER_API_KEY;
      },
    },
    api: "cursor-cli" as Api,
    models: toProviderModels(modelDefs),
    streamSimple: streamCursorCli,
  });

  pi.registerCommand("cursor-login", {
    description: "Log in to Cursor (runs `agent login`)",
    handler: async (_args, ctx) => {
      ctx.ui.notify(
        "Starting Cursor login (NO_OPEN_BROWSER=1 — copy the URL from the output)…",
        "info",
      );
      try {
        await runAgentLogin(agentPath);
        ctx.ui.notify("Cursor login successful.", "info");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.ui.notify(`Cursor login failed: ${msg}`, "error");
      }
    },
  });

  pi.registerCommand("cursor-status", {
    description: "Show Cursor authentication status (runs `agent status`)",
    handler: async (_args, ctx) => {
      try {
        const status = await runAgentStatus(agentPath);
        ctx.ui.notify(status || "No output from `agent status`.", "info");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.ui.notify(`Could not get Cursor status: ${msg}`, "error");
      }
    },
  });

  pi.registerCommand("cursor-logout", {
    description: "Log out of Cursor (runs `agent logout`)",
    handler: async (_args, ctx) => {
      try {
        await new Promise<void>((resolve, reject) => {
          const child = spawn(agentPath, ["logout"], {
            stdio: "inherit",
            env: process.env,
          });
          child.on("error", reject);
          child.on("close", (code) => {
            if (code === 0) resolve();
            else reject(new Error(`agent logout exited with code ${code}`));
          });
        });
        ctx.ui.notify("Logged out of Cursor.", "info");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.ui.notify(`Cursor logout failed: ${msg}`, "error");
      }
    },
  });
}
