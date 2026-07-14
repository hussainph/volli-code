import * as React from "react";
import { ArchiveIcon } from "@phosphor-icons/react/dist/csr/Archive";
import { ArrowCounterClockwiseIcon } from "@phosphor-icons/react/dist/csr/ArrowCounterClockwise";
import { ArrowRightIcon } from "@phosphor-icons/react/dist/csr/ArrowRight";
import { ChatCircleIcon } from "@phosphor-icons/react/dist/csr/ChatCircle";
import { FlagIcon } from "@phosphor-icons/react/dist/csr/Flag";
import { GitBranchIcon } from "@phosphor-icons/react/dist/csr/GitBranch";
import { NotePencilIcon } from "@phosphor-icons/react/dist/csr/NotePencil";
import { PaperPlaneTiltIcon } from "@phosphor-icons/react/dist/csr/PaperPlaneTilt";
import { PencilSimpleIcon } from "@phosphor-icons/react/dist/csr/PencilSimple";
import { PlusCircleIcon } from "@phosphor-icons/react/dist/csr/PlusCircle";
import { TagIcon } from "@phosphor-icons/react/dist/csr/Tag";
import { TerminalIcon } from "@phosphor-icons/react/dist/csr/Terminal";
import { TerminalWindowIcon } from "@phosphor-icons/react/dist/csr/TerminalWindow";
import { TrashSimpleIcon } from "@phosphor-icons/react/dist/csr/TrashSimple";
import {
  errorMessage,
  isAgentActor,
  USER_ACTOR,
  type Ticket,
  type TicketComment,
  type TicketEvent,
  type TicketEventKind,
} from "@volli/shared";
import { toast } from "sonner";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@renderer/components/ui/alert-dialog";
import { Button } from "@renderer/components/ui/button";
import {
  buildActivityFeed,
  commentAuthorLabel,
  describeEvent,
} from "@renderer/components/ticket/activity";
import { Markdown } from "@renderer/components/ticket/markdown";
import { relativeTime } from "@renderer/lib/relative-time";
import { cn } from "@renderer/lib/utils";
import { writeThrough } from "@renderer/stores/mutate";

type PhosphorIcon = typeof ChatCircleIcon;

/** One muted Phosphor glyph per property-change kind. `commented` never renders (it's dropped). */
const EVENT_ICON: Record<TicketEventKind, PhosphorIcon> = {
  created: PlusCircleIcon,
  status_changed: ArrowRightIcon,
  priority_changed: FlagIcon,
  retitled: PencilSimpleIcon,
  body_edited: NotePencilIcon,
  labels_changed: TagIcon,
  archived: ArchiveIcon,
  unarchived: ArrowCounterClockwiseIcon,
  commented: ChatCircleIcon,
  session_started: TerminalIcon,
  session_ended: TerminalWindowIcon,
  worktree_changed: GitBranchIcon,
};

/** A muted, single-line property-change entry: icon + human sentence + relative time. */
function EventRow({ event }: { event: TicketEvent }) {
  const Icon = EVENT_ICON[event.payload.kind];
  const sentence = describeEvent(event.payload);
  if (sentence === null) return null; // defensive: `commented` is filtered upstream
  return (
    <li className="flex items-center gap-2 px-1 text-xs text-muted-foreground">
      <Icon weight="fill" className="size-3.5 shrink-0" />
      <span className="min-w-0 truncate">{sentence}</span>
      <span className="shrink-0 text-muted-foreground/70">· {relativeTime(event.createdAt)}</span>
    </li>
  );
}

/** A small round author badge — first-letter monogram of the author label. */
function AuthorChip({ actor }: { actor: string }) {
  const label = commentAuthorLabel(actor);
  return (
    <span
      className={cn(
        "inline-flex size-5 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold",
        isAgentActor(actor) ? "bg-primary/15 text-primary" : "bg-accent text-accent-foreground",
      )}
      aria-hidden
    >
      {label.charAt(0).toUpperCase()}
    </span>
  );
}

