import * as React from "react";
import { ArrowRightIcon } from "@phosphor-icons/react/dist/csr/ArrowRight";
import { ChatCircleIcon } from "@phosphor-icons/react/dist/csr/ChatCircle";
import { ClockCounterClockwiseIcon } from "@phosphor-icons/react/dist/csr/ClockCounterClockwise";
import { FileTextIcon } from "@phosphor-icons/react/dist/csr/FileText";
import { FolderOpenIcon } from "@phosphor-icons/react/dist/csr/FolderOpen";
import { GearSixIcon } from "@phosphor-icons/react/dist/csr/GearSix";
import { PlusIcon } from "@phosphor-icons/react/dist/csr/Plus";
import { prefersReducedMotion } from "@renderer/hooks/use-reduced-motion";
import { cn } from "@renderer/lib/utils";

export type NextActionKind =
  | "board"
  | "chat"
  | "active"
  | "previous"
  | "project"
  | "selection"
  | "files";

// Empty states can remount when navigating. An explanation gets one turn per
// renderer lifetime, not a new performance every time the user comes back.
const played = new Set<NextActionKind>();
const explanations: Record<NextActionKind, string> = {
  board: "Create a ticket, then move it from Todo to Doing as work progresses.",
  chat: "Type a message, then choose the model and effort in the composer.",
  active: "Sessions you start appear in Active.",
  previous: "Return to earlier sessions from Previous.",
  project: "Open a repository with Open a project.",
  selection: "Choose a project to open its settings.",
  files: "Open a file from the list to read it in a tab.",
};

/** Illustrations, never interactive replicas or loading skeletons. The DOM is
 * the complete static explanation. WAAPI temporarily moves only its leaves;
 * cancelling restores that illustration immediately, without moving targets. */
export function NextActionIllustration({
  kind,
  className,
}: {
  kind: NextActionKind;
  className?: string;
}) {
  const ref = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    const element = ref.current;
    if (
      !element ||
      played.has(kind) ||
      prefersReducedMotion() ||
      !element.animate ||
      typeof IntersectionObserver === "undefined"
    )
      return;
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    let animations: Animation[] = [];
    let stopped = false;
    const stop = () => {
      stopped = true;
      played.add(kind);
      animations.forEach((animation) => animation.cancel());
      observer.disconnect();
    };
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting && entry.intersectionRatio >= 0.5))
          return;
        observer.disconnect();
        if (
          stopped ||
          played.has(kind) ||
          document.hidden ||
          prefersReducedMotion() ||
          document.activeElement?.matches(":focus-visible")
        )
          return;
        played.add(kind);
        const style = getComputedStyle(element);
        const entrance = style.getPropertyValue("--ease-out").trim();
        const travel = style.getPropertyValue("--ease-swift").trim();
        animations = Array.from(
          element.querySelectorAll<HTMLElement>("[data-explanation-step]"),
        ).map((leaf, index) => {
          const moving = leaf.dataset.explanationTravel === "true";
          return leaf.animate(
            moving
              ? [
                  { transform: "translateX(-100%)", opacity: 0.5 },
                  { transform: "translateX(0)", opacity: 1 },
                ]
              : [
                  { transform: "translateY(8px)", opacity: 0 },
                  { transform: "translateY(0)", opacity: 1 },
                ],
            {
              duration: moving ? 240 : 200,
              delay: index * 200,
              easing: moving ? travel : entrance,
              fill: "backwards",
              iterations: 1,
            },
          );
        });
      },
      { threshold: 0.5 },
    );
    observer.observe(element);
    const visibility = () => {
      if (document.hidden) stop();
    };
    // Any real action wins over the demonstration, including typing elsewhere.
    document.addEventListener("pointerdown", stop, true);
    document.addEventListener("keydown", stop, true);
    document.addEventListener("visibilitychange", visibility);
    preference.addEventListener("change", stop);
    return () => {
      observer.disconnect();
      animations.forEach((animation) => animation.cancel());
      document.removeEventListener("pointerdown", stop, true);
      document.removeEventListener("keydown", stop, true);
      document.removeEventListener("visibilitychange", visibility);
      preference.removeEventListener("change", stop);
    };
  }, [kind]);

  return (
    <div
      ref={ref}
      role="img"
      aria-label={explanations[kind]}
      data-next-action={kind}
      className={cn("pointer-events-none max-w-full text-ui text-muted-foreground", className)}
    >
      <div aria-hidden>
        {kind === "board" ? (
          <BoardDrawing />
        ) : kind === "chat" ? (
          <ChatDrawing />
        ) : kind === "active" || kind === "previous" ? (
          <SessionDrawing previous={kind === "previous"} />
        ) : (
          <DestinationDrawing kind={kind} />
        )}
      </div>
    </div>
  );
}

