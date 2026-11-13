/**
 * The person's own messages, as checkpoints on the transcript (VC-1211).
 *
 * The rail beside the transcript draws one mark per message the person sent
 * and jumps to it. Everything here is data shaping over the rows the chat plane
 * already projects, so the component only draws and the rules are tested here.
 *
 * WHAT COUNTS. A checkpoint is a `turn` row a user message opens that draws a
 * bubble: its prose, or failing that the names of the files it carried. Host
 * notices are already their own row kind and never reach this. A recorded
 * answer to an agent's question (`data-interaction-resolution`) draws as a
 * receipt line, not a bubble, and is not a message the person wrote into the
 * conversation, so it is not a checkpoint either.
 *
 * COST. This runs whenever the plane's rows change, which includes every
 * streamed chunk. A streamed chunk never changes a user message, so the prompt
 * snippet is cached on the message object and {@link holdCheckpoints} hands
 * back the previous list when nothing in it changed. The reply snippet, which
 * DOES change per chunk for the live exchange, is not part of the list at all:
 * {@link checkpointReply} reads it from the current rows only when a card opens.
 */
import type { WorkTranscriptRow } from "@volli/session-presentation";
import type { UIMessage } from "ai";

/** One message the person sent, as the rail draws it. */
export interface MessageCheckpoint {
  /** The message id, which is also its transcript row key. */
  readonly id: string;
  /** The message as one line of plain text, bounded to {@link SNIPPET_LIMIT}. */
  readonly prompt: string;
  /** The mark's accessible name: the same text, bounded to {@link LABEL_LIMIT}. */
  readonly label: string;
}

/**
 * Characters kept from a message or reply. The card clamps to a few lines on
 * its own; this only stops a fifteen-kilobyte paste from riding into the DOM.
 */
export const SNIPPET_LIMIT = 280;

/** Characters in a mark's accessible name: enough to recognise, short enough to hear. */
export const LABEL_LIMIT = 100;

/** Below this many messages a rail is one or no marks: noise, not navigation. */
export const MIN_CHECKPOINTS = 2;

const promptCache = new WeakMap<UIMessage, string>();

/** The checkpoint's prompt, or `null` when `row` is not a checkpoint. */
function checkpointPrompt(row: WorkTranscriptRow): string | null {
  if (row.kind !== "turn") return null;
  const message = row.messages[0];
  if (message === undefined || message.role !== "user") return null;
  const cached = promptCache.get(message);
  if (cached !== undefined) return cached.length > 0 ? cached : null;
  const prompt = messagePrompt(row.messages);
  promptCache.set(message, prompt);
  return prompt.length > 0 ? prompt : null;
}

function messagePrompt(messages: readonly UIMessage[]): string {
  const text: string[] = [];
  const files: string[] = [];
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type === "data-interaction-resolution") return "";
      if (part.type === "text") text.push(part.text);
      else if (part.type === "file" && typeof part.filename === "string") files.push(part.filename);
    }
  }
  const prose = plainSnippet(text.join("\n"));
  return prose.length > 0 ? prose : plainSnippet(files.join(", "));
}

/** Whether `row` is one of the person's messages the rail marks. */
export function isCheckpointRow(row: WorkTranscriptRow): boolean {
  return checkpointPrompt(row) !== null;
}

/** Every checkpoint in `rows`, in transcript order. */
export function messageCheckpoints(rows: readonly WorkTranscriptRow[]): MessageCheckpoint[] {
  const checkpoints: MessageCheckpoint[] = [];
  for (const row of rows) {
    const prompt = checkpointPrompt(row);
    if (prompt === null || row.kind !== "turn") continue;
    checkpoints.push({ id: row.messages[0]!.id, prompt, label: plainSnippet(prompt, LABEL_LIMIT) });
  }
  return checkpoints;
}

/**
 * `next`, with `previous` handed back whole when it says the same thing, and
 * unchanged entries kept by identity otherwise — so a memoized rail holds
 * through every streamed chunk and redraws only when the person's messages do.
 */
