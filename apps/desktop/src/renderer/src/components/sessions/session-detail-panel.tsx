import { LoadingLabel } from "@renderer/components/ui/loading-label";
/**
 * What a closed terminal's saved record looks like (VC-290) — the surface a
 * Previous-band row and a ⌘K row now land on, instead of on whatever tab
 * happened to be in front of the Session's ticket.
 *
 * Presentational and store-free: the saved record is a compact icon/value list.
 * It shows no terminal-shaped empty frame and no tutorial box beneath the facts.
 */
import {
  RefreshIcon,
  ClockIcon,
  FinishedIcon,
  FolderIcon,
  SignOutIcon,
  type IconComponent as Icon,
  TerminalIcon,
} from "@renderer/components/ui/icon";

import type { TerminalHistoryDetail } from "@volli/session-presentation";

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

/** An icon/value line, retaining its descriptor for assistive technology. */
function DetailRow({
  label,
  value,
  mono,
  icon: Icon,
}: {
  label: string;
  value: string;
  mono?: boolean;
  icon: Icon;
}) {
  return (
    <div className="flex items-center gap-2">
      <dt title={label} className="shrink-0 text-muted-foreground">
        <Icon aria-hidden className="size-4" />
        <span className="sr-only">{label}</span>
      </dt>
      <dd
        title={value}
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
        <DetailRow
          icon={ClockIcon}
          label="Started"
          value={formatStamp(detail.startedAt, { time: true })}
        />
        {detail.endedAt !== null ? (
          <DetailRow
            icon={FinishedIcon}
            label="Ended"
            value={formatStamp(detail.endedAt, { time: true })}
          />
        ) : null}
        <DetailRow icon={SignOutIcon} label="Exit" value={detail.exitLabel} />
        {/* No row rather than an invented one: a record whose native detail no
            longer parses has no folder to name, and "unknown" in a path slot
            reads as a directory. */}
        {detail.cwd !== null ? (
          <DetailRow icon={FolderIcon} label="Folder" value={detail.cwd} mono />
        ) : null}
      </dl>

      <div className="flex flex-wrap justify-end gap-2">
        {/* Two verbs that must never be mistaken for each other. This one is a
            NEW execution in the same scope — the closed record is untouched and
            stays where it is. Resume, when the harness allows it, hands an agent
            its own history back, which is a different promise; it sits beside
            this one and never replaces it. */}
        {detail.actions.recreate !== null ? (
          <Button variant="default" disabled={busy} onClick={onNewTerminal}>
            <TerminalIcon aria-hidden />
            New terminal here
          </Button>
        ) : null}
        {detail.actions.resume !== null ? (
          <Button variant="outline" disabled={busy} onClick={onResume}>
            <RefreshIcon aria-hidden />
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
  return (
    <p className="text-ui text-muted-foreground">
      <LoadingLabel>Loading this session’s record</LoadingLabel>
    </p>
  );
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
