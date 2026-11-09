/** Badge-free chat artwork for compact Session identities. Like a standalone
 * tab, prefer the resident model selection to the saved Session's provider. */
import { ModelArtwork, providerMark } from "@renderer/components/models/model-identity";
import { ChatIcon } from "@renderer/components/ui/icon";
import { useChatSessionsStore } from "@renderer/stores/chat-sessions";
import { useProjectSessionsStore } from "@renderer/stores/project-sessions";
import { useTicketSessionRecordsStore } from "@renderer/stores/ticket-session-records";

export function ChatProviderIcon({
  sessionId,
  projectId,
  ticketId,
}: {
  sessionId: string | null;
  projectId: string;
  ticketId?: string;
}) {
  const liveProvider = useChatSessionsStore((state) =>
    sessionId === null
      ? null
      : (state.sessions[sessionId]?.projection?.modelSelection?.providerId ?? null),
  );
  const projectProvider = useProjectSessionsStore(
    (state) =>
      state.byProject[projectId]?.chat.find((record) => record.sessionId === sessionId)?.model
        ?.providerId ?? null,
  );
  const ticketProvider = useTicketSessionRecordsStore((state) => {
    const row =
      ticketId === undefined
        ? undefined
        : state.byTicket[ticketId]?.find(
            (candidate) => candidate.kind === "chat" && candidate.record.sessionId === sessionId,
          );
    return row?.kind === "chat" ? (row.record.model?.providerId ?? null) : null;
  });
  const providerId = liveProvider ?? ticketProvider ?? projectProvider;
  // Match SessionGlyph: an unknown provider keeps the chat glyph, not a lettermark.
  if (providerId === null || providerMark(providerId) === null) {
    return <ChatIcon aria-hidden strokeWidth={2.25} className="size-full text-muted-foreground" />;
  }
  return (
    <ModelArtwork
      model={{ providerId, modelId: providerId, label: providerId }}
      providerLabel={providerId}
      by="provider"
      className="size-full"
    />
  );
}
