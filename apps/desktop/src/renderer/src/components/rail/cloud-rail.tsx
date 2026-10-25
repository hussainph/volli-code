/**
 * The rail's head and foot in a cloud launch (VC-889): the Workspace whose
 * projects the rail lists, and, when this Mac holds projects of its own,
 * one quiet tile saying they are not on Volli Cloud yet, with its one way
 * back: signing out restarts Volli into them.
 */
import * as React from "react";
import { LaptopIcon } from "@phosphor-icons/react/dist/csr/Laptop";

import { SignOutRestartDialog } from "@renderer/components/cloud/sign-out-restart";
import { Button } from "@renderer/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@renderer/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@renderer/components/ui/tooltip";
import { useCloudWorkspaceStore } from "@renderer/stores/cloud-board/workspace";

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
