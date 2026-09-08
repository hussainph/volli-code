/**
 * What a closed terminal's saved record looks like (VC-290) — the surface a
 * Previous-band row and a ⌘K row now land on, instead of on whatever tab
 * happened to be in front of the Session's ticket.
 *
 * Presentational and store-free on purpose: everything on screen is either a
 * field of {@link TerminalHistoryDetail} or one of two fixed sentences, so the
 * panel can be rendered in a test with no window, no dialog and no fetch around
 * it — which is where the promises this ticket makes are actually checked.
 *
 * THE ABSENCES ARE CONTENT. A closed terminal has no scrollback and no recorded
 * commands, and the failure this replaces was a history entry that silently
 * showed something else. So the two sentences are printed plainly rather than
 * implied by empty space: an empty terminal frame would read as "this session
 * did nothing", which is a stronger and falser claim than "we did not keep it".
 * (CLAUDE.md's "let controls talk" argues against prose under controls; these
 * are not explanations of a control, they are the record's own contents.)
 */
import { ArrowClockwiseIcon } from "@phosphor-icons/react/dist/csr/ArrowClockwise";
import { TerminalWindowIcon } from "@phosphor-icons/react/dist/csr/TerminalWindow";

import {
  TERMINAL_LAST_COMMAND_NOT_RECORDED,
  TERMINAL_OUTPUT_NOT_SAVED,
  type TerminalHistoryDetail,
} from "@volli/session-presentation";

import { Button } from "@renderer/components/ui/button";
import { formatStamp } from "@renderer/lib/relative-time";

export interface SessionDetailPanelProps {
  /**
   * The portable surface model — what this record says and which controls it
   * makes meaningful. Both verbs are drawn from `detail.actions`, never
   * re-decided here: whether a scope can be recreated into and whether a
   * harness can be resumed are Session Presentation Contract decisions, and a
   * second copy of either beside a button is how one client starts offering
   * Resume for a harness that cannot do it.
   */
  detail: TerminalHistoryDetail;
  /** A Session started from this panel is coming up; both verbs stand down. */
  busy: boolean;
  onNewTerminal(): void;
  onResume(): void;
}

/** One `label: value` line of the record. */
function DetailRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-baseline gap-2">
      <dt className="w-24 shrink-0 text-ui text-muted-foreground">{label}</dt>
      <dd
        className={`min-w-0 flex-1 truncate text-ui text-foreground${mono === true ? " font-mono" : ""}`}
      >
        {value}
      </dd>
    </div>
  );
}

export function SessionDetailPanel({
  detail,
  busy,
  onNewTerminal,
  onResume,
}: SessionDetailPanelProps) {
  return (
    <div className="flex min-w-0 flex-col gap-4">
      {/* The visible heading lives HERE rather than in the dialog's own
          `DialogTitle`, so the whole record — name included — can be rendered
          and checked without a dialog around it. The dialog keeps a screen
          -reader-only `DialogTitle` carrying the same string, which is what
          names the modal. */}
      <div className="flex min-w-0 flex-col gap-1">
        <h2 className="truncate text-heading font-semibold text-foreground">{detail.title}</h2>
        <p className="truncate text-ui text-muted-foreground">
          {detail.source} · {detail.scopeLabel}
        </p>
      </div>

      <dl className="flex flex-col gap-2">
        <DetailRow label="Started" value={formatStamp(detail.startedAt, { time: true })} />
        {detail.endedAt !== null ? (
          <DetailRow label="Ended" value={formatStamp(detail.endedAt, { time: true })} />
        ) : null}
        <DetailRow label="Exit" value={detail.exitLabel} />
        {/* No row rather than an invented one: a record whose native detail no
            longer parses has no folder to name, and "unknown" in a path slot
            reads as a directory. */}
        {detail.cwd !== null ? <DetailRow label="Folder" value={detail.cwd} mono /> : null}
      </dl>

      <div className="flex flex-col gap-1 rounded-container border border-border bg-muted/30 p-4">
        <p className="text-ui text-muted-foreground">{TERMINAL_OUTPUT_NOT_SAVED}</p>
        <p className="text-ui text-muted-foreground">{TERMINAL_LAST_COMMAND_NOT_RECORDED}</p>
      </div>

      <div className="flex flex-wrap justify-end gap-2">
        {/* Two verbs that must never be mistaken for each other. This one is a
            NEW execution in the same scope — the closed record is untouched and
            stays where it is. Resume, when the harness allows it, hands an agent
            its own history back, which is a different promise; it sits beside
            this one and never replaces it. */}
        {detail.actions.recreate !== null ? (
          <Button variant="default" disabled={busy} onClick={onNewTerminal}>
            <TerminalWindowIcon aria-hidden />
            New terminal here
          </Button>
        ) : null}
        {detail.actions.resume !== null ? (
          <Button variant="outline" disabled={busy} onClick={onResume}>
            <ArrowClockwiseIcon aria-hidden />
            Resume session
          </Button>
        ) : null}
      </div>
    </div>
  );
}

/**
 * The project's Session listing has not answered yet.
 *
 * Its own state rather than a shrug, for the reason Home's tab restore keeps
 * `pending` separate from `settled`: "not read yet" is not "gone", and a
 * baseline fetch in flight must never be reported as a missing record.
 */
export function SessionDetailPending() {
  return <p className="text-ui text-muted-foreground">Loading this session’s record…</p>;
}

/**
 * The listing answered and this Session is not in it.
 *
 * It says so, which is the whole point of the ticket: the behaviour this
 * replaces answered a Session it could not show by opening a different one, so
 * "missing" and "closed" and "somewhere else" all looked identical from the
 * outside.
 */
export function SessionDetailUnknown() {
  return <p className="text-ui text-muted-foreground">This session’s record could not be found.</p>;
}

/** A settled read failure is neither loading nor proof that the record is gone. */
export function SessionDetailLoadFailed({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="flex flex-col items-start gap-2">
      <p className="text-ui text-muted-foreground">This session’s record could not be loaded.</p>
      <Button variant="outline" size="sm" onClick={onRetry}>
        Try again
      </Button>
    </div>
  );
}
