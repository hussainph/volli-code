/**
 * The refusal a Browser port answers with when it judged an action and
 * declined it — the browser half of {@link ../web/safe-fetch.WebFetchRefusal}'s
 * bargain, and typed here so the runtime's tools and the desktop's host agree
 * on what a refusal is without either importing the other's internals.
 *
 * A refusal is the policy working, not the port failing: the action was
 * understood, judged and not performed, and the model is the party that can
 * act on that — by taking a fresh snapshot, naming a different tab, or
 * continuing without. The tools translate it into readable text rather than a
 * failed call; anything else a port throws is a host that could not answer at
 * all, and fails the call as every broken port does.
 *
 * `rule` is an open string rather than a closed union, deliberately: the rules
 * belong to the host that enforces them (stale generations, tab visibility,
 * navigation policy), and the runtime's only obligation is to name the rule in
 * the transcript so a person can find the policy that produced it. A closed
 * union here would make every new host rule a runtime release.
 */
export class BrowserRefusal extends Error {
  readonly rule: string;

  constructor(rule: string, reason: string) {
    super(reason);
    this.name = "BrowserRefusal";
    this.rule = rule;
  }
}
