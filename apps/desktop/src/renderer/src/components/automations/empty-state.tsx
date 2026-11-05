/** Local adapter for the approved EmptyState API, until the shared registry lands. */
import * as React from "react";
import { Button } from "@renderer/components/ui/button";
import { AutomationIcon, ClockIcon } from "@renderer/components/ui/icon";
import { cn } from "@renderer/lib/utils";
import "./empty-state.css";

type EmptyIllustration =
  | "board"
  | "search"
  | "automation"
  | "file"
  | "folder"
  | "archive"
  | "chat"
  | "mcp"
  | "skill"
  | "secret"
  | "failed";
type EmptyAction = {
  label: string;
  onAction(): void;
  icon?: React.ReactNode;
  disabled?: boolean;
  busy?: boolean;
};
type EmptyName =
  | { labelledBy: string; accessibleLabel?: never }
  | { accessibleLabel: string; labelledBy?: never };
type EmptyStateProps =
  | { tier: "inline" }
  | (EmptyName & {
      tier: "page" | "panel";
      illustration: EmptyIllustration;
      title: string;
      line?: string;
      action?: EmptyAction;
      status?: "empty" | "filtered" | "unavailable" | "failed";
      headingLevel?: 2 | 3;
    });
export function EmptyState(props: EmptyStateProps) {
  const id = React.useId();
  if (props.tier === "inline") return null;
  const Heading = props.headingLevel === 3 ? "h3" : "h2";
  const failed = props.status === "failed" || props.illustration === "failed";
  return (
    <section
      className={cn("automation-empty", props.tier === "panel" && "automation-empty-panel")}
      aria-labelledby={id}
    >
      <div className="automation-empty-art" aria-hidden="true" data-failed={failed}>
        <div className="automation-empty-matrix" />
        <div className="automation-empty-scene">
          {!failed && (
            <svg className="automation-empty-path" viewBox="0 0 240 144">
              <path
                d="M118 78v29h43"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeDasharray="3 4"
              />
            </svg>
          )}
          <div className={cn("automation-empty-tile", failed && "automation-empty-failed")}>
            {failed ? (
              <svg
                width="32"
                height="32"
                viewBox="0 0 32 32"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
              >
                <path d="m12 20-2 2a5 5 0 0 1-7-7l5-5a5 5 0 0 1 7 0m3 2 2-2a5 5 0 0 1 7 7l-5 5a5 5 0 0 1-7 0M12 12l8 8M5 5l3 3m16 16 3 3" />
              </svg>
            ) : (
              <AutomationIcon className="size-9" />
            )}
            {!failed && <i />}
          </div>
          {!failed && (
            <div className="automation-empty-clock">
              <ClockIcon className="size-6" />
            </div>
          )}
        </div>
      </div>
      <Heading
        id={id}
        className={props.tier === "page" ? "text-heading font-semibold" : "text-ui font-semibold"}
      >
        {props.title}
      </Heading>
      {props.line && <p className="mt-1 text-ui text-muted-foreground">{props.line}</p>}
      {props.action && (
        <Button
          size="sm"
          variant="outline"
          className="mt-4"
          disabled={props.action.disabled || props.action.busy}
          onClick={props.action.onAction}
        >
          {props.action.icon}
          {props.action.label}
        </Button>
      )}
    </section>
  );
}
