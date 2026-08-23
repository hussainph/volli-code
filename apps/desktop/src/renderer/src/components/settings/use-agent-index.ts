/**
 * The one read behind Configure's Skills and Commands panes.
 *
 * Both draw from `volli:prompt-templates`, which returns them together because
 * they share a namespace at submit — so one fetch, shared, rather than two
 * panes racing the same directory walk.
 *
 * Token-guarded through `useLatestAsync` for the reason every other re-entrant
 * read here is: mount, the refresh button and a post-write reload can all be in
 * flight at once, and the answer that lands must be the one asked for last
 * rather than whichever `readdir` finished last.
 */
import * as React from "react";
import { errorMessage, type PromptTemplate, type SkillReference } from "@volli/shared";

import { useLatestAsync } from "@renderer/hooks/use-latest-async";
import type { AsyncState } from "./kit";

export interface AgentIndex {
  templates: readonly PromptTemplate[];
  skills: readonly SkillReference[];
}

export function useAgentIndex(projectId: string | null): {
  state: AsyncState<AgentIndex>;
  reload: () => void;
} {
  const [state, setState] = React.useState<AsyncState<AgentIndex>>({ status: "loading" });
  const fetcher = useLatestAsync();

  const load = React.useCallback(async () => {
    if (projectId === null) {
      setState({ status: "ready", data: { templates: [], skills: [] } });
      return;
    }
    const token = fetcher.claim();
    setState({ status: "loading" });
    try {
      // `ruled: false` — the UNRULED skill list. These panes edit the rules,
      // so an `off` skill must keep its row here to be turned back on; the
      // composer's own hook takes the ruled default instead.
      const result = await window.api.files.promptTemplates({ projectId, ruled: false });
      if (!fetcher.isCurrent(token)) return;
      if (!result.ok) {
        setState({ status: "error", message: result.error, onRetry: () => void load() });
        return;
      }
      setState({
        status: "ready",
        data: { templates: result.templates, skills: result.skills },
      });
    } catch (error) {
      if (!fetcher.isCurrent(token)) return;
      setState({ status: "error", message: errorMessage(error), onRetry: () => void load() });
    }
  }, [projectId, fetcher]);

  React.useEffect(() => {
    void load();
    return () => fetcher.invalidate();
  }, [load, fetcher]);

  return { state, reload: () => void load() };
}
