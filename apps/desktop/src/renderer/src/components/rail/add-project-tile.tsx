import { useState } from "react";
import { Spinner } from "@renderer/components/ui/spinner";
import { PlusIcon } from "@phosphor-icons/react/dist/csr/Plus";

import { Tooltip, TooltipContent, TooltipTrigger } from "@renderer/components/ui/tooltip";
import { useAddProject } from "@renderer/hooks/use-add-project";

export function AddProjectTile() {
  const pickAndAdd = useAddProject();
  const [busy, setBusy] = useState(false);

  async function addProject() {
    if (busy) return;
    setBusy(true);
    try {
      await pickAndAdd();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={() => void addProject()}
          aria-disabled={busy}
          aria-label={busy ? "Adding project" : "Add project"}
          className="app-region-no-drag group/tile relative flex size-9 shrink-0 items-center justify-center rounded-control control-material border border-border-strong bg-card shadow-control hover:shadow-control-hover outline-none transition-[box-shadow] duration-100 ease-out focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background motion-reduce:transition-none active:shadow-control-pressed"
        >
          {busy ? <Spinner /> : <PlusIcon weight="bold" className="size-4 text-muted-foreground" />}
          <span
            aria-hidden
            className="pointer-events-none absolute inset-0 rounded-control bg-foreground/10 opacity-0 group-hover/tile:opacity-100"
          />
          <span className="sr-only">Add project</span>
        </button>
      </TooltipTrigger>
      <TooltipContent side="right">Add project</TooltipContent>
    </Tooltip>
  );
}
