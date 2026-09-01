/**
 * What of the model's context window this Session is holding, and roughly who
 * is holding it.
 *
 * Two kinds of number meet here and the code keeps them apart on purpose:
 *
 *  - **Measured.** A settled assistant message carries the provider's own
 *    token accounting in its transcript metadata (`input + cacheRead +
 *    cacheWrite + output`), and their sum is the context the model was
 *    actually holding when it answered. That is the only honest total, so it
 *    is the only total shown.
 *  - **Estimated.** How that total divides between the things on screen — your
 *    messages, the replies, reasoning, tool traffic — is not reported by any
 *    provider. It is estimated from transcript text at ~4 characters per token
 *    and then scaled so the parts never claim more than the measured whole.
 *    Whatever the visible transcript cannot account for is the system bucket:
 *    the system prompt, tool definitions, and provider overhead that occupy
 *    context without ever being drawn.
 *
 * Pure over its arguments, so the split is testable without a session — and so
 * the surface above can memoize on the durable message list and stay off the
 * live stream's frame budget.
 */
import type { UIMessage } from "ai";

export type ContextSegmentId = "system" | "user" | "assistant" | "reasoning" | "tools";

export interface ContextUsageSegment {
  id: ContextSegmentId;
  label: string;
  /** Estimated share of the measured total, in tokens. Always > 0. */
  tokens: number;
}

export interface SessionContextUsage {
  /** The provider-measured context occupancy at the last settled reply. */
  usedTokens: number;
  /** The selected model's window, or null when the catalog does not know it. */
  contextWindow: number | null;
  /** `usedTokens / contextWindow`, clamped to [0, 1]; null without a window. */
  fraction: number | null;
  /** The estimated split of `usedTokens`, largest bucket first not guaranteed — declaration order is stable: system, user, assistant, reasoning, tools. */
  segments: readonly ContextUsageSegment[];
}

const SEGMENT_LABELS: Record<ContextSegmentId, string> = {
  system: "System prompt & overhead",
  user: "Your messages",
  assistant: "Assistant replies",
  reasoning: "Reasoning",
  tools: "Tool activity",
};

/** The declaration order every consumer draws segments in. */
const SEGMENT_ORDER: readonly ContextSegmentId[] = [
  "system",
  "user",
  "assistant",
  "reasoning",
  "tools",
];

/** The estimate's whole model of tokenization. Close enough for a share, never shown as a count of record. */
const CHARS_PER_TOKEN = 4;

/**
 * The Session's context usage as of its last metered reply, or null while no
 * reply has been metered — a Session that has not spoken has nothing to show,
 * which is the honest answer rather than a zero.
 */
export function sessionContextUsage(
  messages: readonly UIMessage[],
  contextWindow: number | null,
): SessionContextUsage | null {
  let meteredAt = -1;
  let usedTokens = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const measured = meteredTokens(messages[index]!);
    if (measured !== null) {
      meteredAt = index;
      usedTokens = measured;
      break;
    }
  }
  if (meteredAt < 0) return null;

  const window = contextWindow !== null && contextWindow > 0 ? contextWindow : null;
  return {
    usedTokens,
    contextWindow: window,
    fraction: window === null ? null : Math.min(1, usedTokens / window),
    segments: splitUsage(messages.slice(0, meteredAt + 1), usedTokens),
  };
}

/**
 * The measured occupancy one settled message reports, or null when it reports
 * nothing usable. Metadata crossed the RPC edge as JSON, so every read here is
 * defensive: this runs against whatever a (possibly newer) writer put there.
 */
function meteredTokens(message: UIMessage): number | null {
  if (message.role !== "assistant") return null;
  const metadata: unknown = message.metadata;
  if (!isRecord(metadata) || !isRecord(metadata["tokens"])) return null;
  const tokens = metadata["tokens"];
  const fields = [tokens["input"], tokens["cacheRead"], tokens["cacheWrite"], tokens["output"]];
  if (!fields.some((field) => typeof field === "number" && Number.isFinite(field))) return null;
  const total = fields.reduce<number>(
    (sum, field) => sum + (typeof field === "number" && Number.isFinite(field) ? field : 0),
    0,
  );
  return total > 0 ? total : null;
}

/**
 * Divides the measured total across what the transcript can see, and files the
 * remainder under system. The parts always sum exactly to `usedTokens`: the
 * estimates are scaled down when they overclaim, and integer rounding drift is
 * settled against the largest bucket rather than left as an off-by-few lie.
 */
