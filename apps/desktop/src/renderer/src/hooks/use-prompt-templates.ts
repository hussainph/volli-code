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
 * their skills. The one re-fetch a person can ask for is `/reload` — see
 * `reload` below — which replays the same fetch without waiting for a project
 * switch, for the commands an author just wrote to disk.
 *
 * The two re-reads differ in what a failure costs, which is why they are not
 * the same code path. A project change starts from nothing, so clearing first
 * is honest: there is no previous project's list worth showing. A `/reload`
 * starts from a list that WORKS, so it holds it until a replacement actually
 * arrives — a failed refresh that emptied the picker would turn a bad read
 * into the loss of every row, and the reader would have asked for it.
 *
 * A missing directory already arrives as an empty list from main, so the only
 * thing that can toast here is a directory that exists and could not be read —
 * which is a real fault and says so, per the surface-every-failure convention.
 * A read whose answer arrives after the reader has moved on says nothing: it
 * is stale, not wrong, and the surface it would speak to is gone.
 */
import * as React from "react";
import { errorMessage, type PromptTemplate, type SkillReference } from "@volli/shared";

import { toastError } from "@renderer/lib/toast";

/** The two tiers, always committed together. */
interface PromptLists {
  readonly templates: readonly PromptTemplate[];
  readonly skills: readonly SkillReference[];
}

export interface PromptSupply extends PromptLists {
  /**
   * Re-read both tiers — `/reload`'s act, and this hook's only refresh.
   *
   * Resolves `true` only when the lists were actually replaced, so the caller
   * can report a refresh that happened rather than one it requested. A refusal
   * has already toasted its own reason by then; a stale answer resolves `false`
   * and says nothing.
   */
  reload(): Promise<boolean>;
}

const NO_LISTS: PromptLists = { templates: [], skills: [] };

type SupplyRead = { ok: true; lists: PromptLists } | { ok: false; error: string };

async function readSupply(projectId: string): Promise<SupplyRead> {
  try {
    const result = await window.api.files.promptTemplates({ projectId });
    if (!result.ok) return { ok: false, error: result.error };
    return { ok: true, lists: { templates: result.templates, skills: result.skills } };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

export function usePromptTemplates(projectId: string | null): PromptSupply {
  const [lists, setLists] = React.useState<PromptLists>(NO_LISTS);
  // One counter for both readers. A project change and a `/reload` are the
  // same race against each other as against themselves: whichever read was
  // asked for last is the only one whose answer may land, so a reload in
  // flight when the project changes cannot overwrite the new project's rows.
  const readRef = React.useRef(0);

  React.useEffect(() => {
    const read = (readRef.current += 1);
    setLists(NO_LISTS);
    // No project selected is not a project that failed to load: some mounts
    // (Home with nothing selected) legitimately have no id.
    if (projectId === null) return;
    void (async () => {
      const result = await readSupply(projectId);
      if (readRef.current !== read) return;
      if (!result.ok) {
        toastError(`Couldn't load commands: ${result.error}`);
        return;
      }
      setLists(result.lists);
    })();
  }, [projectId]);

  const reload = React.useCallback(async () => {
    // `/reload` is refused before it is pressed when there is no project
    // (`RELOAD_VERB.refusal`); this is the same fact held where the act is.
    if (projectId === null) return false;
    const read = (readRef.current += 1);
    const result = await readSupply(projectId);
    if (readRef.current !== read) return false;
    if (!result.ok) {
      toastError(`Couldn't load commands: ${result.error}`);
      return false;
    }
    setLists(result.lists);
    return true;
  }, [projectId]);

  return React.useMemo(() => ({ ...lists, reload }), [lists, reload]);
}
