/**
 * The refusal a background shell port answers with when it judged an action
 * and declined it (VC-270) — {@link ../browser/refusal.BrowserRefusal}'s
 * bargain, spelled for shells, and typed here so the runtime's tools and the
 * desktop's host agree on what a refusal is without either importing the
 * other's internals.
 *
 * A refusal is the policy working, not the port failing: the action was
 * understood, judged and not performed, and the model is the party that can
 * act on that — by killing a shell it no longer needs, naming one it holds, or
 * continuing without. The tools translate it into readable text rather than a
 * failed call; anything else a port throws is a host that could not answer at
 * all, and fails the call as every broken port does.
 *
 * `rule` is an open string for the reason the browser's is: the rules belong
 * to the host that enforces them (`shell.limit`, `shell.unknown`,
 * `shell.exited`, `shell.cwd`), and the runtime's only obligation is to name
 * the rule in the transcript so a person can find the policy that produced it.
 */
export class ShellRefusal extends Error {
  readonly rule: string;

  constructor(rule: string, reason: string) {
    super(reason);
    this.name = "ShellRefusal";
    this.rule = rule;
  }
}