/**
 * A full comment block: author + relative time, the markdown body, and (for the
 * human user's own comments) inline edit and a confirm-guarded delete. Every
 * mutation calls `onChanged` to refetch the authoritative feed.
 */
function CommentBlock({ comment, onChanged }: { comment: TicketComment; onChanged: () => void }) {
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState(comment.body);
  const isUser = comment.actor === USER_ACTOR;
  const optimistic = comment.id.startsWith("temp-");

  async function saveEdit() {
    const trimmed = draft.trim();
    if (trimmed === "" || trimmed === comment.body) {
      setEditing(false);
      return;
    }
    const result = await writeThrough("edit comment", () =>
      window.api.comments.update({ commentId: comment.id, body: trimmed }),
    );
    if (!result) return; // failure already toasted — keep the editor open
    setEditing(false);
    onChanged();
  }

  async function remove() {
    const result = await writeThrough("delete comment", () =>
      window.api.comments.remove({ commentId: comment.id }),
    );
    if (!result) return;
    onChanged();
  }

  return (
    <li
      className={cn(
        "rounded-lg border border-border bg-card px-3 py-2.5",
        optimistic && "opacity-60",
      )}
    >
      <div className="flex items-center gap-2">
        <AuthorChip actor={comment.actor} />
        <span className="text-xs font-medium text-foreground">
          {commentAuthorLabel(comment.actor)}
        </span>
        <span className="text-xs text-muted-foreground">
          {relativeTime(comment.createdAt)}
          {comment.updatedAt > comment.createdAt ? " · edited" : ""}
        </span>
        {isUser && !editing && !optimistic ? (
          <div className="ml-auto flex items-center gap-0.5">
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Edit comment"
              onClick={() => {
                setDraft(comment.body);
                setEditing(true);
              }}
            >
              <PencilSimpleIcon />
            </Button>
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="ghost" size="icon-xs" aria-label="Delete comment">
                  <TrashSimpleIcon />
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent size="sm">
                <AlertDialogHeader>
                  <AlertDialogTitle>Delete comment?</AlertDialogTitle>
                  <AlertDialogDescription>This can’t be undone.</AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction variant="destructive" onClick={() => void remove()}>
                    Delete
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        ) : null}
      </div>

      {editing ? (
        <div className="mt-2 flex flex-col gap-2">
          <textarea
            autoFocus
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                void saveEdit();
              } else if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                setEditing(false);
              }
            }}
            className="min-h-16 w-full resize-none rounded-md border border-input bg-transparent px-2.5 py-1.5 font-mono text-sm text-foreground outline-none [field-sizing:content] focus-visible:border-ring"
          />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setEditing(false)}>
              Cancel
            </Button>
            <Button size="sm" onClick={() => void saveEdit()}>
              Save
            </Button>
          </div>
        </div>
      ) : (
        <div className="mt-1.5">
          <Markdown source={comment.body} />
        </div>
      )}
    </li>
  );
}

/**
 * The bottom-of-feed composer: ⌘-Enter or the send button posts. `onSubmit`
 * (owned by the feed) does the optimistic append + refetch and resolves `false`
 * on failure, so the composer can restore the draft it optimistically cleared.
 */
function Composer({ onSubmit }: { onSubmit: (body: string) => Promise<boolean> }) {
  const [draft, setDraft] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);

  async function submit() {
    const body = draft.trim();
    if (body === "" || submitting) return;
    setSubmitting(true);
    setDraft("");
    const ok = await onSubmit(body);
    setSubmitting(false);
    if (!ok) setDraft(body); // restore so the text isn't lost (failure toasted)
  }

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border bg-card px-3 py-2.5">
      <textarea
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            void submit();
          }
        }}
        placeholder="Add a comment…  (⌘↵ to send)"
        aria-label="Add a comment"
        className="min-h-16 w-full resize-none bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground [field-sizing:content]"
      />
      <div className="flex justify-end">
        <Button
          size="sm"
          disabled={draft.trim() === "" || submitting}
          onClick={() => void submit()}
        >
          <PaperPlaneTiltIcon weight="fill" />
          Comment
        </Button>
      </div>
    </div>
  );
}