export function holdCheckpoints(
  previous: readonly MessageCheckpoint[],
  next: readonly MessageCheckpoint[],
): readonly MessageCheckpoint[] {
  const merged = next.map((checkpoint, index) => {
    const before = previous[index];
    return before !== undefined &&
      before.id === checkpoint.id &&
      before.prompt === checkpoint.prompt
      ? before
      : checkpoint;
  });
  const unchanged =
    merged.length === previous.length && merged.every((item, index) => item === previous[index]);
  return unchanged ? previous : merged;
}

/**
 * The last thing the agent said after the checkpoint `id` and before the
 * person's next message — for the latest exchange, the last text received so
 * far. `null` when the agent has said nothing in words yet (tool work alone),
 * or when `id` is no longer in the rows.
 */
export function checkpointReply(rows: readonly WorkTranscriptRow[], id: string): string | null {
  const start = rows.findIndex((row) => row.kind === "turn" && row.messages[0]?.id === id);
  if (start < 0) return null;
  let reply: string | null = null;
  for (let index = start + 1; index < rows.length; index += 1) {
    const row = rows[index]!;
    if (isCheckpointRow(row)) break;
    if (row.kind !== "turn" || row.messages[0]?.role !== "assistant") continue;
    for (const message of row.messages)
      for (const part of message.parts) {
        if (part.type !== "text") continue;
        const text = plainSnippet(part.text);
        if (text.length > 0) reply = text;
      }
  }
  return reply;
}

/**
 * Which checkpoint the reader is in, given the checkpoints whose message sits
 * above the reading line, in transcript order.
 *
 * `above` holds only MOUNTED messages. When none of them is above the line the
 * reader is either at the top of the conversation or inside an exchange whose
 * message is above the transcript's mounted window; `before` is that message
 * (the last checkpoint above the window), or `null` when there is none.
 */
export function currentCheckpoint(input: {
  checkpoints: readonly MessageCheckpoint[];
  above: ReadonlySet<string>;
  before: string | null;
  pinned: boolean;
}): string | null {
  const { checkpoints, above, before, pinned } = input;
  if (checkpoints.length === 0) return null;
  if (pinned) return checkpoints[checkpoints.length - 1]!.id;
  for (let index = checkpoints.length - 1; index >= 0; index -= 1) {
    const id = checkpoints[index]!.id;
    if (above.has(id)) return id;
  }
  return before ?? checkpoints[0]!.id;
}

/**
 * Markdown, as a line of reading text: fenced code, heading and list markers,
 * emphasis and link syntax dropped, whitespace collapsed, and cut at
 * {@link SNIPPET_LIMIT} on a code-point boundary with an ellipsis. Text that
 * is nothing but code keeps the code, without its fences.
 */
export function plainSnippet(markdown: string, limit: number = SNIPPET_LIMIT): string {
  // A long paste is cut long before it is cleaned: nothing past the limit is drawn.
  const source = markdown.slice(0, limit * 4);
  const prose = flatten(source.replace(FENCED_BLOCK, " "), limit);
  return prose.length > 0 ? prose : flatten(source, limit);
}

/** A fenced block, or an unclosed one running to the end of the text. */
const FENCED_BLOCK = /^[ \t]*(```|~~~)[^\n]*\n[\s\S]*?(^[ \t]*\1[^\n]*$|(?![\s\S]))/gm;

function flatten(markdown: string, limit: number): string {
  const text = markdown
    .replace(/^\s*(```|~~~).*$/gm, " ")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}(#{1,6}\s+|>\s?|[-*+]\s+(\[[ xX]\]\s+)?|\d+[.)]\s+)/gm, "")
    .replace(/(\*\*|__|~~|`)/g, "")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const points = Array.from(text);
  if (points.length <= limit) return text;
  return `${points
    .slice(0, limit - 1)
    .join("")
    .trimEnd()}…`;
}
