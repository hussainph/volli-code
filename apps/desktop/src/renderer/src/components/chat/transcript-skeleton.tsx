/**
 * What a chat with history draws while that history is on its way (VC-383).
 *
 * Opening a Session that has lived a while takes one `session.snapshot` round
 * trip — the whole log, folded on main, one artifact read per turn — and until
 * it lands the plane holds no messages. It used to answer that with the same
 * branch a brand-new chat takes: the empty state's venue drawing, a picture
 * that says "nothing has ever been said here". For a Session with a thousand
 * turns that is not a wait, it is a false statement, and the person reading it
 * has no way to tell which of the two they are looking at.
 *
 * This holds the box instead. Two exchanges' worth of the transcript's own
 * geometry — the same `ContentColumn`, the same `Message` alignment, the same
 * gap the real rows keep — so the first paint of history lands where the bars
 * were and nothing jumps. It carries NO words: a "Loading…" caption would sit
 * where the first message is about to, and a skeleton that reads as a row is
 * one that is not read at all.
 *
 * Shown only while the plane can say history is PENDING: the projection is
 * still `null` and the Session is not a provisional Draft (a Draft has never
 * been minted, so its null projection is the truth, and the empty state is
 * right for it). The moment the snapshot lands, `messages` decides as before.
 */
import { ContentColumn } from "@renderer/components/layout/content-column";
import { Message, MessageContent } from "@renderer/components/ui/ai-elements/message";
import { Skeleton } from "@renderer/components/ui/skeleton";

/** The transcript's own inter-row rhythm (`MESSAGE_GAP` in chat-plane.tsx). */
const ROW_GAP = "flex flex-col gap-6";

export function TranscriptSkeleton() {
  return (
    <ContentColumn
      className={ROW_GAP}
      role="status"
      aria-label="Loading conversation"
      aria-busy="true"
      data-testid="chat-transcript-loading"
    >
      <UserRow width="w-2/5" />
      <AssistantRow widths={["w-4/5", "w-full", "w-3/5"]} />
      <UserRow width="w-1/3" />
      <AssistantRow widths={["w-3/4", "w-1/2"]} />
    </ContentColumn>
  );
}

/** A person's message: the muted bubble, right-aligned, at a plausible width. */
function UserRow({ width }: { width: string }) {
  return (
    <Message from="user" className="max-w-full">
      <MessageContent className={`${width} rounded-xl px-4 py-2`}>
        <Skeleton className="h-4 w-full" />
      </MessageContent>
    </Message>
  );
}

/** An assistant reply: prose lines at `text-sm`'s 20px rhythm, left-aligned. */
function AssistantRow({ widths }: { widths: readonly string[] }) {
  return (
    <Message from="assistant" className="max-w-full">
      <MessageContent className="w-full gap-1.5">
        {widths.map((width) => (
          <Skeleton key={width} className={`h-3.5 ${width}`} />
        ))}
      </MessageContent>
    </Message>
  );
}
