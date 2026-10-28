import * as React from "react";
import type {
  CloudMovePreflight,
  CloudMoveProject,
  CloudMoveSnapshot,
  CloudMovesApi,
} from "@volli/shared";
import { AccountPane } from "@renderer/components/settings/panes/account-pane";
import { Button } from "@renderer/components/ui/button";
import { Checkbox } from "@renderer/components/ui/checkbox";
import { DialogFooter } from "@renderer/components/ui/dialog";
import { formatFileSize } from "@renderer/components/attachments/attachment-model";
import { closeCloudMoves, showCloudMoves } from "@renderer/stores/cloud-moves";
import { useProjectsStore } from "@renderer/stores/projects";
import { useProjectUiStore } from "@renderer/stores/project-ui";
import { useUiStore } from "@renderer/stores/ui";
import { toastError } from "@renderer/lib/toast";
import { moveTime } from "./presentation";

export function MovePreflight({
  api,
  snapshot,
  projectIds,
}: {
  api: CloudMovesApi;
  snapshot: CloudMoveSnapshot;
  projectIds?: string[];
}) {
  const [workspaceId, setWorkspaceId] = React.useState(
    () => snapshot.workspaces.find((item) => item.canMove)?.id ?? "",
  );
  const [includeRemoved, setIncludeRemoved] = React.useState(false);
  const [flight, setFlight] = React.useState<CloudMovePreflight | null>(null);
  const [preparedScope, setPreparedScope] = React.useState<string | null>(null);
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [stopAtFirstProblem, setStopAtFirstProblem] = React.useState(true);
  const [reading, setReading] = React.useState(true);
  const [starting, setStarting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [run, setRun] = React.useState(0);
  // Sign-in can finish with this sheet open. A target change invalidates the dry run immediately.
  const target =
    snapshot.workspaces.find((item) => item.id === workspaceId && item.canMove)?.id ??
    snapshot.workspaces.find((item) => item.canMove)?.id ??
    null;
  const scope = JSON.stringify([target, includeRemoved, snapshot.account?.userId ?? null, run]);
  React.useEffect(() => {
    let active = true;
    setReading(true);
    setFlight(null);
    setError(null);
    void api
      .preflight({
        ...(projectIds === undefined ? {} : { projectIds }),
        workspaceId: target,
        includeRemoved,
      })
      .then((next) => {
        if (!active) return;
        setFlight(next);
        setPreparedScope(scope);
        setSelected(
          new Set(
            next.projects.filter((item) => item.blockers.length === 0).map((item) => item.id),
          ),
        );
        setStopAtFirstProblem(next.stopAtFirstProblem);
      })
      .catch(() => {
        if (active) setError("Couldn't check these projects. Run the dry run again.");
      })
      .finally(() => {
        if (active) setReading(false);
      });
    return () => {
      active = false;
    };
  }, [api, projectIds, target, includeRemoved, scope]);

  const projects = flight?.projects.filter((item) => selected.has(item.id)) ?? [];
  const enoughSpace = flight !== null && flight.disk.freeBytes >= flight.disk.requiredBytes;
  const canStart =
    !reading &&
    !starting &&
    preparedScope === scope &&
    snapshot.account !== null &&
    snapshot.unavailable === null &&
    target !== null &&
    projects.length > 0 &&
    projects.every((item) => item.blockers.length === 0) &&
    enoughSpace;
  async function start() {
    if (!canStart || flight === null || target === null) return;
    setStarting(true);
    try {
      await api.start({
        preflightId: flight.id,
        workspaceId: target,
        projectIds: projects.map((item) => item.id),
        stopAtFirstProblem,
      });
      showCloudMoves();
    } catch {
      toastError("Couldn't start the move. Run the dry run again, then retry.");
    } finally {
      setStarting(false);
    }
  }
  return (
    <>
      <div className="flex max-h-[60vh] flex-col gap-4 overflow-y-auto text-ui" aria-busy={reading}>
        {snapshot.account === null ? (
          <AccountPane />
        ) : (
          <div className="flex items-center justify-between gap-2">
            <span>{snapshot.account.displayName}</span>
            <label className="flex items-center gap-2">
              Workspace
              <select
                aria-label="Workspace"
                className="rounded-control border border-input bg-background px-2 py-1"
                value={target ?? ""}
                disabled={starting}
                onChange={(event) => setWorkspaceId(event.target.value)}
              >
                {snapshot.workspaces
                  .filter((item) => item.canMove)
                  .map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
              </select>
            </label>
          </div>
        )}
        {snapshot.unavailable !== null ? <p role="status">{snapshot.unavailable}</p> : null}
        {projectIds === undefined ? (
          <label className="flex items-center gap-2">
            <Checkbox
              checked={includeRemoved}
              disabled={starting}
              onCheckedChange={(value) => setIncludeRemoved(value === true)}
            />
            Include removed projects
          </label>
        ) : null}
        {reading ? (
          <p role="status">Checking projects… The snapshot cannot stop immediately.</p>
        ) : null}
        {error !== null ? <p role="alert">{error}</p> : null}
        {flight !== null && !reading ? (
          <>
            {flight.projects.length === 0 ? (
              <p>No local projects to move.</p>
            ) : (
              <div className="flex flex-col gap-4">
                {flight.projects.map((project) => (
                  <ProjectSummary
                    key={project.id}
                    project={project}
                    selected={selected.has(project.id)}
                    disabled={starting}
                    onSelect={(checked) =>
                      setSelected((before) => {
                        const next = new Set(before);
                        if (checked) next.add(project.id);
                        else next.delete(project.id);
                        return next;
                      })
                    }
                  />
                ))}
              </div>
            )}
            <section aria-label="What stays on this Mac" className="flex flex-col gap-2">
              <h3 className="font-medium">What stays on this Mac</h3>
              <ul className="list-inside list-disc text-muted-foreground">
                <li>Secrets and API keys — re-enter them on other machines or for teammates.</li>
                <li>Skills and templates — files on this Mac.</li>
                {flight.exclusions.map((item) => (
                  <li key={item.label}>
                    {item.label}
                    {item.count === undefined ? "" : ` (${item.count})`} — {item.reason}
                  </li>
                ))}
              </ul>
            </section>
            <p>
              Ticket Sessions become visible to people you invite to this Workspace; Board and
              ad-hoc chats stay private.
            </p>
            <section aria-label="Safety" className="flex flex-col gap-2">
              <h3 className="font-medium">Backup first</h3>
              <p>
                A full backup is made and checked first. Each project is read-only while it moves.
                Its local copy is kept.
              </p>
              <p className="break-all text-muted-foreground">{flight.backupDirectory}</p>
              <p role={enoughSpace ? undefined : "alert"}>
                {formatFileSize(flight.disk.requiredBytes)} needed ·{" "}
                {formatFileSize(flight.disk.freeBytes)} free
              </p>
              <p>Don’t install an older Volli build during a move.</p>
            </section>
            <label className="flex items-center gap-2">
              <Checkbox
                checked={stopAtFirstProblem}
                disabled={starting}
                onCheckedChange={(value) => setStopAtFirstProblem(value === true)}
              />
              Stop at the first problem
            </label>
          </>
        ) : null}
      </div>
      <DialogFooter>
        <Button variant="ghost" disabled={starting} onClick={closeCloudMoves}>
          Cancel
        </Button>
        <Button
          variant="outline"
          disabled={reading || starting}
          onClick={() => setRun((value) => value + 1)}
        >
          Run a dry run only
        </Button>
        <Button disabled={!canStart} onClick={() => void start()}>
          {starting ? "Starting…" : "Move"}
        </Button>
      </DialogFooter>
    </>
  );
}

function ProjectSummary({
  project,
  selected,
  disabled,
  onSelect,
}: {
  project: CloudMoveProject;
  selected: boolean;
  disabled: boolean;
  onSelect(checked: boolean): void;
}) {
  const { counts } = project;
  return (
    <section
      className="flex flex-col gap-2 rounded-control border border-border p-2"
      aria-label={project.name}
    >
      <label className="flex items-center gap-2 font-medium">
        <Checkbox
          aria-label={`Move ${project.name}`}
          checked={selected}
          disabled={disabled || project.blockers.length > 0}
          onCheckedChange={(value) => onSelect(value === true)}
        />
        {project.name}
        {project.removed ? " · Removed" : ""}
      </label>
      <p>
        {counts.tickets.toLocaleString()} tickets · {counts.sessions.toLocaleString()} Sessions ·{" "}
        {counts.events.toLocaleString()} events
      </p>
      <p className="text-muted-foreground">
        {counts.attachments.toLocaleString()} attachments ({formatFileSize(counts.attachmentBytes)})
        · Transcripts {formatFileSize(counts.transcriptBytes)} · Pi logs{" "}
        {formatFileSize(counts.piLogBytes)}
      </p>
      <p className="text-muted-foreground">{moveTime(project.estimateSeconds)}</p>
      {project.blockers.length > 0 ? (
        <div role="status">
          <h4 className="font-medium">Needs you first</h4>
          {project.blockers.map((blocker) => (
            <div
              key={`${blocker.message}:${blocker.sessionId ?? blocker.ticketId ?? "project"}`}
              className="flex items-center justify-between gap-2"
            >
              <span>{blocker.message}</span>
              {blocker.sessionId || blocker.ticketId ? (
                <Button
                  size="xs"
                  variant="outline"
                  onClick={() => {
                    closeCloudMoves();
                    useProjectsStore.getState().select(project.id);
                    useUiStore.getState().setSettingsOpen(false);
                    if (blocker.sessionId)
                      useUiStore.getState().openSessionDetail(project.id, blocker.sessionId);
                    else if (blocker.ticketId)
                      useProjectUiStore.getState().openTicketView(project.id, blocker.ticketId);
                  }}
                >
                  Open {blocker.sessionId ? "Session" : "ticket"}
                </Button>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
      {project.warnings.map((warning) => (
        <p key={warning} role="status">
          {warning}
        </p>
      ))}
      {project.exclusions.length > 0 ? (
        <details>
          <summary>Excluded items</summary>
          <ul className="list-inside list-disc">
            {project.exclusions.map((item) => (
              <li key={item.label}>
                {item.label}
                {item.count === undefined ? "" : ` (${item.count})`} — {item.reason}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}
