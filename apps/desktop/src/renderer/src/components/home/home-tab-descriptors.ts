/**
 * WHAT HOME'S TABS SAY ABOUT THEMSELVES — composed once, drawn by whichever
 * strip is asking (VC-202).
 *
 * It lived inside Home's one strip until Home could have several: a split
 * surface draws one strip per pane, and each of them needs the same facts about
 * the same Sessions. Composing them twice would be two chances for a park badge
 * or a preview italic to differ between two strips on the same screen.
 *
 * THE PER-TOKEN READS LIVE HERE, and that is the point of the seam: a chat's
 * title and lifecycle move on every folded frame batch, so anything that
 * subscribes to them re-renders once a second while a Session streams. Home's
 * surface component hosts every live terminal in the app and must not; the
 * strips must, because they draw exactly those two facts. Both reads are
 * shallow over PRIMITIVES — a selector returning fresh objects would re-render
 * on every batch whether or not anything moved.
 *
 * Composition order is the strip's fixed order (Board, terminals, chats,
 * files); which pane draws which of them, and in what order, is
 * `resolveSplitView`'s answer and is applied by the caller
 * (`split/split-tab-partition.ts`).
 */
import { useShallow } from "zustand/react/shallow";
import type { FileWorkspaceTab } from "@volli/shared";

import { fileTabLabels } from "@renderer/components/files/file-tab-labels";
import { HOME_BOARD_TAB, type HomeTabDescriptor } from "@renderer/components/home/home-tab-strip";
import { chatTabId, CHAT_TAB_FALLBACK_LABEL } from "@renderer/components/ticket/ticket-chat-tab";
import { chatTabStatus } from "@renderer/components/ticket/ticket-chat-tab";
import { fileTabId } from "@renderer/components/ticket/ticket-file-tab";
import { useChatSessionsStore } from "@renderer/stores/chat-sessions";
import type { SessionTab } from "@renderer/stores/sessions";

export interface HomeTabDescriptorsInput {
  terminalTabs: readonly SessionTab[];
  chatIds: readonly string[];
  fileTabs: readonly FileWorkspaceTab[];
  dirtyFilePaths: ReadonlySet<string>;
}

/** Home's whole strip as descriptors, in composed order (Board first). */
export function useHomeTabDescriptors({
  terminalTabs,
  chatIds,
  fileTabs,
  dirtyFilePaths,
}: HomeTabDescriptorsInput): readonly HomeTabDescriptor[] {
  const chatTitles = useChatSessionsStore(
    useShallow((state) =>
      chatIds.map(
        (sessionId) =>
          state.sessions[sessionId]?.projection?.session.title ?? CHAT_TAB_FALLBACK_LABEL,
      ),
    ),
  );
  const chatStatuses = useChatSessionsStore(
    useShallow((state) => chatIds.map((sessionId) => chatTabStatus(state.sessions[sessionId]))),
  );
  // Disambiguating hints are computed across EVERY open file, not per pane: two
  // tabs called `index.ts` need their parent directories whichever panes they
  // ended up in.
  const fileLabels = fileTabLabels(fileTabs.map((tab) => tab.relPath));

  return [
    HOME_BOARD_TAB,
    ...terminalTabs.map((tab): HomeTabDescriptor => ({ kind: "terminal", id: tab.sessionId, tab })),
    ...chatIds.map(
      (sessionId, index): HomeTabDescriptor => ({
        kind: "chat",
        id: chatTabId(sessionId),
        sessionId,
        title: chatTitles[index] ?? CHAT_TAB_FALLBACK_LABEL,
        status: chatStatuses[index] ?? "idle",
      }),
    ),
    ...fileTabs.map((tab, index): HomeTabDescriptor => {
      const label = fileLabels[index] ?? { name: tab.relPath, hint: null };
      return {
        kind: "file",
        id: fileTabId(tab.relPath),
        relPath: tab.relPath,
        title: label.name,
        hint: label.hint,
        preview: !tab.pinned,
        dirty: dirtyFilePaths.has(tab.relPath),
      };
    }),
  ];
}
