import * as React from "react";
import type { BrowserApi } from "@renderer/components/browser/browser-api";
import {
  isCanonicalSourceOrigin,
  SOURCE_ICON_ORIGIN_LIMIT,
  type SourceIconsSnapshot,
} from "@volli/shared";
import type { TranscriptSourceIconsTransport } from "@renderer/chat/transport";

export type SourceIconRecord = SourceIconsSnapshot["icons"][number];
export type TranscriptSourceIconsApi = TranscriptSourceIconsTransport;
const EMPTY_ICONS: ReadonlyMap<string, SourceIconRecord> = new Map();
export const TranscriptSourceIconContext = React.createContext<{
  icons: ReadonlyMap<string, SourceIconRecord>;
  picture: Pick<BrowserApi, "picture"> | null;
  sessionId: string | null;
}>({ icons: EMPTY_ICONS, picture: null, sessionId: null });

/** One bounded cache-only observer per visible transcript, never per chip. */
export function TranscriptSourceIcons({
  sessionId,
  origins,
  api,
  picture,
  children,
}: React.PropsWithChildren<{
  sessionId: string;
  origins: readonly string[];
  api?: TranscriptSourceIconsApi;
  picture?: Pick<BrowserApi, "picture">;
}>) {
  const key = JSON.stringify(
    [...new Set(origins.filter(isCanonicalSourceOrigin))]
      .toSorted()
      .slice(0, SOURCE_ICON_ORIGIN_LIMIT),
  );
  const [received, setReceived] = React.useState<{
    key: string;
    sessionId: string;
    api: TranscriptSourceIconsApi;
    icons: ReadonlyMap<string, SourceIconRecord>;
  } | null>(null);
  React.useEffect(() => {
    if (!api) return;
    let active = true;
    const allowed = new Set<string>(JSON.parse(key));
    let unsubscribe: (() => void) | undefined;
    try {
      unsubscribe = api.watch({ sessionId, origins: [...allowed] }, (snapshot) => {
        if (active)
          setReceived({
            key,
            sessionId,
            api,
            icons: new Map(
              snapshot.icons
                .filter((icon) => allowed.has(icon.origin))
                .map((icon) => [icon.origin, icon]),
            ),
          });
      });
    } catch {
      // Optional cache enrichment is not a failed tool call. Old/unavailable
      // hosts retain the same tile; no renderer request can acquire an icon.
      if (active) setReceived({ key, sessionId, api, icons: EMPTY_ICONS });
    }
    return () => {
      active = false;
      unsubscribe?.();
    };
  }, [api, sessionId, key]);
  const icons =
    api !== undefined &&
    received?.api === api &&
    received.key === key &&
    received.sessionId === sessionId
      ? received.icons
      : EMPTY_ICONS;
  const value = React.useMemo(
    () => ({ icons, picture: picture ?? null, sessionId }),
    [icons, picture, sessionId],
  );
  return (
    <TranscriptSourceIconContext.Provider value={value}>
      {children}
    </TranscriptSourceIconContext.Provider>
  );
}
