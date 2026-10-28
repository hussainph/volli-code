/** Finding a saved Automation by name, for the agent's `automation_run`. */
/**
 * One saved Automation, found the way a person finds one: by what it is called.
 *
 * Matched case-insensitively, and by id as well, so an id read out of a Run
 * record still works. Where a project's own Automation and a global one share a
 * name the project's own wins — which is the app's listing rule
 * (`listAutomationsForProject` orders the project's first), not a rule invented
 * here. A name that still matches two records is refused rather than guessed:
 * two Automations with one name do different work, and starting the wrong one
 * spends a model and writes a Session.
 *
 * One rule for both `automation_run` doors: the local Run door's records and
 * Volli Cloud's (`automations.list`, all project-scoped) alike.
 */
export function resolveAutomationByName<
  T extends { id: string; name: string; projectId: string | null },
>(listed: readonly T[], named: string): { ok: true; automation: T } | { ok: false; text: string } {
  const wanted = named.toLowerCase();
  const matches = listed.filter(
    (automation) => automation.id === named || automation.name.trim().toLowerCase() === wanted,
  );
  if (matches.length === 0) {
    const names = listed.map((automation) => JSON.stringify(automation.name)).join(", ");
    return {
      ok: false,
      text:
        listed.length === 0
          ? `No Automation called ${JSON.stringify(named)} here, and this project lists none at all, so nothing was started. A person creates one in the app first.`
          : `No Automation called ${JSON.stringify(named)} in this project, so nothing was started. This project lists: ${names}.`,
    };
  }
  const own = matches.filter((automation) => automation.projectId !== null);
  const preferred = own.length > 0 ? own : matches;
  if (preferred.length > 1) {
    return {
      ok: false,
      text: `This project lists more than one Automation called ${JSON.stringify(named)}, so nothing was started rather than the wrong one. Ask a person which to run, or have the duplicate renamed.`,
    };
  }
  return { ok: true, automation: preferred[0]! };
}
