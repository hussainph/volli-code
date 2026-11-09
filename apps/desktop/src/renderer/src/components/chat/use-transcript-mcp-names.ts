import * as React from "react";
import { transcriptMcpNames, type ChatSessionFrame } from "@volli/session-presentation";
import type { McpServerRecord } from "@volli/shared";

const NO_SERVERS: readonly McpServerRecord[] = [];

/** Stored catalog metadata only: no MCP connection, discovery or model call. */
export function useTranscriptMcpNames(
  projectId: string,
  frames: readonly ChatSessionFrame[],
  toolNamesKey: string,
  local: boolean,
) {
  const [snapshot, setSnapshot] = React.useState<{
    projectId: string;
    servers: readonly McpServerRecord[];
  } | null>(null);
  React.useEffect(() => {
    const api = typeof window === "undefined" ? undefined : window.api?.mcp;
    if (!local || toolNamesKey === "[]" || !api?.list) return;
    let active = true;
    let generation = 0;
    const load = async () => {
      const requested = ++generation;
      try {
        const result = await api.list({ projectId });
        if (active && requested === generation && result.ok)
          setSnapshot({ projectId, servers: result.servers });
      } catch {
        // Optional display enrichment keeps the recorded namespace fallback.
        // No mutation failed and no untrusted provider diagnostic is logged.
      }
    };
    const refresh = () => {
      void load();
    };
    refresh();
    window.addEventListener("focus", refresh);
    return () => {
      active = false;
      generation += 1;
      window.removeEventListener("focus", refresh);
    };
  }, [projectId, toolNamesKey, local]);
  const servers = local && snapshot?.projectId === projectId ? snapshot.servers : NO_SERVERS;
  return React.useMemo(() => transcriptMcpNames(frames, servers), [frames, servers]);
}