/**
 * The Doc tab's Activity feed (ticket-detail-mvp step 4): fetches the ticket's
 * event log + comments on open, merges them into one chronological stream
 * (property changes as muted one-liners, comments as full typeset blocks), and
 * hosts the composer. Every comment mutation refetches both so the feed stays
 * authoritative; optimistic appends keep it responsive in between.
 */
export function TicketActivityFeed({ ticket }: { ticket: Ticket }) {
  const ticketId = ticket.id;
  const [events, setEvents] = React.useState<TicketEvent[]>([]);
  const [comments, setComments] = React.useState<TicketComment[]>([]);
  const [loaded, setLoaded] = React.useState(false);

  const refetch = React.useCallback(async () => {
    try {
      const [ev, cm] = await Promise.all([
        window.api.tickets.events({ ticketId }),
        window.api.comments.list({ ticketId }),
      ]);
      if (!ev.ok) {
        toast.error(`Could not load activity: ${ev.error}`);
        return;
      }
      if (!cm.ok) {
        toast.error(`Could not load activity: ${cm.error}`);
        return;
      }
      setEvents(ev.events);
      setComments(cm.comments);
      setLoaded(true);
    } catch (error) {
      toast.error(`Could not load activity: ${errorMessage(error)}`);
    }
  }, [ticketId]);

  // Comment edits and deletes record no ticket_event (per the comments-repo
  // contract), so they only need the comments re-read — not the whole event log
  // alongside it. Only a NEW comment (which the composer path handles) refetches
  // both.
  const refetchComments = React.useCallback(async () => {
    try {
      const cm = await window.api.comments.list({ ticketId });
      if (!cm.ok) {
        toast.error(`Could not load activity: ${cm.error}`);
        return;
      }
      setComments(cm.comments);
    } catch (error) {
      toast.error(`Could not load activity: ${errorMessage(error)}`);
    }
  }, [ticketId]);

  React.useEffect(() => {
    void refetch();
  }, [refetch]);

  // Post a comment: append an optimistic row immediately, then either refetch
  // the authoritative feed (success — the temp row is replaced) or roll the
  // temp row back (failure — already toasted by writeThrough).
  async function postComment(body: string): Promise<boolean> {
    const tempId = `temp-${crypto.randomUUID()}`;
    const now = Date.now();
    setComments((prev) => [
      ...prev,
      {
        id: tempId,
        ticketId,
        sessionId: null,
        actor: USER_ACTOR,
        body,
        createdAt: now,
        updatedAt: now,
      },
    ]);
    const result = await writeThrough("post comment", () =>
      window.api.comments.create({ ticketId, body }),
    );
    if (!result) {
      setComments((prev) => prev.filter((comment) => comment.id !== tempId));
      return false;
    }
    await refetch();
    return true;
  }

  const feed = buildActivityFeed(events, comments);

  return (
    <section className="flex flex-col gap-4 border-t border-border pt-5">
      <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
        Activity
      </h3>

      {loaded && feed.length === 0 ? (
        <p className="px-1 text-sm text-muted-foreground">No activity yet.</p>
      ) : (
        <ul className="flex flex-col gap-2.5">
          {feed.map((item) =>
            item.kind === "event" ? (
              <EventRow key={item.id} event={item.event} />
            ) : (
              <CommentBlock
                key={item.id}
                comment={item.comment}
                onChanged={() => void refetchComments()}
              />
            ),
          )}
        </ul>
      )}

      <Composer key={ticketId} onSubmit={postComment} />
    </section>
  );
}
