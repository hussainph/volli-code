/**
 * Configure → Protection: the Authority entry while the Protection experiment
 * is on (VC-480).
 *
 * ONE SWITCH, and it is a reading of the policy rather than a setting of its
 * own. Protection is on exactly when the resolved policy enforces. Turning it
 * on states `enforcement: "enforce"`; turning it off removes BOTH `enforcement`
 * and `containment` from the stored departures, so nothing the old Authority
 * pane left behind can keep governing a project whose page says it is off. The
 * write is `authority-pane.tsx`'s merge-and-prune, copied rather than shared so
 * the experiment can be deleted without touching the pane it replaces: every
 * field this page draws no control for survives the write untouched, and an
 * emptied document is stored as `null`.
 *
 * APPROVED ACTIONS is the ledger main keeps of a person's "Allow for this
 * Session" and "Always allow" answers. Rows are written only in main, from a
 * card; this page lists them and revokes them. A revoke has no confirm — the
 * toast carries an Undo, which restores the same row with its provenance —
 * because the cost of a mistaken revoke is one more question from an agent.
 * `summary` is drawn verbatim: it is the sentence the gate, the card and this
 * list share (`describeApproval`), and re-describing it here would let them
 * drift.
 *
 * ADVANCED holds the one remaining per-actor choice a person may want — which
 * transcripts a Session can read — collapsed, because the switch is the page.
 *
 * The page must fit one window with Advanced closed and a handful of rows, so
 * the list scrolls inside its own card rather than lengthening the page.
 */
import * as React from "react";
import { toast } from "sonner";
import { CaretDownIcon } from "@phosphor-icons/react/dist/csr/CaretDown";
import { ListChecksIcon } from "@phosphor-icons/react/dist/csr/ListChecks";
import { ShieldIcon } from "@phosphor-icons/react/dist/csr/Shield";
import { ShieldCheckIcon } from "@phosphor-icons/react/dist/csr/ShieldCheck";
import {
  DEFAULT_AUTHORITY_POLICY,
  errorMessage,
  resolveAuthorityPolicy,
  type AuthorityActorKind,
  type AuthorityApproval,
  type AuthorityPolicyOverride,
  type PeekDisclosure,
  type Project,
} from "@volli/shared";

import {
  AsyncSection,
  CONTROL_W,
  Empty,
  OverrideControl,
  PrefRow,
  type AsyncState,
} from "@renderer/components/settings/kit";
import { Button } from "@renderer/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@renderer/components/ui/collapsible";
import { ListRow } from "@renderer/components/ui/list-row";
import { Segmented } from "@renderer/components/ui/segmented";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@renderer/components/ui/select";
import { Switch } from "@renderer/components/ui/switch";
import { useLatestAsync } from "@renderer/hooks/use-latest-async";
import { relativeTime } from "@renderer/lib/relative-time";
import { cn } from "@renderer/lib/utils";
import { writeThrough } from "@renderer/stores/mutate";
import { useProjectsStore } from "@renderer/stores/projects";

const ON_TEXT =
  "Agents work inside their workspace and ask before going further. Credentials stay out of reach.";
const OFF_TEXT =
  "Agents run as you. They can read, change and run anything you can, without asking.";
const FLIPPED_TEXT = "Sessions already running keep their setting until they next start.";
const EMPTY_TITLE = "Nothing approved yet";
const EMPTY_TEXT =
  'When you choose "Allow for this Session" or "Always allow" on a request, it\'s kept here.';

/** The three transcript postures, in the order a person reads them. */
const PEEK_OPTIONS: readonly { value: PeekDisclosure; label: string }[] = [
  { value: "own", label: "Its own only" },
  { value: "project", label: "Any in this project" },
  { value: "none", label: "None" },
];

function peekLabel(value: PeekDisclosure): string {
  return PEEK_OPTIONS.find((option) => option.value === value)?.label ?? value;
}

type ApprovalFilter = "all" | "project" | "session";

/** Column widths, shared by the header and every row so the columns line up. */
const APPLIES_W = "w-24 shrink-0";
const USED_W = "w-40 shrink-0";
const REVOKE_W = "w-16 shrink-0";

