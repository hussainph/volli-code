/**
 * The prompt templates behind the composer's `/` picker.
 *
 * Deliberately plainer than {@link useFileIndex} beside it, because the thing
 * it fetches is: a commands directory holds a handful of hand-written files,
 * not twenty thousand repo paths, so there is no cache window to gate, no
 * force-refresh moment to model, and no version counter for a decoration layer
 * to re-resolve against. One fetch per project, held in state, re-fetched when
 * the project changes.
 *
 * A missing directory already arrives as an empty list from main, so the only
 * thing that can toast here is a directory that exists and could not be read —
 * which is a real fault and says so, per the surface-every-failure convention.
 */
import * as React from "react";
import { errorMessage, type PromptTemplate } from "@volli/shared";

import { toastError } from "@renderer/lib/toast";

const NO_TEMPLATES: readonly PromptTemplate[] = [];

export function usePromptTemplates(projectId: string): readonly PromptTemplate[] {
  const [templates, setTemplates] = React.useState<readonly PromptTemplate[]>(NO_TEMPLATES);

  React.useEffect(() => {
    let live = true;
    setTemplates(NO_TEMPLATES);
    void (async () => {
      try {
        const result = await window.api.files.promptTemplates({ projectId });
        if (!live) return;
        if (!result.ok) {
          toastError(`Couldn't load commands: ${result.error}`);
          return;
        }
        setTemplates(result.templates);
      } catch (error) {
        if (live) toastError(`Couldn't load commands: ${errorMessage(error)}`);
      }
    })();
    return () => {
      live = false;
    };
  }, [projectId]);

  return templates;
}
