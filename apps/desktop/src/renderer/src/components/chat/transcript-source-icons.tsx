import * as React from "react";
import type { BrowserApi } from "@renderer/components/browser/browser-api";

export interface SourceIconRecord {
  origin: string;
  pictureId: string | null;
  registrableDomain: string | null;
}
/** VC-1141 receiving contract. The desktop bridge adapter is pending integration. */
export interface TranscriptSourceIconsApi {
  watch(
    input: { sessionId: string; origins: string[] },
    onSnapshot: (snapshot: { icons: SourceIconRecord[] }) => void,
  ): () => void;
}
const EMPTY_ICONS: ReadonlyMap<string, SourceIconRecord> = new Map();
export const TranscriptSourceIconContext = React.createContext<{
  icons: ReadonlyMap<string, SourceIconRecord>;
  picture: Pick<BrowserApi, "picture"> | null;
}>({ icons: EMPTY_ICONS, picture: null });

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
  const key = JSON.stringify([...new Set(origins)].toSorted().slice(0, 32));
  const [received, setReceived] = React.useState<{
    key: string;
    sessionId: string;
    icons: ReadonlyMap<string, SourceIconRecord>;
  } | null>(null);
  React.useEffect(() => {
    if (!api) return;
    let active = true;
    const allowed = new Set<string>(JSON.parse(key));
    const unsubscribe = api.watch({ sessionId, origins: [...allowed] }, (snapshot) => {
      if (active)
        setReceived({
          key,
          sessionId,
          icons: new Map(
            snapshot.icons
              .filter((icon) => allowed.has(icon.origin))
              .map((icon) => [icon.origin, icon]),
          ),
        });
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [api, sessionId, key]);
  const icons =
    received?.key === key && received.sessionId === sessionId ? received.icons : EMPTY_ICONS;
  const value = React.useMemo(() => ({ icons, picture: picture ?? null }), [icons, picture]);
  return (
    <TranscriptSourceIconContext.Provider value={value}>
      {children}
    </TranscriptSourceIconContext.Provider>
  );
}