export function ProtectionPane({ project }: { project: Project }) {
  const adoptProject = useProjectsStore((store) => store.adoptProject);
  const [saving, setSaving] = React.useState(false);
  // The one-time cue: a flip reaches the next attachment, never one running.
  // Said once, after the act, and kept for the rest of this visit.
  const [flipped, setFlipped] = React.useState(false);

  const override = project.authorityPolicy ?? null;
  const effective = React.useMemo(() => resolveAuthorityPolicy(override), [override]);
  const on = effective.enforcement === "enforce";

  /**
   * Merge one departure into the stored document and write the whole thing —
   * `authority-pane.tsx`'s `patch`, unchanged. Merge so fields this page draws
   * no control for survive; prune so a reverted field leaves no trace.
   */
  async function patch(change: Partial<AuthorityPolicyOverride>): Promise<boolean> {
    if (saving) return false;
    const next: AuthorityPolicyOverride = { ...override, ...change };
    for (const key of Object.keys(next) as (keyof AuthorityPolicyOverride)[]) {
      const value = next[key];
      if (value === undefined) delete next[key];
      else if (key !== "classifierModel" && isEmptyObject(value)) delete next[key];
    }
    setSaving(true);
    const saved = await writeThrough("save this project's protection", () =>
      window.api.projects.setAuthorityPolicy({
        id: project.id,
        override: Object.keys(next).length === 0 ? null : next,
      }),
    );
    setSaving(false);
    if (saved === null) return false;
    adoptProject(saved.project);
    return true;
  }

  /** One actor's departures, merged into the actor map rather than over it. */
  function patchActor(
    kind: AuthorityActorKind,
    peek: PeekDisclosure | undefined,
  ): Promise<boolean> {
    const actors = { ...override?.actors };
    const actor = { ...actors[kind] };
    if (peek === undefined) delete actor.peek;
    else actor.peek = peek;
    if (Object.keys(actor).length === 0) delete actors[kind];
    else actors[kind] = actor;
    return patch({ actors });
  }

  async function setProtection(next: boolean): Promise<void> {
    const ok = await patch(
      next
        ? { enforcement: "enforce" }
        : // Off removes containment too: a wall left standing under a page
          // that says "Agents run as you" would be governing invisibly.
          { enforcement: undefined, containment: undefined },
    );
    if (ok) setFlipped(true);
  }

  return (
    <>
      <section data-testid="protection-switch" className="rounded-lg bg-card px-4 py-4">
        <div className="flex items-start gap-3">
          {on ? (
            <ShieldCheckIcon
              aria-hidden
              weight="fill"
              className="size-6 shrink-0 text-primary-text"
            />
          ) : (
            <ShieldIcon aria-hidden className="size-6 shrink-0 text-muted-foreground" />
          )}
          <div className="min-w-0 flex-1">
            <h2 data-slot="pref-section-title" className="text-sm font-semibold">
              {on ? "Protection is on" : "Protection is off"}
            </h2>
            <p className="mt-1 text-ui text-muted-foreground">{on ? ON_TEXT : OFF_TEXT}</p>
            {flipped ? (
              <p role="status" className="mt-1 text-ui text-foreground">
                {FLIPPED_TEXT}
              </p>
            ) : null}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <OverrideControl
              label="Protection"
              inheritedValue="Off"
              overridden={
                override?.enforcement !== undefined || override?.containment !== undefined
              }
              disabled={saving}
              onRevert={() => void setProtection(false)}
            >
              <Switch
                aria-label="Protection"
                checked={on}
                disabled={saving}
                onCheckedChange={(next) => void setProtection(next)}
              />
            </OverrideControl>
          </div>
        </div>
      </section>

      <ApprovedActions projectId={project.id} />

      <Advanced
        peek={effective.actors.session.peek}
        overridden={override?.actors?.session?.peek !== undefined}
        saving={saving}
        onPeek={(peek) => void patchActor("session", peek)}
      />
    </>
  );
}

/* ------------------------------------------------------------ approved actions */

/** A ready list remembers which project it is for, so a late Undo cannot cross projects. */
interface ApprovalList {
  projectId: string;
  rows: readonly AuthorityApproval[];
}

