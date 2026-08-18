/**
 * The prompt templates and skills behind the composer's `/` picker.
 *
 * Deliberately plainer than {@link useFileIndex} beside it, because the thing
 * it fetches is: a commands directory holds a handful of hand-written files
 * and a skills directory a handful of installed ones, not twenty thousand
 * repo paths, so there is no cache window to gate, no force-refresh moment to
 * model, and no version counter for a decoration layer to re-resolve against.
 * One fetch per project, held in state, re-fetched when the project changes.
 * The two lists ride one IPC answer, so they land in one state commit and the
 * picker never shows a half-loaded frame where the commands arrived without
 * their skills.
 *
 * A missing directory already arrives as an empty list from main, so the only
 * thing that can toast here is a directory that exists and could not be read —
 * which is a real fault and says so, per the surface-every-failure convention.
 */
import * as React from "react";
import { errorMessage, type PromptTemplate, type SkillReference } from "@volli/shared";

import { toastError } from "@renderer/lib/toast";

export interface PromptSupply {
  readonly templates: readonly PromptTemplate[];
  readonly skills: readonly SkillReference[];
}

const NO_SUPPLY: PromptSupply = { templates: [], skills: [] };

export function usePromptTemplates(projectId: string | null): PromptSupply {
  const [supply, setSupply] = React.useState<PromptSupply>(NO_SUPPLY);

  React.useEffect(() => {
    let live = true;
    setSupply(NO_SUPPLY);
    // No project selected is not a project that failed to load: some mounts
    // (Home with nothing selected) legitimately have no id.
    if (projectId === null) return undefined;
    void (async () => {
      try {
        const result = await window.api.files.promptTemplates({ projectId });
        if (!live) return;
        if (!result.ok) {
          toastError(`Couldn't load commands: ${result.error}`);
          return;
        }
        setSupply({ templates: result.templates, skills: result.skills });
      } catch (error) {
        if (live) toastError(`Couldn't load commands: ${errorMessage(error)}`);
      }
    })();
    return () => {
      live = false;
    };
  }, [projectId]);

  return supply;
}
