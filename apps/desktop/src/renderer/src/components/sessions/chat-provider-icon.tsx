/** Compact chat artwork, optionally badged for a member row. Like a standalone
 * tab, prefer the resident model selection to the saved Session's provider. */
import {
  ModelArtwork,
  providerMark,
  providerLabelOf,
  providerIdentityOf,
} from "@renderer/components/models/model-identity";
import { SessionGlyph } from "@renderer/components/sessions/session-glyph";
import type { StatusDotState } from "@renderer/components/ui/status-dot";
import { useModelCatalogue } from "@renderer/lib/use-model-catalogue";
import { ChatIcon } from "@renderer/components/ui/icon";
import { useChatSessionsStore } from "@renderer/stores/chat-sessions";

export function ChatProviderIcon({
  sessionId,
  savedProviderId,
  state,
}: {
  sessionId: string | null;
  savedProviderId: string | null;
  /** Member rows announce state through the glyph, not a second status label. */
  state?: StatusDotState;
}) {
  const liveProvider = useChatSessionsStore((store) =>
    sessionId === null
      ? null
      : (store.sessions[sessionId]?.projection?.modelSelection?.providerId ?? null),
  );
  const providerId = liveProvider ?? savedProviderId;
  if (state !== undefined) return <ChatMemberGlyph providerId={providerId} state={state} />;
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

function ChatMemberGlyph({
  providerId,
  state,
}: {
  providerId: string | null;
  state: StatusDotState;
}) {
  const providers = useModelCatalogue()?.providers ?? [];
  const providerLabel = providerId === null ? "Chat" : providerLabelOf(providers, providerId);
  const identity = providerId === null ? undefined : providerIdentityOf(providers, providerId);
  return (
    <SessionGlyph
      providerId={providerId}
      providerLabel={providerLabel}
      state={state}
      kind="chat"
      name={`${identity ?? providerLabel}, ${state}`}
      size="row"
      surface="popover"
    />
  );
}
