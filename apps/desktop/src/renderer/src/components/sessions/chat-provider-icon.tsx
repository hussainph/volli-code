/** Badge-free chat artwork for compact Session identities. Like a standalone
 * tab, prefer the resident model selection to the saved Session's provider. */
import { ModelArtwork, providerMark } from "@renderer/components/models/model-identity";
import { ChatIcon } from "@renderer/components/ui/icon";
import { useChatSessionsStore } from "@renderer/stores/chat-sessions";

export function ChatProviderIcon({
  sessionId,
  savedProviderId,
}: {
  sessionId: string | null;
  savedProviderId: string | null;
}) {
  const liveProvider = useChatSessionsStore((state) =>
    sessionId === null
      ? null
      : (state.sessions[sessionId]?.projection?.modelSelection?.providerId ?? null),
  );
  const providerId = liveProvider ?? savedProviderId;
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
