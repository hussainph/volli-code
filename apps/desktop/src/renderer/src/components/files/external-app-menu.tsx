import * as React from "react";
import { ArrowSquareOutIcon } from "@phosphor-icons/react/dist/csr/ArrowSquareOut";
import { CaretDownIcon } from "@phosphor-icons/react/dist/csr/CaretDown";
import { CodeIcon } from "@phosphor-icons/react/dist/csr/Code";
import { FolderOpenIcon } from "@phosphor-icons/react/dist/csr/FolderOpen";
import { TerminalWindowIcon } from "@phosphor-icons/react/dist/csr/TerminalWindow";
import { errorMessage } from "@volli/shared";
import type { ExternalApp } from "../../../../ipc/contract";

import { Button } from "@renderer/components/ui/button";
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

export type ExternalAppTarget =
  | { kind: "file"; projectId: string; ticketId?: string; relPath: string }
  | { kind: "worktree"; projectId: string; ticketId: string };

export type ExternalAppMenuEntry = { kind: "app"; app: ExternalApp } | { kind: "finder" };

/** The empty state is Finder alone — no unavailable-app placeholder or error copy. */
export function externalAppMenuEntries(
  apps: readonly ExternalApp[],
): readonly ExternalAppMenuEntry[] {
  return [...apps.map((app) => ({ kind: "app" as const, app })), { kind: "finder" }];
}

const NO_EXTERNAL_APPS: readonly ExternalApp[] = [];
const ExternalAppsContext = React.createContext<readonly ExternalApp[]>(NO_EXTERNAL_APPS);

/**
 * Detect once after the app is ready, then let every Files surface render the
 * same truthful menu. An empty list is normal — Finder remains the one action.
 */
export function ExternalAppsProvider({
  children,
  initialApps = NO_EXTERNAL_APPS,
}: {
  children: React.ReactNode;
  /** Fixture/lab seed; production refreshes it from main after mount. */
  initialApps?: readonly ExternalApp[];
}) {
  const [apps, setApps] = React.useState<readonly ExternalApp[]>(initialApps);

  React.useEffect(() => {
    let current = true;
    void window.api.files
      .listExternalApps()
      .then((result) => {
        if (current && result.ok) setApps(result.apps);
      })
      .catch(() => {
        // No editor is a state, not a warning. Finder stays available below.
      });
    return () => {
      current = false;
    };
  }, []);

  return <ExternalAppsContext.Provider value={apps}>{children}</ExternalAppsContext.Provider>;
}

function AppGlyph({ app }: { app: ExternalApp }) {
  const Icon = app.kind === "editor" ? CodeIcon : TerminalWindowIcon;
  return <Icon aria-hidden />;
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

/** A Files context-menu submenu: installed apps first, then Finder in the same home. */
export function ExternalAppContextMenu({
  target,
  label = target.kind === "worktree" ? "Open worktree in…" : "Open in…",
}: {
  target: ExternalAppTarget;
  label?: string;
}) {
  const apps = React.useContext(ExternalAppsContext);
  const entries = externalAppMenuEntries(apps);
  const { open, reveal } = useExternalAppActions(target);

  return (
    <ContextMenuSub>
      <ContextMenuSubTrigger icon={ArrowSquareOutIcon}>{label}</ContextMenuSubTrigger>
      <ContextMenuSubContent>
        {entries.map((entry) => {
          if (entry.kind === "finder") {
            return (
              <React.Fragment key="finder">
                {apps.length > 0 ? <ContextMenuSeparator /> : null}
                <ContextMenuItem icon={FolderOpenIcon} onSelect={() => void reveal()}>
                  Reveal in Finder
                </ContextMenuItem>
              </React.Fragment>
            );
          }
          const Icon = entry.app.kind === "editor" ? CodeIcon : TerminalWindowIcon;
          return (
            <ContextMenuItem key={entry.app.id} icon={Icon} onSelect={() => void open(entry.app)}>
              {entry.app.label}
            </ContextMenuItem>
          );
        })}
      </ContextMenuSubContent>
    </ContextMenuSub>
  );
}

/** The repository card's visible Open control, with the exact same menu rows as a file context menu. */
export function ExternalAppDropdownMenu({
  target,
  label = target.kind === "worktree" ? "Open worktree in…" : "Open in…",
}: {
  target: ExternalAppTarget;
  label?: string;
}) {
  const apps = React.useContext(ExternalAppsContext);
  const entries = externalAppMenuEntries(apps);
  const { open, reveal } = useExternalAppActions(target);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="xs" variant="ghost" className="shrink-0" aria-label={label} title={label}>
          <ArrowSquareOutIcon />
          Open
          <CaretDownIcon weight="bold" className="size-3" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {entries.map((entry) => {
          if (entry.kind === "finder") {
            return (
              <React.Fragment key="finder">
                {apps.length > 0 ? <DropdownMenuSeparator /> : null}
                <DropdownMenuItem onSelect={() => void reveal()}>
                  <FolderOpenIcon aria-hidden />
                  Reveal in Finder
                </DropdownMenuItem>
              </React.Fragment>
            );
          }
          return (
            <DropdownMenuItem key={entry.app.id} onSelect={() => void open(entry.app)}>
              <AppGlyph app={entry.app} />
              {entry.app.label}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
