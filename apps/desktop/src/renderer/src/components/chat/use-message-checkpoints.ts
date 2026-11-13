/**
 * The checkpoint rail's two halves of wiring (VC-1211), kept out of the chat
 * plane: {@link useMessageCheckpoints} at the plane, where the rows are
 * projected, and {@link useCheckpointNavigation} in the windowed transcript,
 * which owns the scroller and which rows are mounted.
 *
 * Both work only from signals that already exist — the plane's rows, one
 * IntersectionObserver, the transcript's own rAF scroll read — and hand their
 * answers to the {@link CheckpointNavigator}, which re-renders the rail alone.
 * Nothing here measures per frame or per streamed token: a jump measures once,
 * and a jump's hold measures only while it is held.
 */
import * as React from "react";

import type { WorkTranscriptRow } from "@volli/session-presentation";
import type { ConversationControl } from "@renderer/components/ui/ai-elements/conversation";
import { createCheckpointNavigator, type CheckpointNavigator } from "./checkpoint-navigator";
import {
  checkpointReply,
  currentCheckpoint,
  holdCheckpoints,
  isCheckpointRow,
  messageCheckpoints,
  type MessageCheckpoint,
} from "./message-checkpoints";

/**
 * The person's messages in `rows`, a lazy reader for each one's reply, and the
 * plane's navigator. The list keeps its identity while nothing the rail draws
 * changed, which is every streamed token: a token changes an agent message,
 * and each checkpoint is cached on its own user message.
 */
export function useMessageCheckpoints(rows: readonly WorkTranscriptRow[]): {
  checkpoints: readonly MessageCheckpoint[];
  readReply(id: string): string | null;
  navigator: CheckpointNavigator;
} {
  // Written during render on purpose, as `useStableList` does: the hold is
  // content equality, so a render React discards never kept a different answer.
  const held = React.useRef<readonly MessageCheckpoint[]>([]);
  const checkpoints = React.useMemo(() => {
    held.current = holdCheckpoints(held.current, messageCheckpoints(rows));
    return held.current;
  }, [rows]);
  const latestRows = React.useRef(rows);
  React.useLayoutEffect(() => {
    latestRows.current = rows;
  }, [rows]);
  const readReply = React.useCallback((id: string) => checkpointReply(latestRows.current, id), []);
  const [navigator] = React.useState(createCheckpointNavigator);
  return { checkpoints, readReply, navigator };
}

/**
 * The reading line: 40% down the viewport. The root reaches far above the
 * scroller, so a message once above the line stays "intersecting" however far
 * up it scrolls; the observer then reports exactly the crossings of the line,
 * and the reader's exchange is the last message across it. The top margin
 * outruns any mounted window.
 */
const READING_LINE = "10000000px 0px -60% 0px";

/**
 * How far a held message may drift before the reader is taken to have moved
 * it. Just over the 1px a page's place-keeping leaves (`restorePrepend`
 * corrects only drift above 1px), and under any scroll a reader makes.
 */
const HOLD_SLACK_PX = 1.5;

/** A jump's message, and where the jump left it relative to the scroller's top. */
interface JumpHold {
  id: string;
  node: HTMLElement;
  offset: number;
}

const offsetIn = (scroller: HTMLElement, node: HTMLElement) =>
  node.getBoundingClientRect().top - scroller.getBoundingClientRect().top;

function messageNode(scroller: HTMLElement, id: string): HTMLElement | null {
  for (const node of scroller.querySelectorAll<HTMLElement>("[data-message-checkpoint]"))
    if (node.dataset["messageCheckpoint"] === id) return node;
  return null;
}

const rowIndex = (rows: readonly WorkTranscriptRow[], id: string) =>
  rows.findIndex((row) => row.kind === "turn" && row.messages[0]?.id === id);

/**
 * The transcript's side: which checkpoint the reader is in, published as it
 * changes, and the jump the rail calls. Returns what the transcript's scroll
 * read calls with each answer to "is the reader at the bottom?".
 *
 * `anchorAt` moves the transcript's window anchor — the one "Show earlier"
 * moves — so a message above the window is mounted by the window's own rule.
 */
