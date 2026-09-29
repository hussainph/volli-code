/**
 * VC-445: grow a real Pi recovery sidecar to a chosen length, with no model.
 *
 * The Electron probe (`apps/desktop/e2e/pi-context-scaling-bench.mjs`) needs
 * Sessions whose Pi sidecars already hold 10 / 100 / 500 / 1,500 entries, so
 * that hydrating them in main has a known history to rebuild. Hand-writing that
 * JSONL would measure a shape the runtime never produces — the marker kinds,
 * their order, the transaction framing and the tool-result mass are all the
 * runtime's own decisions — so the history is produced the way a real Session
 * produces it: the real `createPiAgentRuntime`, re-attached to the very sidecar
 * the desktop app created, running real turns and real `read` tool calls.
 *
 * Only the provider is fake. pi-ai's own `fauxProvider` answers every request
 * from a script built here, wearing the catalog entry of the model the app
 * recorded for the Session (so every assistant message names the same
 * provider, model and API the app will rehydrate it under). It opens no socket.
 * The prose is generated from a fixed vocabulary by a seeded PRNG: no real
 * transcript text is read or reproduced.
 *
 * Nothing here ships. It is run by the bench's `prepare` phase in plain Node,
 * with the bench's network tripwire loaded, against a disposable profile.
 */

import { readFileSync } from "node:fs";

import {
  createModels,
  fauxProvider,
  fauxToolCall,
  type AssistantMessage,
  type Model,
  type TextContent,
  type ThinkingContent,
  type ToolCall,
} from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";

import { createPiAgentRuntime } from "../../src/index";
import type { ModelSelection, RuntimeRecoveryRef, SessionRuntimeSpec } from "@volli/shared";

/** One Session whose sidecar should grow. Ids come from the desktop ledger's own sidecar. */
export interface HistoryTarget {
  sessionId: string;
  rootThreadId: string;
  attachmentId: string;
  projectId: string;
  recovery: RuntimeRecoveryRef;
  /** Sidecar entries to reach (`kind: "entry"` records; header and value writes excluded). */
  targetEntries: number;
  seed: number;
}

export interface HistoryOptions {
  sessionDataDir: string;
  workspacePath: string;
  /** Workspace-relative files the scripted `read` calls open. */
  files: readonly string[];
  /** The Session's recorded selection. */
  model: ModelSelection;
  /** The catalog entry the desktop resolves that selection to, copied verbatim. */
  catalogModel: Model<string>;
  targets: readonly HistoryTarget[];
  onProgress?: (done: number, total: number, result: HistoryResult) => void;
}

export interface HistoryResult {
  sessionId: string;
  targetEntries: number;
  entries: number;
  messages: number;
  customEntries: number;
  turns: number;
  toolCalls: number;
  bytes: number;
  generationMs: number;
}

/**
 * The built-in catalog entry for a selection — the baseline the desktop's own
 * `piOwnedModels` resolves when no catalog refresh has run, which the bench's
 * network tripwire guarantees.
 */
export function builtinCatalogModel(providerId: string, modelId: string): Model<string> {
  const model = builtinModels().getModel(providerId, modelId);
  if (model === undefined) throw new Error(`${providerId}/${modelId} is not a built-in model`);
  return model as Model<string>;
}

// --- deterministic synthetic prose -----------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = [
  "fixture",
  "module",
  "projection",
  "ledger",
  "branch",
  "worktree",
  "schema",
  "cursor",
  "binding",
  "attachment",
  "renderer",
  "handler",
  "queue",
  "snapshot",
  "sidecar",
  "turn",
  "event",
  "reader",
  "writer",
  "session",
  "thread",
  "command",
  "receipt",
  "observer",
  "compaction",
  "boundary",
  "policy",
  "budget",
  "latency",
  "heap",
  "channel",
  "payload",
  "invariant",
  "migration",
  "listing",
  "roster",
  "column",
  "ticket",
  "project",
  "stream",
  "the",
  "a",
  "of",
  "to",
  "and",
  "in",
  "is",
  "that",
  "for",
  "with",
  "when",
  "then",
  "this",
  "check",
  "update",
  "compare",
  "rename",
  "extract",
  "measure",
  "replay",
  "verify",
  "keep",
];

function prose(random: () => number, chars: number): string {
  const words: string[] = [];
  let length = 0;
  while (length < chars) {
    const word = WORDS[Math.floor(random() * WORDS.length)]!;
    words.push(word);
    length += word.length + 1;
  }
  return words.join(" ").slice(0, chars);
}

const SIGNATURE_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Opaque, incompressible bytes of the size an encrypted reasoning item carries. */
function signature(random: () => number, chars: number): string {
  let out = "";
  for (let index = 0; index < chars; index += 1) {
    out += SIGNATURE_ALPHABET[Math.floor(random() * SIGNATURE_ALPHABET.length)];
  }
  return out;
}

function between(random: () => number, low: number, high: number): number {
  return low + Math.floor(random() * (high - low + 1));
}

function thinkingBlock(random: () => number): ThinkingContent {
  return {
    type: "thinking",
    thinking: prose(random, between(random, 150, 600)),
    thinkingSignature: signature(random, between(random, 800, 2_400)),
  };
}

function assistant(
  content: (TextContent | ThinkingContent | ToolCall)[],
  stopReason: AssistantMessage["stopReason"],
): AssistantMessage {
  // `api`/`provider`/`model` are restamped by the faux core from the model the
  // request named, so the placeholders below never reach the sidecar.
  return {
    role: "assistant",
    content,
    api: "faux",
    provider: "faux",
    model: "faux",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp: Date.now(),
  };
}

