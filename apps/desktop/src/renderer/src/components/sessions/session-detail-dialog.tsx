/**
 * The app-wide surface a closed terminal's row opens (VC-290).
 *
 * ── WHY IT IS A MODAL AND NOT A TAB ──────────────────────────────────────
 * A tab is a place you WORK. This record has nothing to work in: no PTY, no
 * output, no input — it is a fact about a Session that has ended, read once and
 * left. Making it a tab would also mean persisting it in the workspace's tab
 * order and answering, on every relaunch, what a restored tab about a dead
 * terminal should do. A modal addressed by `{projectId, sessionId}` is opened
 * from anywhere, closes back onto whatever you were doing, and — crucially —
 * takes nothing over: the tab you were in is still the tab you were in, which is
 * the exact failure this ticket exists to end. If saved bounded output ever
 * lands (the ticket names it as a later slice), it lands in this same view.
 *
 * ── WHY IT READS THE PROJECT'S LISTING ───────────────────────────────────
 * The Session listing is already push-fed and `ensure()`-deduped for every
 * surface in the window (`stores/project-sessions.ts`), and it holds exactly the
 * durable record this view is about. So there is no new fetch and no second
 * answer to "what does this Session say about itself" — and after a relaunch,
 * the record is whatever the baseline read returns, which is what makes this
 * view survive the app being closed while a live terminal cannot.
 */
import * as React from "react";
import { useShallow } from "zustand/react/shallow";

import { Dialog, DialogContent, DialogTitle } from "@renderer/components/ui/dialog";
import { buildTerminalSessionDetail } from "./session-detail-model";
import {
  SessionDetailPanel,
  SessionDetailPending,
  SessionDetailUnknown,
} from "./session-detail-panel";
import { resumeTicketSession, startProjectTerminal, startTicketTerminal } from "./session-create";
import { canResumeSession } from "@renderer/components/ticket/session-history";
import { useBoardStore } from "@renderer/stores/board";
import { useProjectsStore } from "@renderer/stores/projects";
import { useProjectSessionsStore } from "@renderer/stores/project-sessions";
import { launchAdapter, ticketScope, useSessionsStore } from "@renderer/stores/sessions";
import { useUiStore } from "@renderer/stores/ui";
import { useWorkspaceStore } from "@renderer/stores/workspace";

export function SessionDetailDialog() {
  const address = useUiStore((state) => state.sessionDetail);
  const close = useUiStore((state) => state.closeSessionDetail);

  return (
    <Dialog
      open={address !== null}
      onOpenChange={(next) => {
        if (!next) close();
      }}
    >
      <DialogContent className="sm:max-w-xl">
        {address === null ? null : (
          <SessionDetailBody
            projectId={address.projectId}
            sessionId={address.sessionId}
            onDone={close}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * One record, resolved and drawn. Split from the dialog shell so the resolution
 * effects (`ensure`, the record lookup) mount with an address and unmount
 * without one, rather than running against a `null` for the life of the window.
 */
function SessionDetailBody({
  projectId,
  sessionId,
  onDone,
}: {
  projectId: string;
  sessionId: string;
  onDone: () => void;
}) {
  const ensure = useProjectSessionsStore((state) => state.ensure);
  React.useEffect(() => {
    void ensure(projectId);
  }, [ensure, projectId]);

  // The record itself, by identity: the listing's array is replaced on every
  // push, and this view only cares about the one Session it was opened for.
  const record = useProjectSessionsStore(
    (state) => state.byProject[projectId]?.terminal.find((row) => row.id === sessionId) ?? null,
  );
  // Whether the project's baseline read has landed at all. `undefined` rows are
  // a fetch in flight, not an answer — the same distinction `resolveHomeTabs`
  // draws before it writes a persisted Session id off as stale.
  const listed = useProjectSessionsStore((state) => state.byProject[projectId] !== undefined);
  const project = useProjectsStore(
    useShallow((state) => state.projects.find((candidate) => candidate.id === projectId) ?? null),
  );
  const ticket = useBoardStore((state) =>
    record === null || record.ticketId === null
      ? null
      : (state.ticketsByProject[projectId]?.find((candidate) => candidate.id === record.ticketId) ??
        null),
  );
  // A create in flight, on whichever owner this record's scope names — the same
  // flag the ticket rail's and Home's own "+" go quiet on (`ownerKey`: a ticket
  // id for a Ticket Session, the project id for a Board Session).
  const starting = useSessionsStore(useShallow((state) => state.starting));

  if (record === null || project === null) {
    return (
      <>
        <DialogTitle className="sr-only">Session</DialogTitle>
        {listed && project !== null ? <SessionDetailUnknown /> : <SessionDetailPending />}
      </>
    );
  }

  const detail = buildTerminalSessionDetail({
    record,
    ticket,
    ticketPrefix: project.ticketPrefix,
  });
  const busy = (record.ticketId ?? projectId) in starting;

  /**
   * A NEW Session in the same scope. It is not a restore and never claims to
   * be: the closed record is untouched, still listed, and still openable here.
   * The fresh terminal is put in front the way every other create path puts one
   * in front, and the dialog steps aside so the person lands in the shell they
   * just asked for.
   */
  const newTerminal = (): void => {
    const recreate = detail.recreate;
    if (recreate === null) return;
    onDone();
    if (recreate.kind === "project") {
      void startProjectTerminal(projectId);
      return;
    }
    // The workspace first, then the Session: `startTicketTerminal` records the
    // fresh tab as the ticket's active one, and opening the workspace after it
    // would land on whatever tab had been in front before.
    useWorkspaceStore.getState().openTicketWorkspace(projectId, recreate.ticketId);
    void startTicketTerminal(projectId, recreate.ticketId);
  };

  /**
   * The other verb, kept separate on purpose: resume asks the harness to pick
   * this Session's own history back up, and it is offered only where the
   * harness catalogue says that is possible. It also lands as a new tab — the
   * ended record's row stays exactly where it is.
   */
  const resume = (): void => {
    if (record.ticketId === null) return;
    const ticketId = record.ticketId;
    onDone();
    useWorkspaceStore.getState().openTicketWorkspace(projectId, ticketId);
    void resumeTicketSession(ticketScope(projectId, ticketId), record.id).then((booted) => {
      if (booted === null) return;
      useWorkspaceStore.getState().openTicketSession(projectId, ticketId, booted);
    });
  };

  return (
    <>
      {/* The visible heading is the panel's; this names the modal for a screen
          reader without drawing a second one. */}
      <DialogTitle className="sr-only">{detail.title}</DialogTitle>
      <SessionDetailPanel
        detail={detail}
        // Resume is a TICKET Session's affordance (main resolves the resume
        // command inside that ticket's worktree), and only when the harness
        // that was running can actually be resumed.
        resumable={
          record.ticketId !== null &&
          detail.recreate !== null &&
          canResumeSession({ kind: "terminal", record }, launchAdapter)
        }
        busy={busy}
        onNewTerminal={newTerminal}
        onResume={resume}
      />
    </>
  );
}
