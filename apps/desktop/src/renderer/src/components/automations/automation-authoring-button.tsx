import * as React from "react";
import { SparkleIcon } from "@renderer/components/ui/icon";

import { errorMessage } from "@volli/shared";

import { Button } from "@renderer/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@renderer/components/ui/tooltip";
import { toastError } from "@renderer/lib/toast";
import { useChatSessionsStore } from "@renderer/stores/chat-sessions";
import type { AutomationAuthoringContext } from "./automation-authoring";

/** An explicit handoff, not a background model call or an automatic rewrite. */
export function AutomationAuthoringButton({
  projectId,
  context,
}: {
  projectId: string;
  context: AutomationAuthoringContext;
}) {
  const starting = useChatSessionsStore((state) => state.starting[projectId] === true);
  const [pending, setPending] = React.useState(false);
  const pendingRef = React.useRef(false);
  const empty = context.name.trim() === "" && context.instructions.trim() === "";

  async function start(): Promise<void> {
    if (pendingRef.current || starting || empty) return;
    pendingRef.current = true;
    setPending(true);
    try {
      const { startAutomationAuthoring } = await import("./automation-authoring");
      await startAutomationAuthoring(projectId, context);
    } catch (error) {
      toastError(`Couldn't start drafting chat: ${errorMessage(error)}`);
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  }

  const button = (
    <Button
      size="sm"
      variant="ghost"
      disabled={empty || starting || pending}
      onClick={() => void start()}
    >
      <SparkleIcon />
      Draft in chat
    </Button>
  );
  // The label names the action; only the blocked state earns a tooltip, and it
  // names the one thing that unblocks it.
  if (!empty) return button;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span>{button}</span>
      </TooltipTrigger>
      <TooltipContent>Add an idea in Instructions first</TooltipContent>
    </Tooltip>
  );
}
