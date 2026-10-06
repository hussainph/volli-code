/* ---------------------------------------------------------------- composer */

import {
  isBlobLinkView,
  parseBlobUrl,
  readSkillResources,
  type BlobLinkView,
  type PromptResource,
} from "@volli/shared";
import type { UIMessage } from "ai";

/**
 * What ⏎ means right now.
 *
 * Delivery is session state, not a control: idle, ⏎ sends; while a turn is live
 * ⏎ queues behind it and ⌘⏎ steers the turn already running. The same keystroke
 * carries a different meaning because the Session is in a different state,
 * which is why five delivery options in a `<select>` was the wrong shape.
 */
export type ComposerIntent = "send" | "queue" | "steer";

export function composerIntent(state: { working: boolean; steer: boolean }): ComposerIntent {
  if (!state.working) return "send";
  return state.steer ? "steer" : "queue";
}

export interface QueuedMessage {
  id: string;
  commandId?: string;
  queueState?: "queued" | "releasing";
  text: string;
  /**
   * A non-null launch title this opening message is allowed to refine.
   *
   * Ordinarily only a title-less Session is auto-named. Composed starts seed a
   * useful fallback before their stock kickoff can deliver, so they carry that
   * exact title here as the byte-identical guard baseline. Any other current
   * title is a person's rename and remains untouchable.
   */
  autoTitleBaseline?: string;
  /**
   * Skill bodies the text's `/slug` references resolved to at submit — the
   * message-scoped half of the message, delivered beside the text as RESOURCE
   * blocks rather than spliced into it (VC-49). Carried on the message object
   * itself so a queued or held copy releases with exactly what was resolved
   * when the person pressed ⏎. Absent means the text referenced no skill.
   */
  resources?: readonly PromptResource[];
  /**
   * Files attached to this message (VC-50), carried on the message for the
   * same reason `resources` is: a queued or held copy must release with
   * exactly what was attached when the person pressed ⏎. Absent means a
   * message with no files.
   */
  attachments?: readonly BlobLinkView[];
}

/**
 * Blank text is not a message; it never reaches the queue — UNLESS something
 * is attached to it. Dropping in a screenshot and pressing ⏎ without typing is
 * an ordinary way to ask what it is (VC-50), so what makes a message real is
 * having *something* in it, not having words.
 */
export function enqueueMessage(
  queue: readonly QueuedMessage[],
  message: QueuedMessage,
): QueuedMessage[] {
  const text = message.text.trim();
  const attachments = message.attachments ?? [];
  if (text.length === 0 && attachments.length === 0) return [...queue];
  const entry: QueuedMessage = {
    id: message.id,
    text,
    ...(message.autoTitleBaseline === undefined
      ? {}
      : { autoTitleBaseline: message.autoTitleBaseline }),
    ...(message.resources === undefined ? {} : { resources: message.resources }),
    ...(attachments.length === 0 ? {} : { attachments }),
  };
  return [...queue, entry];
}

export function removeQueued(queue: readonly QueuedMessage[], id: string): QueuedMessage[] {
  return queue.filter((entry) => entry.id !== id);
}

/** What one pulled-back-for-editing row leaves behind, and what comes with it. */
export interface TakenQueued {
  queue: QueuedMessage[];
  text: string;
  /** The row's files, back for the strip to hold again (VC-137). */
  attachments?: readonly BlobLinkView[];
}

/**
 * `⌫` on an empty box. The newest queued message comes back to the textarea
 * rather than vanishing, so unqueue and edit are the same gesture and neither
 * one can lose typing — or the files the row carried, which return to the
 * strip rather than being detached: the message may still be sent.
 */
export function unqueueLast(queue: readonly QueuedMessage[]): TakenQueued | null {
  const last = queue[queue.length - 1];
  if (last === undefined) return null;
  return {
    queue: queue.slice(0, -1),
    text: last.text,
    ...(last.attachments === undefined ? {} : { attachments: last.attachments }),
  };
}

/** Pull one specific entry back for editing. Same rule as {@link unqueueLast}. */
export function takeQueued(queue: readonly QueuedMessage[], id: string): TakenQueued | null {
  const found = queue.find((entry) => entry.id === id);
  if (found === undefined) return null;
  return {
    queue: removeQueued(queue, id),
    text: found.text,
    ...(found.attachments === undefined ? {} : { attachments: found.attachments }),
  };
}

/* ------------------------------------------------------------- the title */

/**
 * A new renderer chat has no durable title until its first delivered message.
 * Any string, including a human-entered `Chat 1`, is an explicit title and is
 * never eligible for automatic replacement.
 */
export function isUntitledChatSession(title: string | null): boolean {
  return title === null;
}

/** Project the host message, not a device-local copy. */
export function queuedMessageFromHost(entry: {
  id: string;
  commandId: string;
  message: UIMessage;
  state: "queued" | "releasing";
}): QueuedMessage {
  const metadata =
    typeof entry.message.metadata === "object" && entry.message.metadata !== null
      ? (entry.message.metadata as Record<string, unknown>)
      : {};
  const views = Array.isArray(metadata.attachments)
    ? metadata.attachments.filter(isBlobLinkView)
    : [];
  const attachments = [...views];
  for (const part of entry.message.parts) {
    if (part.type !== "file") continue;
    const blobHash = parseBlobUrl(part.url);
    if (blobHash === null || attachments.some((view) => view.blobHash === blobHash)) continue;
    // Other Clients may submit file parts without desktop link-view metadata.
    // Preserve the file on edit/resend; a missing link id cannot detach a link.
    const name = part.filename ?? blobHash;
    attachments.push({
      linkId: null,
      blobHash,
      label: name,
      originalName: name,
      mime: part.mediaType,
      sizeBytes: 0,
    });
  }
  const resources = readSkillResources(entry.message.parts);
  return {
    id: entry.id,
    commandId: entry.commandId,
    queueState: entry.state,
    text: entry.message.parts
      .flatMap((part) => (part.type === "text" ? [part.text] : []))
      .join("\n"),
    ...(attachments.length === 0 ? {} : { attachments }),
    ...(resources.length === 0 ? {} : { resources }),
    ...(typeof metadata.autoTitleBaseline === "string"
      ? { autoTitleBaseline: metadata.autoTitleBaseline }
      : {}),
  };
}
