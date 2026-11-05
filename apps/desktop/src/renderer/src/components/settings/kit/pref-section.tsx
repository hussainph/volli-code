/** Shared settings section: an outside heading and one grouped body. */
import * as React from "react";
import { type IconComponent, RefreshIcon } from "@renderer/components/ui/icon";

import { Button } from "@renderer/components/ui/button";
import { SectionHeading } from "@renderer/components/ui/section-heading";
import { Tooltip, TooltipContent, TooltipTrigger } from "@renderer/components/ui/tooltip";
import { cn } from "@renderer/lib/utils";

export function PrefSection({
  title,
  titleHidden = false,
  icon: Icon,
  hint,
  action,
  fill,
  children,
}: {
  title: string;
  /** The pane already names this group; retain its accessible heading. */
  titleHidden?: boolean;
  icon?: IconComponent;
  /**
   * The one-line trust boundary AGENTS.md allows ("Volli writes an overlay
   * file and never edits your Ghostty config"): what Volli will and will not
   * touch, which no control can show. Never explanation, never a tour of the
   * section — the controls are the explanation.
   */
  hint?: React.ReactNode;
  action?: React.ReactNode;
  /**
   * Absorb the height the pane has left over, for a section holding a table
   * that is the whole page. Needs every ancestor up to the shell to be a flex
   * column that can shrink — `PrefShell` arranges that when a category asks.
   */
  fill?: boolean;
  children: React.ReactNode;
}) {
  const titleId = React.useId();
  return (
    <section
      aria-labelledby={titleId}
      className={cn("flex flex-col gap-2", fill && "min-h-0 flex-1")}
    >
      {/* A heading and its actions share an axis outside the framed row group. */}
      <div
        className={cn(
          "flex flex-wrap items-center justify-between gap-2",
          titleHidden && !action ? "sr-only" : "min-h-7",
        )}
      >
        <div className={cn("flex min-w-0 items-center gap-2", titleHidden && "sr-only")}>
          {Icon ? <Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" /> : null}
          <SectionHeading as="h2" id={titleId} data-slot="pref-section-title" className="min-w-0">
            {title}
          </SectionHeading>
        </div>
        {action}
      </div>
      {hint ? <div className="text-ui text-muted-foreground">{hint}</div> : null}
      {/* A direct first row suppresses its top rule against the group's border. */}
      <div
        className={cn(
          "rounded-container border border-border bg-card",
          fill && "flex min-h-0 flex-1 flex-col",
        )}
      >
        {children}
      </div>
    </section>
  );
}

/** A section action with a word on it. */
export function SectionAction({
  label,
  icon: Icon,
  disabled,
  onAct,
}: {
  label: string;
  icon?: IconComponent;
  disabled?: boolean;
  onAct?: () => void;
}) {
  if (/^refresh\b/i.test(label)) {
    return <SectionIconAction label={label} icon={Icon} disabled={disabled} onAct={onAct} />;
  }
  return (
    <Button size="xs" variant="ghost" disabled={disabled} onClick={onAct}>
      {Icon ? <Icon /> : null}
      {label}
    </Button>
  );
}

/** A section action that is only a glyph. Its name lives in `aria-label`. */
export function SectionIconAction({
  label,
  icon: Icon = RefreshIcon,
  busy = false,
  disabled,
  onAct,
}: {
  label: string;
  icon?: IconComponent;
  /** Spins the glyph. A refresh that gives no sign of running reads as broken. */
  busy?: boolean;
  disabled?: boolean;
  onAct?: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label={label}
          disabled={disabled || busy}
          onClick={onAct}
        >
          <Icon className={busy ? "animate-spin motion-reduce:animate-none" : undefined} />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
