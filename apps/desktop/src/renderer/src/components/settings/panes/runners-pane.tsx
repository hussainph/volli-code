/**
 * Settings → Runners (VC-895): the person's runners, this Mac among them.
 * Each row shows its name, kind, status and reported version; this Mac is
 * marked. Linux rows with update policy offer one-shot and automatic updates.
 * Remove is the one irreversible action, so it is the one confirm.
 *
 * This Mac's own registration is main's (`use-runners.ts`): when it is
 * blocked (removed, or its registration failed) the pane shows why and the
 * one action that recovers it; while it is being added or connected, a
 * quiet label says so. Every other runner is read and written through the
 * window's own Volli Cloud client. Below the list, whether this Mac stays
 * available when Volli is closed (`runner-availability.tsx`).
 *
 * Shown only in a Volli Cloud launch: the category does not exist otherwise.
 */
import * as React from "react";
import { ArrowClockwiseIcon } from "@phosphor-icons/react/dist/csr/ArrowClockwise";
import { ArrowsClockwiseIcon } from "@phosphor-icons/react/dist/csr/ArrowsClockwise";
import { CloudIcon } from "@phosphor-icons/react/dist/csr/Cloud";
import { DotsThreeIcon } from "@phosphor-icons/react/dist/csr/DotsThree";
import { HardDrivesIcon } from "@phosphor-icons/react/dist/csr/HardDrives";
import { LaptopIcon } from "@phosphor-icons/react/dist/csr/Laptop";
import { LinuxLogoIcon } from "@phosphor-icons/react/dist/csr/LinuxLogo";
import { PencilSimpleIcon } from "@phosphor-icons/react/dist/csr/PencilSimple";
import { TrashIcon } from "@phosphor-icons/react/dist/csr/Trash";
import type { Icon as PhosphorIcon } from "@phosphor-icons/react";
import type { ThisMacRunnerSnapshot } from "@volli/shared";
import { runnerPlaceAvailability } from "@volli/shared/cloud";

import { Empty, Health, PrefSection, SectionAction } from "@renderer/components/settings/kit";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@renderer/components/ui/alert-dialog";
import { Badge } from "@renderer/components/ui/badge";
import { Button } from "@renderer/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuCheckboxItem,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@renderer/components/ui/dropdown-menu";
import { InlineRename } from "@renderer/components/ui/inline-rename";
import { ListRow } from "@renderer/components/ui/list-row";
import { toastError } from "@renderer/lib/toast";

import { cloudLaunchNow } from "@renderer/stores/launch";
import { useUpdateStore } from "@renderer/stores/update";
import { AddRunnerSheet } from "./add-runner-sheet";
import { AlwaysOnRunnerSheet } from "./always-on-runner-sheet";
import { LinkRunnerSheet } from "./link-runner-sheet";
import { runnerSetup } from "./runner-setup";
import { runnerInstallTarget } from "./runner-install-target";
import { RunnerAvailability } from "./runner-availability";

// Public build metadata only; no deployment credential reaches the renderer.
declare const VOLLI_RUNNER_INSTALL_SITE_URL: string | null;
import {
  runnerStatus,
  thisMacRecovery,
  thisMacStatus,
  useRunners,
  type RunnerCommands,
  type RunnerRow,
  type StatusWord,
} from "./use-runners";

const KIND_ICON: Record<string, PhosphorIcon> = {
  mac: LaptopIcon,
  linux: LinuxLogoIcon,
  cloud: CloudIcon,
};

const messageOf = (error: unknown): string =>
  error instanceof Error && error.message !== "" ? error.message : "That didn’t work.";

/** Runs a command; a failure is a toast that says what failed and what came back. */
function act(run: () => Promise<unknown>, what: string): void {
  run().catch((error: unknown) => toastError(`${what}: ${messageOf(error)}`));
}

/** The runner a confirm is about: kept while the dialog fades out, so its words do not change. */
interface Removing {
  readonly runner: RunnerRow;
  readonly thisMac: boolean;
}

