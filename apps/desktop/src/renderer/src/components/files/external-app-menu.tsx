import * as React from "react";
import {
  ExternalIcon,
  ChevronDownIcon,
  CodeIcon,
  FolderOpenIcon,
  TerminalIcon,
} from "@renderer/components/ui/icon";

import { errorMessage } from "@volli/shared";
import type { ExternalApp, ExternalAppId } from "../../../../ipc/contract";

import { Button } from "@renderer/components/ui/button";
import { ButtonGroup } from "@renderer/components/ui/button-group";
import {
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from "@renderer/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@renderer/components/ui/dropdown-menu";
import { toastError } from "@renderer/lib/toast";
import { useUiStore } from "@renderer/stores/ui";

import { useExternalApps } from "./external-app-discovery";

export type ExternalAppTarget =
  | { kind: "file"; projectId: string; ticketId?: string; relPath: string }
  | { kind: "worktree"; projectId: string; ticketId: string };

export type ExternalAppMenuEntry = { kind: "app"; app: ExternalApp } | { kind: "finder" };

/**
 * The empty state is Finder alone — no unavailable-app placeholder or error
 * copy. That holds for a scan that found nothing AND for one that could not
 * run: Files falls back to Finder, and Integrations carries the failure and
 * its retry (see `external-app-discovery.tsx`).
 */
export function externalAppMenuEntries(
  apps: readonly ExternalApp[],
): readonly ExternalAppMenuEntry[] {
  return [...apps.map((app) => ({ kind: "app" as const, app })), { kind: "finder" }];
}

/** A stored preference is actionable only while Launch Services still lists it. */
export function preferredExternalApp(
  apps: readonly ExternalApp[],
  defaultExternalAppId: ExternalAppId | null,
): ExternalApp | null {
  if (defaultExternalAppId === null) return null;
  return apps.find((app) => app.id === defaultExternalAppId) ?? null;
}

function useExternalAppActions(target: ExternalAppTarget) {
  const open = React.useCallback(
    async (app: ExternalApp) => {
      try {
        const result =
          target.kind === "file"
            ? await window.api.files.openInExternalApp({
                projectId: target.projectId,
                ticketId: target.ticketId,
                relPath: target.relPath,
                appId: app.id,
              })
            : await window.api.files.openWorktreeInExternalApp({
                projectId: target.projectId,
                ticketId: target.ticketId,
                appId: app.id,
              });
        if (!result.ok) toastError(`Couldn't open in ${app.label}: ${result.error}`);
      } catch (error) {
        toastError(`Couldn't open in ${app.label}: ${errorMessage(error)}`);
      }
    },
    [target],
  );

  const reveal = React.useCallback(async () => {
    try {
      const result =
        target.kind === "file"
          ? await window.api.files.reveal({
              projectId: target.projectId,
              ticketId: target.ticketId,
              relPath: target.relPath,
            })
          : await window.api.files.revealWorktree({
              projectId: target.projectId,
              ticketId: target.ticketId,
            });
      if (!result.ok) toastError(`Couldn't reveal in Finder: ${result.error}`);
    } catch (error) {
      toastError(`Couldn't reveal in Finder: ${errorMessage(error)}`);
    }
  }, [target]);

  return { open, reveal };
}

/** A Files context menu: one direct default, or the full chooser when the preference asks. */
export function ExternalAppContextMenu({
  target,
  label = target.kind === "worktree" ? "Open worktree in…" : "Open in…",
}: {
  target: ExternalAppTarget;
  label?: string;
}) {
  // A failed scan leaves the last confirmed apps here rather than an empty
  // menu: recovery is Integrations' single Try again, not one per menu.
  const apps = useExternalApps();
  const defaultExternalAppId = useUiStore((store) => store.defaultExternalAppId);
  const defaultApp = preferredExternalApp(apps, defaultExternalAppId);
  const selectableApps =
    defaultApp === null ? apps : apps.filter((app) => app.id !== defaultApp.id);
  const entries = externalAppMenuEntries(selectableApps);
  const { open, reveal } = useExternalAppActions(target);

  return (
    <>
      {defaultApp !== null ? (
        <>
          <ContextMenuItem icon={ExternalIcon} onSelect={() => void open(defaultApp)}>
            Open in {defaultApp.label}
          </ContextMenuItem>
          <ContextMenuSeparator />
        </>
      ) : null}
      <ContextMenuSub>
        <ContextMenuSubTrigger icon={ExternalIcon}>
          {defaultApp === null ? label : "Open in another app…"}
        </ContextMenuSubTrigger>
        <ContextMenuSubContent>
          {entries.map((entry) => {
            if (entry.kind === "finder") {
              return (
                <React.Fragment key="finder">
                  {selectableApps.length > 0 ? <ContextMenuSeparator /> : null}
                  <ContextMenuItem icon={FolderOpenIcon} onSelect={() => void reveal()}>
                    Reveal in Finder
                  </ContextMenuItem>
                </React.Fragment>
              );
            }
            const Icon = entry.app.kind === "editor" ? CodeIcon : TerminalIcon;
            return (
              <ContextMenuItem key={entry.app.id} icon={Icon} onSelect={() => void open(entry.app)}>
                {entry.app.label}
              </ContextMenuItem>
            );
          })}
        </ContextMenuSubContent>
      </ContextMenuSub>
    </>
  );
}

/** The repository card's Open control: direct for a default, a chooser when asked. */
export function ExternalAppDropdownMenu({
  target,
  label = target.kind === "worktree" ? "Open worktree in…" : "Open in…",
}: {
  target: ExternalAppTarget;
  label?: string;
}) {
  const apps = useExternalApps();
  const defaultExternalAppId = useUiStore((store) => store.defaultExternalAppId);
  const defaultApp = preferredExternalApp(apps, defaultExternalAppId);
  const selectableApps =
    defaultApp === null ? apps : apps.filter((app) => app.id !== defaultApp.id);
  const entries = externalAppMenuEntries(selectableApps);
  const { open, reveal } = useExternalAppActions(target);
  const choices = (
    <DropdownMenuContent align="end">
      {entries.map((entry) => {
        if (entry.kind === "finder") {
          return (
            <React.Fragment key="finder">
              {selectableApps.length > 0 ? <DropdownMenuSeparator /> : null}
              <DropdownMenuItem onSelect={() => void reveal()}>Reveal in Finder</DropdownMenuItem>
            </React.Fragment>
          );
        }
        return (
          <DropdownMenuItem key={entry.app.id} onSelect={() => void open(entry.app)}>
            {entry.app.label}
          </DropdownMenuItem>
        );
      })}
    </DropdownMenuContent>
  );

  if (defaultApp !== null) {
    const defaultLabel = `Open in ${defaultApp.label}`;
    return (
      <ButtonGroup aria-label={defaultLabel}>
        <Button
          size="xs"
          variant="toolbar"
          aria-label={defaultLabel}
          onClick={() => void open(defaultApp)}
          title={defaultLabel}
        >
          <ExternalIcon />
          Open
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              size="icon-xs"
              variant="toolbar"
              aria-label="Choose another app"
              title="Choose another app"
            >
              <ChevronDownIcon strokeWidth={2.25} className="size-3" />
            </Button>
          </DropdownMenuTrigger>
          {choices}
        </DropdownMenu>
      </ButtonGroup>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="xs" variant="toolbar" className="shrink-0" aria-label={label} title={label}>
          <ExternalIcon />
          Open
          <ChevronDownIcon strokeWidth={2.25} className="size-3" />
        </Button>
      </DropdownMenuTrigger>
      {choices}
    </DropdownMenu>
  );
}