function splitUsage(
  messages: readonly UIMessage[],
  usedTokens: number,
): readonly ContextUsageSegment[] {
  const estimated: Record<ContextSegmentId, number> = {
    system: 0,
    user: 0,
    assistant: 0,
    reasoning: 0,
    tools: 0,
  };
  for (const message of messages) {
    for (const part of message.parts) {
      const record = part as unknown as Record<string, unknown>;
      if (part.type === "text") {
        const id = message.role === "user" ? "user" : "assistant";
        estimated[id] += estimateTokens(typeof record["text"] === "string" ? record["text"] : "");
      } else if (part.type === "reasoning") {
        estimated.reasoning += estimateTokens(
          typeof record["text"] === "string" ? record["text"] : "",
        );
      } else if (part.type === "dynamic-tool") {
        estimated.tools += estimateTokens(
          safeStringify(record["input"]) + safeStringify(record["output"]),
        );
      }
    }
  }

  const visible = estimated.user + estimated.assistant + estimated.reasoning + estimated.tools;
  // The estimate never outclaims the measurement: scaled to fit when it is
  // over, and the shortfall is the system bucket when it is under.
  const scale = visible > usedTokens ? usedTokens / visible : 1;
  const shares: Record<ContextSegmentId, number> = {
    system: visible >= usedTokens ? 0 : usedTokens - visible,
    user: estimated.user * scale,
    assistant: estimated.assistant * scale,
    reasoning: estimated.reasoning * scale,
    tools: estimated.tools * scale,
  };

  const segments = SEGMENT_ORDER.filter((id) => shares[id] > 0).map((id) => ({
    id,
    label: SEGMENT_LABELS[id],
    tokens: Math.max(1, Math.round(shares[id])),
  }));
  const drift = usedTokens - segments.reduce((sum, segment) => sum + segment.tokens, 0);
  if (drift !== 0 && segments.length > 0) {
    const largest = segments.reduce((held, candidate) =>
      candidate.tokens > held.tokens ? candidate : held,
    );
    largest.tokens = Math.max(1, largest.tokens + drift);
  }
  return segments;
}

/**
 * Which segment owns each cell of a fixed grid — the breakdown as a picture.
 *
 * The grid divides the whole window (or, windowless, the used total) into
 * `cellCount` equal cells, allocated by largest remainder so the picture is
 * deterministic and sums exactly. Every nonzero segment keeps at least one
 * cell even below one cell's worth of tokens: a bucket that exists but cannot
 * be hovered is a breakdown with a hole in it.
 */
export function contextGridCells(
  usage: SessionContextUsage,
  cellCount: number,
): readonly (ContextSegmentId | "free")[] {
  const total = usage.contextWindow ?? usage.usedTokens;
  if (total <= 0 || cellCount <= 0) return [];
  const entries: { id: ContextSegmentId | "free"; tokens: number }[] = usage.segments.map(
    (segment) => ({ id: segment.id, tokens: segment.tokens }),
  );
  const free = total - usage.usedTokens;
  if (free > 0) entries.push({ id: "free", tokens: free });

  const cells = entries.map((entry) => Math.floor((entry.tokens / total) * cellCount));
  let remaining = cellCount - cells.reduce((sum, count) => sum + count, 0);
  const byRemainder = entries
    .map((entry, index) => ({
      index,
      remainder: (entry.tokens / total) * cellCount - cells[index]!,
    }))
    .toSorted((a, b) => b.remainder - a.remainder);
  for (const seat of byRemainder) {
    if (remaining <= 0) break;
    cells[seat.index]! += 1;
    remaining -= 1;
  }
  // The floor for tiny-but-real buckets, funded by the largest allocation.
  for (let index = 0; index < entries.length; index += 1) {
    if (entries[index]!.tokens <= 0 || cells[index]! > 0) continue;
    const donor = cells.reduce((held, count, at) => (count > cells[held]! ? at : held), 0);
    if (cells[donor]! > 1) {
      cells[donor]! -= 1;
      cells[index]! += 1;
    }
  }

  const grid: (ContextSegmentId | "free")[] = [];
  entries.forEach((entry, index) => {
    for (let cell = 0; cell < cells[index]!; cell += 1) grid.push(entry.id);
  });
  return grid;
}

/** "417", "1.2k", "41k", "1.2M" — the compact form a pill has room for. */
export function formatTokens(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens < 0) return "0";
  if (tokens < 1000) return String(Math.round(tokens));
  if (tokens < 10_000) return `${trimmed(tokens / 1000)}k`;
  if (tokens < 1_000_000) return `${Math.round(tokens / 1000)}k`;
  return `${trimmed(tokens / 1_000_000)}M`;
}

/** One decimal, with a trailing `.0` dropped: `1.2`, `9.9`, `2`. */
function trimmed(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

function estimateTokens(text: string): number {
  return text.length === 0 ? 0 : Math.ceil(text.length / CHARS_PER_TOKEN);
}

function safeStringify(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
