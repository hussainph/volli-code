/* ---------------------------------------------------------------- composer */

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
  text: string;
}

/** Blank text is not a message; it never reaches the queue. */
export function enqueueMessage(
  queue: readonly QueuedMessage[],
  message: QueuedMessage,
): QueuedMessage[] {
  const text = message.text.trim();
  return text.length === 0 ? [...queue] : [...queue, { id: message.id, text }];
}

export function removeQueued(queue: readonly QueuedMessage[], id: string): QueuedMessage[] {
  return queue.filter((entry) => entry.id !== id);
}

/**
 * `⌫` on an empty box. The newest queued message comes back to the textarea
 * rather than vanishing, so unqueue and edit are the same gesture and neither
 * one can lose typing.
 */
export function unqueueLast(
  queue: readonly QueuedMessage[],
): { queue: QueuedMessage[]; text: string } | null {
  const last = queue[queue.length - 1];
  if (last === undefined) return null;
  return { queue: queue.slice(0, -1), text: last.text };
}

/** Pull one specific entry back for editing. Same rule as {@link unqueueLast}. */
export function takeQueued(
  queue: readonly QueuedMessage[],
  id: string,
): { queue: QueuedMessage[]; text: string } | null {
  const found = queue.find((entry) => entry.id === id);
  if (found === undefined) return null;
  return { queue: removeQueued(queue, id), text: found.text };
}

/**
 * The queued message to release now, if any. A queue drains only into an idle
 * Session and only one at a time: the release starts the next turn, which makes
 * the Session busy again and re-arms this rule for the one after it.
 */
export function nextRelease(
  queue: readonly QueuedMessage[],
  state: { working: boolean; ready: boolean },
): QueuedMessage | null {
  if (state.working || !state.ready) return null;
  return queue[0] ?? null;
}
