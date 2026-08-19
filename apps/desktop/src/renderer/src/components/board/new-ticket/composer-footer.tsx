import { ComposerAttachButton } from "@renderer/components/attachments/composer-attach-button";
import {
  ComposerRunRow,
  type ComposerRun,
} from "@renderer/components/board/new-ticket/composer-run";
import { Button } from "@renderer/components/ui/button";
import { Switch } from "@renderer/components/ui/switch";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@renderer/components/ui/tooltip";

/**
 * The composer's bottom rail: one attachment affordance, what a kickoff will
 * RUN on the left, a "Create more" toggle, and the two ways to commit — the
 * secondary "Create" and the primary "Create & start"
 * (`data-testid="composer-kickoff"`).
 *
 * ONE ROW FOR THE RUN, AND IT IS THIS ONE. The model and effort pills sit here
 * rather than up in the metadata row because of what the two rows are ABOUT:
 * the metadata row describes the ticket (status, priority, labels, the branch
 * it lands on) and this one is the act of creating it. Model and effort belong
 * to the act — they are only consulted if you press the right-hand button — and
 * putting them here is also what un-wraps the row above, which had been
 * spilling the branch pair onto a second line since the harness chip joined it.
 *
 * The two commits are welded into one pill rather than spaced apart, because
 * they are one decision with two answers: both create this ticket, and only one
 * of them also starts an agent. Butting them together says that; a gap would
 * have made them look like unrelated actions that happen to sit side by side.
 * They stay two separate buttons — each is one press, neither hides behind a
 * caret.
 *
 * THE TOOLTIPS ARE THE ONE EXCEPTION to "let controls talk" this surface takes,
 * and they are one clause each. "Create" and "Create & start" are not
 * self-evident as a PAIR — the difference between them is invisible in the
 * words, and the first external user hit exactly that — so each names what it
 * does and the chord that does it, and neither explains anything else.
 *
 * Each trigger is a `span` around its button rather than the button itself,
 * which is not decoration: an empty title disables both buttons, `Button`
 * carries `disabled:pointer-events-none`, and a disabled control dispatches no
 * pointer events — so the labels would be missing at the one moment a
 * first-timer is reading the footer and has typed nothing yet. The wrapper is
 * the hover target; focus still reaches the button and still opens the label,
 * because React's synthetic focus bubbles to it.
 *
 * The pair carries its own {@link TooltipProvider} rather than borrowing one.
 * There IS one overhead in the app — `SidebarProvider` mounts it, and the
 * composer happens to render inside that — but Radix throws outright when the
 * context is missing, so "the sidebar happens to be an ancestor" was the whole
 * of what kept a modal dialog from crashing its own subtree. It is not a
 * relationship either component states, and the lab found it the first time the
 * composer was mounted without the shell around it. Providers nest, so owning
 * one costs nothing and the delay stays the house's (500ms — an extended hover,
 * never a twitch).
 */
export function ComposerFooter({
  onAttachFiles,
  run,
  createMore,
  onCreateMoreChange,
  onCreate,
  onKickoff,
  disabled,
}: {
  /** Attach images/files from anywhere on disk (VC-50). */
  onAttachFiles?: (files: readonly File[]) => void;
  /** The model + effort a kickoff will run on — see {@link ComposerRunRow}. */
  run: ComposerRun;
  createMore: boolean;
  onCreateMoreChange: (createMore: boolean) => void;
  onCreate: () => void;
  onKickoff: () => void;
  disabled: boolean;
}) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      {/* One paperclip: images and files from anywhere. Project files are not a
          second icon — typing `@` in the description completes against the same
          file index (VC-115). */}
      {onAttachFiles === undefined ? null : <ComposerAttachButton onFiles={onAttachFiles} />}
      <ComposerRunRow run={run} />

      <label className="ml-auto flex shrink-0 items-center gap-2 text-ui text-muted-foreground">
        <Switch
          aria-label="Create more"
          checked={createMore}
          onCheckedChange={onCreateMoreChange}
        />
        Create more
      </label>

      {/* No `overflow-hidden` on the group: each half keeps its own outer pill
          corners, so the press scale reads as that half depressing inside the
          control rather than as the seam tearing open. */}
      <TooltipProvider>
        <div className="flex shrink-0 items-center">
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="inline-flex">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={onCreate}
                  disabled={disabled}
                  className="rounded-r-none"
                >
                  Create
                </Button>
              </span>
            </TooltipTrigger>
            <TooltipContent side="top">Adds the ticket. ⌘↵</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="inline-flex">
                <Button
                  data-testid="composer-kickoff"
                  onClick={onKickoff}
                  disabled={disabled}
                  size="sm"
                  className="rounded-l-none"
                >
                  Create &amp; start
                </Button>
              </span>
            </TooltipTrigger>
            <TooltipContent side="top">Adds it and starts an agent on it. ⇧⌘↵</TooltipContent>
          </Tooltip>
        </div>
      </TooltipProvider>
    </div>
  );
}