/** `rpc` and the client are a test's to replace; the window passes nothing. */
export function RunnersPane(props: Parameters<typeof useRunners>[0] = {}) {
  const { thisMac, runners, commands, retry } = useRunners(props);
  const [removing, setRemoving] = React.useState<Removing | null>(null);
  const [confirming, setConfirming] = React.useState(false);
  const [sheet, setSheet] = React.useState<"add" | "link" | "always-on" | null>(null);
  const sheetOpener = React.useRef<HTMLButtonElement | null>(null);
  const restoreFocus = React.useCallback(() => {
    sheetOpener.current?.focus();
  }, []);
  const { current } = props;
  const setup = React.useMemo(() => runnerSetup(current), [current]);
  const appVersion = useUpdateStore((state) => state.state?.currentVersion ?? null);
  const launch = cloudLaunchNow();
  const siteUrl = launch?.siteUrl ?? null;
  const packagedSite =
    typeof VOLLI_RUNNER_INSTALL_SITE_URL === "undefined" ? null : VOLLI_RUNNER_INSTALL_SITE_URL;
  const installTarget = runnerInstallTarget({
    appVersion,
    siteUrl,
    packagedSiteUrl: packagedSite,
    deployment: launch?.deployment,
  });
  const snapshot = thisMac.kind === "ready" ? thisMac.value : null;

  const failed = runners.kind === "failed" || thisMac.kind === "failed";
  // The section's one action: Retry, after a failed read.
  const action = failed ? <SectionAction label="Retry" onAct={retry} /> : undefined;

  return (
    <>
      {snapshot === null ? null : <ThisMacBlocked snapshot={snapshot} commands={commands} />}
      <PrefSection title="Runners" icon={HardDrivesIcon} action={action}>
        {runners.kind === "loading" ? (
          <Empty>Loading runners…</Empty>
        ) : runners.kind === "failed" ? (
          <Empty>{runners.message}</Empty>
        ) : (
          <>
            {thisMac.kind === "failed" ? (
              <p role="alert" className="text-ui text-destructive">
                {thisMac.message}
              </p>
            ) : null}
            <RunnerList
              rows={runners.value}
              snapshot={snapshot}
              commands={commands}
              onRemove={(runner, isThisMac) => {
                setRemoving({ runner, thisMac: isThisMac });
                setConfirming(true);
              }}
            />
          </>
        )}
      </PrefSection>
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={installTarget === null}
          onClick={(event) => {
            sheetOpener.current = event.currentTarget;
            setSheet("add");
          }}
        >
          Add a runner
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={(event) => {
            sheetOpener.current = event.currentTarget;
            setSheet("link");
          }}
        >
          Link a runner
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={installTarget === null}
          onClick={(event) => {
            sheetOpener.current = event.currentTarget;
            setSheet("always-on");
          }}
        >
          Get an always-on runner
        </Button>
      </div>
      <RunnerAvailability />
      {sheet === "link" ? (
        <LinkRunnerSheet setup={setup} restoreFocus={restoreFocus} onClose={() => setSheet(null)} />
      ) : null}
      {sheet === "add" && installTarget !== null ? (
        <AddRunnerSheet
          setup={setup}
          {...installTarget}
          restoreFocus={restoreFocus}
          onClose={() => setSheet(null)}
        />
      ) : null}
      {sheet === "always-on" && installTarget !== null ? (
        <AlwaysOnRunnerSheet
          setup={setup}
          {...installTarget}
          restoreFocus={restoreFocus}
          onClose={() => setSheet(null)}
        />
      ) : null}
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {removing?.thisMac === true ? "Remove this Mac?" : `Remove ${removing?.runner.name}?`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {removing?.thisMac === true
                ? "Its credential is deleted and Sessions stop running here until you add it again."
                : "Its credential is deleted and it stops running Sessions at once."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel size="sm">Cancel</AlertDialogCancel>
            <AlertDialogAction
              size="sm"
              variant="destructive"
              onClick={() => {
                if (removing === null) return;
                const { runner } = removing;
                act(
                  removing.thisMac ? commands.removeThisMac : () => commands.remove(runner.id),
                  `Couldn’t remove ${runner.name}`,
                );
              }}
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

/** A blocked Mac: why, in the snapshot's own sentence, and the one action that recovers it. */
function ThisMacBlocked({
  snapshot,
  commands,
}: {
  snapshot: ThisMacRunnerSnapshot;
  commands: RunnerCommands;
}) {
  const recovery = thisMacRecovery(snapshot);
  if (recovery === null) return null;
  return (
    <PrefSection title="This Mac" icon={LaptopIcon}>
      <div className="flex items-center justify-between gap-6" data-testid="this-mac-blocked">
        <p
          role={recovery.failed ? "alert" : "status"}
          className={recovery.failed ? "text-ui text-destructive" : "text-ui text-muted-foreground"}
        >
          {snapshot.message ?? (recovery.failed ? "This Mac couldn’t be added." : "Removed.")}
        </p>
        <Button
          size="sm"
          variant="outline"
          onClick={() => act(commands.addThisMac, "Couldn’t add this Mac")}
        >
          {recovery.label}
        </Button>
      </div>
    </PrefSection>
  );
}

function RunnerList({
  rows,
  snapshot,
  commands,
  onRemove,
}: {
  rows: readonly RunnerRow[];
  snapshot: ThisMacRunnerSnapshot | null;
  commands: RunnerCommands;
  onRemove: (runner: RunnerRow, thisMac: boolean) => void;
}) {
  const thisMacId = snapshot?.runnerId ?? null;
  // This Mac first, the rest in the backend's order (by name).
  const ordered = React.useMemo(
    () => [
      ...rows.filter((row) => row.id === thisMacId),
      ...rows.filter((row) => row.id !== thisMacId),
    ],
    [rows, thisMacId],
  );
  const local = snapshot === null ? null : thisMacStatus(snapshot);
  // Being added, and not in the list yet: a quiet row says so.
  const pending =
    snapshot !== null &&
    local !== null &&
    snapshot.state !== "offline" &&
    !rows.some((row) => row.id === thisMacId)
      ? { name: snapshot.runnerName ?? "This Mac", status: local }
      : null;
  if (ordered.length === 0 && pending === null) return <Empty>No runners yet.</Empty>;
  return (
    <div className="flex flex-col">
      {pending === null ? null : (
        <ListRow
          data-testid="runner-this-mac-pending"
          density="row"
          leading={<KindGlyph kind="mac" />}
          primary={pending.name}
          primaryTrailing={<Badge variant="outline">This Mac</Badge>}
          trailing={<Health state={pending.status.state}>{pending.status.label}</Health>}
          onActivate={null}
        />
      )}
      {ordered.map((runner) => {
        const isThisMac = runner.id === thisMacId;
        return (
          <RunnerItem
            key={runner.id}
            runner={runner}
            thisMac={isThisMac}
            status={(isThisMac ? local : null) ?? runnerStatus(runner)}
            commands={commands}
            onRemove={() => onRemove(runner, isThisMac)}
          />
        );
      })}
    </div>
  );
}

function KindGlyph({ kind }: { kind: string }) {
  const Icon = KIND_ICON[kind] ?? HardDrivesIcon;
  return <Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />;
}

function RunnerItem({
  runner,
  thisMac,
  status,
  commands,
  onRemove,
}: {
  runner: RunnerRow;
  thisMac: boolean;
  status: StatusWord;
  commands: RunnerCommands;
  onRemove: () => void;
}) {
  const [editing, setEditing] = React.useState(false);
  const [updating, setUpdating] = React.useState(false);
  const updatePending = React.useRef(false);
  const updateDisabled = updating || runnerPlaceAvailability(runner).kind === "removed";
  const update = (run: () => Promise<unknown>, what: string) => {
    if (updatePending.current) return;
    updatePending.current = true;
    setUpdating(true);
    act(async () => {
      try {
        await run();
      } finally {
        updatePending.current = false;
        setUpdating(false);
      }
    }, what);
  };
  return (
    <ListRow
      data-testid={`runner-${runner.id}`}
      density={runner.version ? "two-line" : "row"}
      leading={<KindGlyph kind={runner.kind} />}
      primary={
        editing ? (
          <InlineRename
            value={runner.name}
            ariaLabel="Runner name"
            className="w-48"
            onCommit={(next) => {
              setEditing(false);
              act(() => commands.rename(runner.id, next), `Couldn’t rename ${runner.name}`);
            }}
            onCancel={() => setEditing(false)}
          />
        ) : (
          runner.name
        )
      }
      primaryTrailing={thisMac ? <Badge variant="outline">This Mac</Badge> : undefined}
      secondary={
        runner.version
          ? `Version ${runner.version}${runner.autoUpdate?.pinnedVersion ? ` · Update to ${runner.autoUpdate.pinnedVersion} requested` : ""}`
          : undefined
      }
      trailing={<Health state={status.state}>{status.label}</Health>}
      actions={
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label={`More for ${runner.name}`}
              className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100"
            >
              <DotsThreeIcon weight="bold" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {runner.kind === "linux" && runner.autoUpdate !== undefined ? (
              <>
                <DropdownMenuItem
                  disabled={updateDisabled}
                  onSelect={() =>
                    update(() => commands.updateNow(runner.id), `Couldn’t update ${runner.name}`)
                  }
                >
                  <ArrowClockwiseIcon />
                  Update now
                </DropdownMenuItem>
                <DropdownMenuCheckboxItem
                  checked={runner.autoUpdate.enabled}
                  disabled={updateDisabled}
                  onCheckedChange={(enabled) =>
                    update(
                      () => commands.setAutoUpdate(runner.id, enabled),
                      `Couldn’t change automatic updates for ${runner.name}`,
                    )
                  }
                >
                  <ArrowsClockwiseIcon />
                  Automatic updates
                </DropdownMenuCheckboxItem>
                <DropdownMenuSeparator />
              </>
            ) : null}
            <DropdownMenuItem onSelect={() => setEditing(true)}>
              <PencilSimpleIcon />
              Rename
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onSelect={onRemove}>
              <TrashIcon />
              Remove…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      }
      onActivate={null}
    />
  );
}