/** One turn's script: `rounds` read calls, then a settled answer. */
function turnScript(
  random: () => number,
  rounds: number,
  files: readonly string[],
  turn: number,
): AssistantMessage[] {
  const steps: AssistantMessage[] = [];
  for (let round = 0; round < rounds; round += 1) {
    const path = files[Math.floor(random() * files.length)]!;
    steps.push(
      assistant(
        [thinkingBlock(random), fauxToolCall("read", { path }, { id: `t${turn}-r${round}` })],
        "toolUse",
      ),
    );
  }
  const answer = prose(random, between(random, 300, 1_500));
  const fence =
    random() < 0.4
      ? `\n\n\`\`\`ts\nexport const value${turn} = ${JSON.stringify(prose(random, 60))};\n\`\`\`\n`
      : "";
  steps.push(assistant([thinkingBlock(random), { type: "text", text: answer + fence }], "stop"));
  return steps;
}

// --- sidecar accounting ----------------------------------------------------

interface SidecarCounts {
  entries: number;
  messages: number;
  customEntries: number;
  bytes: number;
}

/** Pi writes transactions: a line is one record or an array of them. */
export function countSidecar(path: string): SidecarCounts {
  const text = readFileSync(path, "utf8");
  let entries = 0;
  let messages = 0;
  let customEntries = 0;
  for (const line of text.split("\n")) {
    if (line.length === 0) continue;
    const parsed = JSON.parse(line) as Record<string, unknown> | Record<string, unknown>[];
    for (const record of Array.isArray(parsed) ? parsed : [parsed]) {
      if (record["kind"] !== "entry") continue;
      entries += 1;
      if (record["type"] === "message") messages += 1;
      if (record["type"] === "custom") customEntries += 1;
    }
  }
  return { entries, messages, customEntries, bytes: Buffer.byteLength(text) };
}

// --- generation ------------------------------------------------------------

/** Weighted tool rounds per turn: most turns read a little, some read a lot. */
function plannedRounds(random: () => number): number {
  const roll = random();
  if (roll < 0.2) return 0;
  if (roll < 0.55) return 1;
  if (roll < 0.85) return 2;
  return 3;
}

export async function growSidecarHistories(options: HistoryOptions): Promise<HistoryResult[]> {
  const results: HistoryResult[] = [];
  for (const target of options.targets) {
    const startedAt = performance.now();
    const random = mulberry32(target.seed);
    const faux = fauxProvider({
      api: options.catalogModel.api,
      provider: options.catalogModel.provider,
      models: [{ id: options.catalogModel.id, reasoning: options.catalogModel.reasoning }],
    });
    const models = createModels();
    // The catalog entry itself, not the faux one: the sidecar should name the
    // exact model object the desktop will rehydrate these messages under.
    models.setProvider({ ...faux.provider, getModels: () => [options.catalogModel] });
    const runtime = createPiAgentRuntime({ sessionDataDir: options.sessionDataDir, models });
    const spec: SessionRuntimeSpec = {
      identity: {
        role: "project",
        sessionId: target.sessionId,
        rootThreadId: target.rootThreadId,
        attachmentId: target.attachmentId,
        projectId: target.projectId,
        ticketId: null,
      },
      workspacePath: options.workspacePath,
      venue: "local",
      model: options.model,
      brief: { text: "VC-445 synthetic context-scaling fixture." },
      tools: { tools: ["read", "edit", "write", "execute"] },
      recovery: target.recovery,
      observer: async () => undefined,
    };
    const handle = await runtime.startSession(spec);
    let turns = 0;
    let toolCalls = 0;
    // What one turn appends is the runtime's business, not this file's, so the
    // starting estimate (six entries for a turn with no tool call, five more per
    // `read` round, as measured on the current runtime) is corrected from what
    // every turn actually appended.
    let base = 6;
    let perRound = 5;
    try {
      let counts = countSidecar(target.recovery.sessionFilePath);
      while (counts.entries < target.targetEntries) {
        const remaining = target.targetEntries - counts.entries;
        let rounds = plannedRounds(random);
        // Near the end, choose the round count that lands closest.
        if (base + rounds * perRound > remaining) {
          rounds = Math.max(0, Math.round((remaining - base) / perRound));
        }
        faux.setResponses(turnScript(random, rounds, options.files, turns));
        const before = counts.entries;
        const outcome = await handle.submitUserMessage(
          prose(random, between(random, 200, 700)),
          "queue",
          `vc445-${target.sessionId}-${target.seed}-${turns}`,
        );
        if (outcome.kind !== "delivered") {
          throw new Error(`turn ${turns} was not accepted: ${JSON.stringify(outcome)}`);
        }
        counts = countSidecar(target.recovery.sessionFilePath);
        const appended = counts.entries - before;
        if (rounds === 0) base = appended;
        else perRound = Math.max(1, (appended - base) / rounds);
        turns += 1;
        toolCalls += rounds;
      }
    } finally {
      await handle.close();
    }
    const counts = countSidecar(target.recovery.sessionFilePath);
    const result: HistoryResult = {
      sessionId: target.sessionId,
      targetEntries: target.targetEntries,
      ...counts,
      turns,
      toolCalls,
      generationMs: performance.now() - startedAt,
    };
    results.push(result);
    options.onProgress?.(results.length, options.targets.length, result);
  }
  return results;
}
