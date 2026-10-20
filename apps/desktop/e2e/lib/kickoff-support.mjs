import {
  cardById,
  summarizeTurnFrames,
  tabStrip,
  TICKET_TAB_STRIP,
  waitUntil,
} from "./smoke-kit.mjs";

/**
 * The details rail has its own tabs; only the Ticket strip proves an open
 * workspace. Include aria-hidden content: Create-more keeps a modal composer
 * over the workspace, but navigation underneath it is still a regression.
 */
export async function ticketWorkspaceOpen(page) {
  return (
    (await page
      .getByRole("tablist", {
        name: TICKET_TAB_STRIP,
        exact: true,
        includeHidden: true,
      })
      .getByRole("tab", { includeHidden: true })
      .count()) >= 1
  );
}

/** Explicit card opening, retried for the board's occasional missed double-click. */
export async function openTicketCard(page, displayId, { attempts = 3, timeout = 4000 } = {}) {
  for (let i = 0; i < attempts; i += 1) {
    await cardById(page, displayId).dblclick();
    try {
      await waitUntil("the ticket workspace to open", () => ticketWorkspaceOpen(page), { timeout });
      return true;
    } catch {
      // A missed gesture leaves the card on the board; retry that same card.
    }
  }
  return false;
}

/**
 * The sidebar's selected Session row identifies the tab in front by Session id
 * (active-sessions.tsx), not by its mutable auto-title. Pair it with the named
 * Ticket strip so a Home chat cannot satisfy the assertion.
 */
export async function preparedChatSelected(page, sessionId) {
  const selectedTabs = await tabStrip(page, TICKET_TAB_STRIP)
    .locator('[role="tab"][aria-selected="true"]')
    .count();
  const selectedSession = await page
    .locator(`[data-peek-surface="nav"][data-peek-row="chat:${sessionId}"] [data-active="true"]`)
    .count();
  return selectedTabs === 1 && selectedSession === 1;
}

export const KICKOFF_OPENING =
  "Begin work on this ticket. Your assignment is the Ticket Brief above.";

/**
 * Fold host snapshot frames, never renderer stores or a Node-side DB read. A
 * durable Session row is NOT execution evidence: require the stock opening's
 * accepted receipt and a runtime turn; completed replies must name that same
 * turn and belong to this exact Session.
 */
export function kickoffTurnEvidence(frames, sessionId, marker) {
  const ownFrames = frames.filter((frame) => frame.sessionId === sessionId);
  const command = ownFrames.find(
    (frame) =>
      frame.event?.payload?.kind === "command.recorded" &&
      frame.transcript?.message?.role === "user" &&
      frame.transcript.message.parts.some(
        (part) => part.type === "text" && part.text === KICKOFF_OPENING,
      ),
  )?.event.payload.command;
  const accepted =
    command !== undefined &&
    ownFrames.some((frame) => {
      const payload = frame.event?.payload;
      return (
        payload?.kind === "command.receipt.recorded" &&
        payload.receipt.commandId === command.id &&
        payload.receipt.status === "accepted" &&
        payload.receipt.result?.kind === "message.submitted" &&
        payload.receipt.result.sessionId === sessionId
      );
    });
  const turns = summarizeTurnFrames(ownFrames);
  const turnId = turns.startedIds[0] ?? null;
  const started =
    accepted &&
    turns.startedIds.length === 1 &&
    turnId !== null &&
    turns.interruptedIds.length === 0;
  const completed = started && turns.exactlyOneCompletedTurn;
  const answered =
    completed &&
    marker !== undefined &&
    ownFrames.some((frame) => {
      const transcript = frame.transcript;
      return (
        transcript?.turnId === turnId &&
        transcript.message?.role === "assistant" &&
        transcript.message.parts
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("")
          .trim() === marker
      );
    });
  return {
    sessionId,
    commandId: command?.id ?? null,
    turnId,
    accepted,
    started,
    completed,
    answered,
  };
}