const frame = "rounded-control border border-border bg-card shadow-raised";
function BoardDrawing() {
  return (
    <div className="w-64 max-w-full">
      <div className="mb-2 grid grid-cols-2 text-left font-medium">
        <span>Todo</span>
        <span>Doing</span>
      </div>
      <div className="relative grid grid-cols-2">
        <div className="mr-2 h-16 rounded-control border border-dashed border-border" />
        <div data-explanation-step data-explanation-travel="true" className="pr-2">
          <div className={cn(frame, "flex h-16 flex-col justify-center gap-2 p-2 text-foreground")}>
            <span className="flex items-center gap-1">
              <ChatCircleIcon className="size-3" weight="bold" /> Ticket
            </span>
            <span className="h-1 w-16 rounded-keycap bg-border" />
          </div>
        </div>
      </div>
      <div data-explanation-step className="mt-2 flex items-center justify-center gap-2">
        <PlusIcon className="size-3" weight="bold" /> Create a ticket
      </div>
    </div>
  );
}
function ChatDrawing() {
  return (
    <div className={cn(frame, "w-64 max-w-full overflow-hidden text-left")}>
      <div className="p-2">
        <span data-explanation-step className="inline-block text-foreground">
          Ask about your code
        </span>
      </div>
      <div className="flex items-center gap-2 border-t border-border bg-muted p-2">
        <span data-explanation-step className={cn(frame, "px-2 text-foreground")}>
          Model
        </span>
        <span data-explanation-step className={cn(frame, "px-2 text-foreground")}>
          Effort
        </span>
        <ArrowRightIcon data-explanation-step className="ml-auto size-4 text-primary-text" />
      </div>
    </div>
  );
}
function SessionDrawing({ previous }: { previous: boolean }) {
  const Glyph = previous ? ClockCounterClockwiseIcon : ChatCircleIcon;
  return (
    <div className="relative h-8 rounded-control border border-dashed border-border">
      <div data-explanation-step className="absolute inset-0 flex items-center gap-2 px-2">
        <Glyph className="size-4" />
        <span className="h-1 w-16 rounded-keycap bg-border" />
        <span className="ml-auto size-1 rounded-full bg-primary" />
      </div>
    </div>
  );
}
function DestinationDrawing({ kind }: { kind: "project" | "selection" | "files" }) {
  const Source = kind === "files" ? FileTextIcon : FolderOpenIcon;
  const Destination =
    kind === "selection" ? GearSixIcon : kind === "files" ? FileTextIcon : PlusIcon;
  return (
    <div className="flex items-center gap-2">
      <span
        data-explanation-step
        className={cn(frame, "grid size-12 place-items-center text-primary-text")}
      >
        <Source className="size-6" />
      </span>
      <ArrowRightIcon className="size-4" />
      <span
        data-explanation-step
        className={cn(frame, "flex h-12 items-center gap-2 px-2 text-foreground")}
      >
        <Destination className="size-4" />
        {kind === "files" ? "Tab" : kind === "selection" ? "Settings" : "Open a project"}
      </span>
    </div>
  );
}
