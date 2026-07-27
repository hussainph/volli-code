/**
 * The board itself — the real `Board`, with its filters, both view modes and
 * drag-and-drop live.
 *
 * Distinct from the App shell scratch on purpose. There the board is one pane
 * among several and you are judging proportion; here it has the full stage, so
 * you are judging the board: column rhythm, how a tall column reads against a
 * nearly-empty one, whether the collapsed rail earns its width, and what a
 * filter that matches almost nothing looks like.
 *
 * Everything interactive works, because it is the real component and its state
 * is the real store: drag a card across columns, toggle the view, narrow by
 * label. What it cannot do is persist — the mutations write through the bridge,
 * which is stubbed, so a drag moves the card and then the failure toast tells
 * you it did not save. That is the app's genuine failure path rather than a
 * lab artifact, and it is the reason this scratch is for looking at layout and
 * motion rather than for testing persistence.
 */
import { Board } from "@renderer/components/board/board";

import { project } from "../fixtures";
import { appApi, seedApp } from "../seed";

export const title = "Board";
export const note = "Real kanban — filters, both views, live drag";
export const viewport = "window" as const;

export const seed = seedApp;
export const api = appApi;

export default function BoardScratch() {
  return (
    // The board fills the content card in the app; give it the same shape here
    // so column heights and the horizontal scroll behave as they really do.
    <div className="flex h-full flex-col overflow-hidden bg-background p-2">
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border">
        <Board projectId={project.id} ticketPrefix={project.ticketPrefix} />
      </div>
    </div>
  );
}