function ApprovedActions({ projectId }: { projectId: string }) {
  const [state, setState] = React.useState<AsyncState<ApprovalList>>({ status: "loading" });
  const [filter, setFilter] = React.useState<ApprovalFilter>("all");
  const [expanded, setExpanded] = React.useState<string | null>(null);
  const [revoking, setRevoking] = React.useState<ReadonlySet<string>>(() => new Set());
  const fetcher = useLatestAsync();

  const load = React.useCallback(async () => {
    const token = fetcher.claim();
    setState({ status: "loading" });
    const fail = (reason: string) =>
      setState({
        status: "error",
        message: `Couldn't read approved actions: ${reason}`,
        onRetry: () => void load(),
      });
    try {
      const result = await window.api.protection.approvals(projectId);
      if (!fetcher.isCurrent(token)) return;
      if (!result.ok) fail(result.error);
      else setState({ status: "ready", data: { projectId, rows: result.approvals } });
    } catch (error) {
      if (fetcher.isCurrent(token)) fail(errorMessage(error));
    }
  }, [fetcher, projectId]);

  React.useEffect(() => {
    void load();
    return () => fetcher.invalidate();
  }, [load, fetcher]);

  function markRevoking(id: string, busy: boolean): void {
    setRevoking((current) => {
      const next = new Set(current);
      if (busy) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  async function restore(row: AuthorityApproval): Promise<void> {
    const restored = await writeThrough("restore that approval", () =>
      window.api.protection.restore(row.id),
    );
    if (restored === null) return;
    const approval = restored.approval;
    setState((current) => {
      if (current.status !== "ready" || current.data.projectId !== approval.projectId) {
        return current;
      }
      if (current.data.rows.some((existing) => existing.id === approval.id)) return current;
      const rows = [...current.data.rows, approval].toSorted((a, b) => b.createdAt - a.createdAt);
      return { status: "ready", data: { ...current.data, rows } };
    });
  }

  async function revoke(row: AuthorityApproval): Promise<void> {
    markRevoking(row.id, true);
    const revoked = await writeThrough("revoke that approval", () =>
      window.api.protection.revoke(row.id),
    );
    markRevoking(row.id, false);
    if (revoked === null) return;
    setState((current) =>
      current.status === "ready"
        ? {
            status: "ready",
            data: {
              ...current.data,
              rows: current.data.rows.filter((existing) => existing.id !== row.id),
            },
          }
        : current,
    );
    toast(`Revoked "${row.summary}". Agents will ask again next time.`, {
      action: { label: "Undo", onClick: () => void restore(row) },
    });
  }

  const rows = state.status === "ready" ? state.data.rows : [];
  const counts = {
    all: rows.length,
    project: rows.filter((row) => row.scope === "project").length,
    session: rows.filter((row) => row.scope === "session").length,
  };
  const uses = rows.reduce((sum, row) => sum + row.useCount, 0);
  const shown = filter === "all" ? rows : rows.filter((row) => row.scope === filter);

  return (
    <AsyncSection
      title="Approved actions"
      icon={ListChecksIcon}
      state={state}
      action={
        counts.all === 0 ? undefined : (
          <Segmented<ApprovalFilter>
            ariaLabel="Show approved actions"
            testId="protection-approvals-filter"
            value={filter}
            options={[
              { key: "all", label: `All ${counts.all}` },
              { key: "project", label: `This project ${counts.project}` },
              { key: "session", label: `Sessions ${counts.session}` },
            ]}
            onChange={setFilter}
          />
        )
      }
    >
      {() =>
        counts.all === 0 ? (
          <div data-testid="protection-approvals-empty" className="py-6 text-center text-ui">
            <p className="font-medium">{EMPTY_TITLE}</p>
            <p className="mt-1 text-muted-foreground">{EMPTY_TEXT}</p>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            <p data-testid="protection-approvals-summary" className="text-ui text-muted-foreground">
              {summaryLine(counts.all, uses)}
            </p>
            {/* The list scrolls in its own box so the page never does; seven
                rows fit before it starts. The column header rides INSIDE the
                box, sticky, so a scrollbar narrows header and rows alike. */}
            <div className="max-h-104 overflow-y-auto">
              <div
                aria-hidden
                className="sticky top-0 z-10 flex items-center gap-2 border-x border-b border-transparent border-b-border/50 bg-card px-2 pb-1 text-ui text-muted-foreground"
              >
                <span className="min-w-0 flex-1">Action</span>
                <span className={APPLIES_W}>Applies to</span>
                <span className={USED_W}>Used</span>
                <span className={REVOKE_W} />
              </div>
              {shown.length === 0 ? (
                <Empty>Nothing matches.</Empty>
              ) : (
                <ul aria-label="Approved actions">
                  {shown.map((row) => (
                    <ApprovalRow
                      key={row.id}
                      row={row}
                      open={expanded === row.id}
                      revoking={revoking.has(row.id)}
                      onToggle={() =>
                        setExpanded((current) => (current === row.id ? null : row.id))
                      }
                      onRevoke={() => void revoke(row)}
                    />
                  ))}
                </ul>
              )}
            </div>
          </div>
        )
      }
    </AsyncSection>
  );
}

/** The progressive cue: how much asking the ledger has already saved. */
function summaryLine(approved: number, uses: number): string {
  return `${approved} approved \u00b7 passed ${uses} ${uses === 1 ? "request" : "requests"} without asking`;
}

function ApprovalRow({
  row,
  open,
  revoking,
  onToggle,
  onRevoke,
}: {
  row: AuthorityApproval;
  open: boolean;
  revoking: boolean;
  onToggle: () => void;
  onRevoke: () => void;
}) {
  const detailId = `protection-approval-${row.id}`;
  const { ticketDisplayId, sessionTitle } = row.provenance;
  const used =
    row.lastUsedAt === null
      ? `${row.useCount}\u00d7`
      : `${row.useCount}\u00d7 \u00b7 ${relativeTime(row.lastUsedAt)}`;

  return (
    <li data-testid="protection-approval" data-approval-id={row.id}>
      <ListRow
        density="two-line"
        selected={open}
        aria-expanded={open}
        aria-controls={open ? detailId : undefined}
        onActivate={onToggle}
        primary={
          <span title={row.summary} className="min-w-0 truncate text-ui font-medium">
            {row.summary}
          </span>
        }
        secondary={`${ticketDisplayId ?? "No ticket"} \u00b7 ${sessionTitle ?? "Session"} \u00b7 approved ${relativeTime(row.createdAt)}`}
        trailing={
          <>
            <span className={cn(APPLIES_W, "text-ui text-muted-foreground")}>
              {row.scope === "project" ? "This project" : "This Session"}
            </span>
            <span className={cn(USED_W, "flex flex-col text-ui text-muted-foreground")}>
              <span className="truncate">{used}</span>
              {row.lastUsedBySessionId === null ? null : (
                <span className="truncate text-muted-foreground/70">inherited by a subagent</span>
              )}
            </span>
          </>
        }
        actions={
          <Button
            size="xs"
            variant="ghost"
            aria-label={`Revoke ${row.summary}`}
            disabled={revoking}
            onClick={onRevoke}
            className={cn(
              REVOKE_W,
              "opacity-0 transition-opacity duration-150 group-focus-within:opacity-100 group-hover:opacity-100 focus-visible:opacity-100 motion-reduce:transition-none",
            )}
          >
            Revoke
          </Button>
        }
      />
      {open ? <Provenance id={detailId} row={row} /> : null}
    </li>
  );
}

function Provenance({ id, row }: { id: string; row: AuthorityApproval }) {
  const { asked, reason, sessionTitle, ticketDisplayId } = row.provenance;
  const at = new Date(row.createdAt);
  const date = at.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  const time = at.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const where = `${sessionTitle ?? "a Session"}${ticketDisplayId === null ? "" : ` (${ticketDisplayId})`}`;

  return (
    <dl id={id} className="flex flex-col gap-2 px-3 pt-1 pb-3 text-ui">
      <div className="flex gap-3">
        <dt className="w-20 shrink-0 text-muted-foreground">Asked</dt>
        <dd className="min-w-0 flex-1">
          <pre className="max-h-24 overflow-auto font-mono text-ui whitespace-pre-wrap break-all">
            {asked}
          </pre>
        </dd>
      </div>
      <div className="flex gap-3">
        <dt className="w-20 shrink-0 text-muted-foreground">Stopped by</dt>
        <dd className="min-w-0 flex-1">{reason}</dd>
      </div>
      <div className="flex gap-3">
        <dt className="w-20 shrink-0 text-muted-foreground">Approved</dt>
        <dd className="min-w-0 flex-1">
          By you, {date} at {time}, on the card in {where}
        </dd>
      </div>
    </dl>
  );
}

/* -------------------------------------------------------------------- advanced */

function Advanced({
  peek,
  overridden,
  saving,
  onPeek,
}: {
  peek: PeekDisclosure;
  overridden: boolean;
  saving: boolean;
  onPeek: (peek: PeekDisclosure | undefined) => void;
}) {
  const [open, setOpen] = React.useState(false);
  const label = "Transcripts a Session can read";

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <section className="rounded-lg bg-card px-4 py-3">
        <h2 className="text-sm font-semibold">
          <CollapsibleTrigger asChild>
            <button
              type="button"
              className="flex w-full items-center gap-2 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <CaretDownIcon
                aria-hidden
                className={cn(
                  "size-4 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none",
                  !open && "-rotate-90",
                )}
              />
              <span data-slot="pref-section-title">Advanced</span>
            </button>
          </CollapsibleTrigger>
        </h2>
        <CollapsibleContent>
          <div className="mt-3 border-t border-border/50 pt-4">
            <PrefRow
              label={label}
              htmlFor="protection-peek-session"
              testId="protection-peek-session"
            >
              <OverrideControl
                label={label}
                inheritedValue={peekLabel(DEFAULT_AUTHORITY_POLICY.actors.session.peek)}
                overridden={overridden}
                disabled={saving}
                onRevert={() => onPeek(undefined)}
              >
                <Select
                  value={peek}
                  disabled={saving}
                  onValueChange={(next) => onPeek(next as PeekDisclosure)}
                >
                  <SelectTrigger id="protection-peek-session" className={CONTROL_W.md}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {PEEK_OPTIONS.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </OverrideControl>
            </PrefRow>
          </div>
        </CollapsibleContent>
      </section>
    </Collapsible>
  );
}

function isEmptyObject(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === 0
  );
}
