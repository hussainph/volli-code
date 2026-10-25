/**
 * The rail's head and foot in a cloud launch (VC-889): the Workspace whose
 * projects the rail lists; "New project" for it; and, when this Mac holds
 * projects of its own, one quiet tile saying they are not on Volli Cloud yet,
 * with its one way back: signing out restarts Volli into them.
 */
import * as React from "react";
import { LaptopIcon } from "@phosphor-icons/react/dist/csr/Laptop";
import { PlusIcon } from "@phosphor-icons/react/dist/csr/Plus";

import { SignOutRestartDialog } from "@renderer/components/cloud/sign-out-restart";
import { Button } from "@renderer/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@renderer/components/ui/dialog";
import { Input } from "@renderer/components/ui/input";
import { cloudSession } from "@renderer/lib/cloud-client";
import { toastError } from "@renderer/lib/toast";
import { Popover, PopoverContent, PopoverTrigger } from "@renderer/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@renderer/components/ui/tooltip";
import { createCloudProject, useCloudWorkspaceStore } from "@renderer/stores/cloud-board/workspace";
import { useProjectsStore } from "@renderer/stores/projects";

/** The Workspace's initial, named in full on hover. */
export function CloudWorkspaceHead() {
  const workspace = useCloudWorkspaceStore((state) => state.workspace);
  if (workspace === null) return null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div
          aria-label={workspace.name}
          className="app-region-no-drag flex size-9 shrink-0 items-center justify-center rounded-control border border-border text-ui font-medium text-muted-foreground"
        >
          {workspace.name.slice(0, 1).toUpperCase()}
        </div>
      </TooltipTrigger>
      <TooltipContent side="right">{workspace.name}</TooltipContent>
    </Tooltip>
  );
}

function countProjects(count: number): string {
  return count === 1 ? "1 project on this Mac isn’t" : `${count} projects on this Mac aren’t`;
}

/** This Mac's own projects, not shown in a cloud launch, and the way back to them. */
export function LocalProjectsFoot() {
  const count = useCloudWorkspaceStore((state) => state.localProjects);
  const [confirming, setConfirming] = React.useState(false);
  if (count === 0) return null;
  const line = `${countProjects(count)} on Volli Cloud yet`;
  return (
    <>
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={line}
            className="app-region-no-drag group/tile relative flex size-9 shrink-0 items-center justify-center rounded-control bg-muted"
          >
            <LaptopIcon className="size-[15px] text-muted-foreground" />
            <span
              aria-hidden
              className="pointer-events-none absolute inset-0 rounded-control bg-foreground/10 opacity-0 group-hover/tile:opacity-100"
            />
          </button>
        </PopoverTrigger>
        <PopoverContent side="right" className="flex w-64 flex-col gap-2">
          <p className="text-ui text-muted-foreground">{line}</p>
          <Button size="sm" variant="outline" onClick={() => setConfirming(true)}>
            Sign out to open them
          </Button>
        </PopoverContent>
      </Popover>
      <SignOutRestartDialog open={confirming} onOpenChange={setConfirming} />
    </>
  );
}

/** "New project" in a cloud launch: a name and an optional prefix, in the Workspace on screen. */
export function NewCloudProjectTile() {
  const [open, setOpen] = React.useState(false);
  const [name, setName] = React.useState("");
  const [prefix, setPrefix] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const submit = async () => {
    const trimmed = name.trim();
    if (trimmed === "" || busy) return;
    setBusy(true);
    const result = await createCloudProject(
      { name: trimmed, ...(prefix.trim() === "" ? {} : { ticketPrefix: prefix.trim() }) },
      cloudSession(),
      useCloudWorkspaceStore.getState().workspace?.id ?? null,
    );
    setBusy(false);
    if (!result.ok) {
      toastError(`Couldn’t create project: ${result.error}`);
      return;
    }
    setOpen(false);
    setName("");
    setPrefix("");
    useProjectsStore.getState().select(result.projectId);
  };
  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label="New project"
            onClick={() => setOpen(true)}
            className="app-region-no-drag group/tile relative flex size-9 shrink-0 items-center justify-center rounded-control bg-muted"
          >
            <PlusIcon weight="bold" className="size-[15px] text-muted-foreground" />
            <span
              aria-hidden
              className="pointer-events-none absolute inset-0 rounded-control bg-foreground/10 opacity-0 group-hover/tile:opacity-100"
            />
          </button>
        </TooltipTrigger>
        <TooltipContent side="right">New project</TooltipContent>
      </Tooltip>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New project</DialogTitle>
          </DialogHeader>
          <form
            className="flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <Input
              autoFocus
              aria-label="Name"
              placeholder="Name"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
            <Input
              aria-label="Ticket prefix"
              placeholder="Ticket prefix (optional)"
              value={prefix}
              onChange={(event) => setPrefix(event.target.value.toUpperCase())}
            />
            <DialogFooter>
              <Button type="submit" size="sm" disabled={busy || name.trim() === ""}>
                Create
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