export function useCheckpointNavigation(input: {
  sessionId: string;
  navigator: CheckpointNavigator;
  control: ConversationControl;
  rows: readonly WorkTranscriptRow[];
  checkpoints: readonly MessageCheckpoint[];
  mounted: readonly WorkTranscriptRow[];
  /** The first mounted row's index in `rows`. */
  start: number;
  anchorAt(id: string): void;
}): (pinned: boolean) => void {
  const { sessionId, navigator, control, rows, checkpoints, mounted, start, anchorAt } = input;
  const latest = React.useRef({ rows, start, checkpoints, anchorAt });
  React.useLayoutEffect(() => {
    latest.current = { rows, start, checkpoints, anchorAt };
  }, [rows, start, checkpoints, anchorAt]);

  // Pinned to the bottom means the latest exchange, wherever its message sits.
  const atBottom = React.useRef(true);
  // Mounted messages above the reading line, as the observer last reported.
  const aboveLine = React.useRef<ReadonlySet<string>>(new Set());
  // A jump's message stays current until the READER moves it: a message near
  // the end cannot reach the reading line, and a page the window then mounts
  // above it moves the scroll offset without moving the message on screen.
  // So the hold is the message's place in the viewport, not the offset.
  const hold = React.useRef<JumpHold | null>(null);
  // A jump to a message above the window, landed by the commit that mounts it.
  const pending = React.useRef<string | null>(null);

  const publish = React.useCallback(() => {
    const scroller = control.scroller();
    const held = hold.current;
    if (held !== null) {
      if (
        scroller !== null &&
        held.node.isConnected &&
        Math.abs(offsetIn(scroller, held.node) - held.offset) <= HOLD_SLACK_PX
      ) {
        navigator.publish(held.id);
        return;
      }
      hold.current = null;
    }
    const { rows: all, start: first, checkpoints: list } = latest.current;
    // The exchange the mounted window begins inside, when its message is above it.
    let before: string | null = null;
    for (let index = Math.min(first, all.length) - 1; index >= 0; index -= 1) {
      const row = all[index]!;
      if (row.kind === "turn" && isCheckpointRow(row)) {
        before = row.messages[0]!.id;
        break;
      }
    }
    navigator.publish(
      currentCheckpoint({
        checkpoints: list,
        above: aboveLine.current,
        before,
        pinned: atBottom.current,
      }),
    );
  }, [control, navigator]);

  // A plane that switches Session in place keeps none of the last one's jump,
  // and says so. (A plane's first Session has nothing to forget; its first
  // answer comes from the observer.)
  const shownSession = React.useRef(sessionId);
  React.useLayoutEffect(() => {
    if (shownSession.current === sessionId) return;
    shownSession.current = sessionId;
    hold.current = null;
    pending.current = null;
    atBottom.current = true;
    publish();
  }, [publish, sessionId]);

  // The message at the top of the viewport, under the scroller's own inset.
  // Written to the scroller directly: `scrollIntoView` would also scroll the
  // clipped, non-scrolling wrappers around it.
  const land = React.useCallback(
    (id: string) => {
      const scroller = control.scroller();
      const node = scroller === null ? null : messageNode(scroller, id);
      if (scroller === null || node === null) return;
      // Reading, not following: the same detach a wheel-up performs.
      control.stopFollowing();
      const inset = Number.parseFloat(getComputedStyle(scroller).scrollPaddingTop) || 0;
      scroller.scrollTop += offsetIn(scroller, node) - inset;
      hold.current = { id, node, offset: offsetIn(scroller, node) };
      publish();
    },
    [control, publish],
  );

  React.useLayoutEffect(
    () =>
      navigator.attach((id) => {
        const { rows: all, start: first, anchorAt: anchor } = latest.current;
        const index = rowIndex(all, id);
        pending.current = null;
        if (index < 0) return;
        if (index >= first) {
          land(id);
          return;
        }
        control.stopFollowing();
        pending.current = id;
        anchor(id);
      }),
    [control, land, navigator],
  );

  // One attempt, on the first commit after the jump — the one that applied its
  // anchor. Landed or not, the jump is over: a message that cannot be drawn
  // must not leave a search running on every streamed commit after it.
  React.useLayoutEffect(() => {
    const id = pending.current;
    if (id === null) return;
    pending.current = null;
    land(id);
  }, [mounted, land]);

  // Which mounted messages sit above the reading line. Rebuilt only when the
  // set of mounted messages changes, never per streamed token.
  const mountedKey = React.useMemo(
    () =>
      mounted
        .flatMap((row) =>
          row.kind === "turn" && isCheckpointRow(row) ? [row.messages[0]!.id] : [],
        )
        .join("\n"),
    [mounted],
  );
  React.useEffect(() => {
    const scroller = control.scroller();
    if (scroller === null || typeof IntersectionObserver === "undefined") {
      aboveLine.current = new Set();
      publish();
      return;
    }
    // The first report covers every observed message. Until it arrives the
    // previous answer stands: publishing an empty set here would light the
    // wrong mark for a frame each time a page is mounted, and scroll a long
    // rail there and back.
    let above: Set<string> | null = null;
    const observer = new IntersectionObserver(
      (entries) => {
        above ??= new Set();
        for (const entry of entries) {
          const id = (entry.target as HTMLElement).dataset["messageCheckpoint"];
          if (id === undefined) continue;
          if (entry.isIntersecting) above.add(id);
          else above.delete(id);
        }
        aboveLine.current = above;
        publish();
      },
      { root: scroller, rootMargin: READING_LINE },
    );
    for (const node of scroller.querySelectorAll<HTMLElement>("[data-message-checkpoint]"))
      observer.observe(node);
    return () => observer.disconnect();
  }, [control, mountedKey, publish]);

  React.useEffect(() => {
    publish();
  }, [checkpoints, publish]);

  return React.useCallback(
    (pinned: boolean) => {
      if (pinned === atBottom.current && hold.current === null) return;
      atBottom.current = pinned;
      publish();
    },
    [publish],
  );
}
