import { ComposerFileAttach } from "@renderer/components/board/new-ticket/composer-file-attach";
import { Button } from "@renderer/components/ui/button";
import { Switch } from "@renderer/components/ui/switch";
import type { FileIndexHandle } from "@renderer/hooks/use-file-index";

/**
 * The composer footer: the paperclip file-ref picker, a "Create more" toggle,
 * and the two ways to commit — the secondary "Create" and the primary
 * "Create & start" (`data-testid="composer-kickoff"`, its harness carried in
 * the accessible name).
 *
 * The two commits are welded into one pill rather than spaced apart, because
 * they are one decision with two answers: both create this ticket, and only one
 * of them also boots an agent. Butting them together says that; a gap would
 * have made them look like unrelated actions that happen to sit side by side.
 * They stay two separate buttons — each is one press, neither hides behind a
 * caret.
 *
 * The terminal-harness picker used to live here, beside the kickoff button. It
 * is now a chip in the metadata row (`composer-harness.tsx`), where it belongs:
 * it describes the ticket, it does not modify the button. The kickoff button
 * still names the active harness so the pairing survives the move.
 */
export function ComposerFooter({
  fileIndex,
  onInsertRef,
  createMore,
  onCreateMoreChange,
  harnessLabel,
  onCreate,
  onKickoff,
  disabled,
}: {
  fileIndex: FileIndexHandle;
  onInsertRef: (relPath: string) => void;
  createMore: boolean;
  onCreateMoreChange: (createMore: boolean) => void;
  /** The active terminal harness's label, for the kickoff button's accessible name. */
  harnessLabel: string;
  onCreate: () => void;
  onKickoff: () => void;
  disabled: boolean;
}) {
  return (
    <div className="flex items-center gap-2">
      <ComposerFileAttach fileIndex={fileIndex} onInsert={onInsertRef} />

      <label className="flex items-center gap-2 text-ui text-muted-foreground">
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
      <div className="ml-auto flex items-center">
        <Button
          variant="secondary"
          size="sm"
          onClick={onCreate}
          disabled={disabled}
          className="rounded-r-none"
        >
          Create
        </Button>
        <Button
          data-testid="composer-kickoff"
          aria-label={`Create & start · ${harnessLabel}`}
          onClick={onKickoff}
          disabled={disabled}
          size="sm"
          className="rounded-l-none"
        >
          Create &amp; start
        </Button>
      </div>
    </div>
  );
}
