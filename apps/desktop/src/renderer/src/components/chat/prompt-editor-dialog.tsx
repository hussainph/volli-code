import { ArrowsInIcon } from "@phosphor-icons/react/dist/csr/ArrowsIn";
import { ArrowsOutIcon } from "@phosphor-icons/react/dist/csr/ArrowsOut";

import {
  COMPOSER_CONTROL_ICON_SIZE,
  PROMPT_SURFACE,
} from "@renderer/components/chat/composer-chrome";
import { Button } from "@renderer/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
  DialogTrigger,
} from "@renderer/components/ui/dialog";
import { cn } from "@renderer/lib/utils";

/**
 * The shared long-form escape hatch for a compact prompt surface.
 *
 * It edits the caller's controlled draft directly, so opening and closing never
 * creates a second copy that can drift or be discarded accidentally. The sheet
 * deliberately owns no send/save action: it gives prose room, then returns the
 * person to the surface whose existing primary action still says exactly what
 * will happen to that prose.
 *
 * New ticket already has the same affordance at the dialog level, where Expand
 * widens its Monaco-backed document editor. This is the plain-text counterpart
 * for Session messages, Automation instructions, command prompts, and comments.
 */
export function PromptEditorDialog({
  value,
  onValueChange,
  title,
  triggerLabel,
  textareaLabel,
  placeholder,
  disabled = false,
  className,
}: {
  value: string;
  onValueChange(value: string): void;
  title: string;
  triggerLabel: string;
  textareaLabel: string;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button
          type="button"
          size={COMPOSER_CONTROL_ICON_SIZE}
          variant="ghost"
          disabled={disabled}
          aria-label={triggerLabel}
          title={triggerLabel}
          className={cn("text-muted-foreground hover:text-foreground", className)}
        >
          <ArrowsOutIcon />
        </Button>
      </DialogTrigger>
      <DialogContent
        data-testid="prompt-editor-dialog"
        showCloseButton={false}
        className={cn(
          PROMPT_SURFACE,
          "h-[min(80vh,44rem)] grid-rows-[auto_minmax(0,1fr)_auto] gap-0 overflow-hidden p-0 shadow-overlay sm:max-w-3xl",
        )}
      >
        <header className="flex items-center gap-4 border-b border-border px-4 py-2">
          <DialogTitle className="min-w-0 flex-1 truncate">{title}</DialogTitle>
          <DialogClose asChild>
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              aria-label={`Close ${title.toLowerCase()}`}
              aria-keyshortcuts="Escape"
              className="text-muted-foreground hover:text-foreground"
            >
              <ArrowsInIcon />
            </Button>
          </DialogClose>
        </header>

        <textarea
          autoFocus
          value={value}
          onChange={(event) => onValueChange(event.currentTarget.value)}
          aria-label={textareaLabel}
          placeholder={placeholder}
          className="min-h-0 w-full resize-none bg-transparent px-6 py-4 text-sm text-foreground outline-none placeholder:text-muted-foreground"
        />

        <footer className="prompt-toolbar flex items-center justify-end px-4 py-2">
          <DialogClose asChild>
            <Button type="button" size="sm">
              Done
            </Button>
          </DialogClose>
        </footer>
      </DialogContent>
    </Dialog>
  );
}
