/**
 * A read-only look at a file an agent will read — a skill's body, a repo
 * instruction file — without leaving Volli (VC-305).
 *
 * READ-ONLY ON PURPOSE. Inspection and enablement are separate controls: the
 * rows that open this keep their Mode select (or nothing at all) beside it,
 * and this surface offers no edit, toggle or write of any kind. The file on
 * disk stays the real interface; Reveal is still on the row for that.
 *
 * The title and description WRAP rather than truncate. The table rows that
 * open this clip both to one line, so this is the one place a long skill name
 * or description is guaranteed to be readable in full.
 *
 * The body renders through the same sanitizing markdown pipeline a Ticket
 * uses, because these files are markdown and nobody's prose reads better as
 * raw `#` and `*`.
 */
import { WarningIcon } from "@phosphor-icons/react/dist/csr/Warning";

import type { AsyncState } from "@renderer/components/settings/kit";
import { Markdown } from "@renderer/components/ticket/markdown";
import { Button } from "@renderer/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@renderer/components/ui/dialog";
import { Skeleton } from "@renderer/components/ui/skeleton";

/** The body a preview shows. `truncated` when the reader stopped at its cap. */
export interface PreviewBody {
  text: string;
  truncated: boolean;
}

/**
 * A fetched body, plus the one outcome a retry cannot change: the file was
 * read and is not text. Offering Try again there would loop forever.
 */
export type PreviewState = AsyncState<PreviewBody> | { status: "unavailable"; message: string };

export function ContentPreviewDialog({
  open,
  title,
  origin,
  description,
  body,
  onClose,
}: {
  open: boolean;
  title: string;
  /** Where the file lives, as one quiet line — `This project · .agents/skills/tdd`. */
  origin: string;
  /** The file's own summary, when it has one. */
  description?: string;
  body: PreviewState;
  onClose: () => void;
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent
        data-testid="content-preview-dialog"
        className="flex h-[70vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-3xl"
      >
        <DialogHeader className="shrink-0 gap-1 border-b border-border/50 py-4 pr-12 pl-4">
          <DialogTitle className="break-words">{title}</DialogTitle>
          <DialogDescription asChild>
            <div className="flex flex-col gap-1">
              {description ? (
                <p className="text-sm break-words text-foreground">{description}</p>
              ) : null}
              <p className="text-ui break-all text-muted-foreground">{origin}</p>
            </div>
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
          <PreviewContent body={body} />
        </div>
      </DialogContent>
    </Dialog>
  );
}

function PreviewContent({ body }: { body: PreviewState }) {
  if (body.status === "loading") {
    return (
      <div className="flex flex-col gap-2" aria-busy>
        <span className="sr-only">Loading…</span>
        <Skeleton className="h-4 w-2/3" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-5/6" />
      </div>
    );
  }
  if (body.status === "unavailable") {
    return <p className="text-ui text-muted-foreground">{body.message}</p>;
  }
  if (body.status === "error") {
    return (
      <div role="alert" className="flex items-center gap-2 text-ui">
        <WarningIcon aria-hidden className="size-4 shrink-0 text-destructive" />
        <span className="min-w-0 flex-1 text-muted-foreground">{body.message}</span>
        <Button size="xs" variant="outline" onClick={body.onRetry}>
          Try again
        </Button>
      </div>
    );
  }
  if (body.data.text.trim() === "") {
    return <p className="text-ui text-muted-foreground">This file is empty.</p>;
  }
  return (
    <>
      <Markdown source={body.data.text} />
      {body.data.truncated ? (
        <p className="mt-4 text-ui text-muted-foreground">
          Showing the first 1 MiB. Reveal the file to read the rest.
        </p>
      ) : null}
    </>
  );
}
