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
/**
 * `RuntimeBrowserPage` restated, so this file stays the one place a refusal is
 * defined and does not reach into the domain package for a shape a host hands
 * it. The desktop port builds it from the tab state it already holds.
 */
export interface BrowserRefusalPage {
  tabId: string;
  url: string;
  title: string;
  ownerSessionId: string | null;
  /** The tab's own load failure, if it had one, in Volli's words. */
  error: string | null;
}

export class BrowserRefusal extends Error {
  readonly rule: string;
  /**
   * The tab the refused call was aimed at, once a port has resolved one
   * (VC-238 §3). A refused call never read a page, so this is Volli's own
   * record of the tab rather than anything the page said — it exists so the
   * transcript row can say WHERE nothing happened instead of naming a bare
   * ref. Null for a refusal raised before any tab was in hand: a bad target,
   * or a cap that stopped the tab being opened at all.
   */
  readonly page: BrowserRefusalPage | null;

  constructor(rule: string, reason: string, page: BrowserRefusalPage | null = null) {
    super(reason);
    this.name = "BrowserRefusal";
    this.rule = rule;
    this.page = page;
  }

  /**
   * The same refusal, told against the page it was aimed at. A refusal that
   * already names one keeps it: the innermost port to hold the tab knows it
   * best, and an outer frame must not overwrite it with a later state.
   */
  onPage(page: BrowserRefusalPage): BrowserRefusal {
    return this.page === null ? new BrowserRefusal(this.rule, this.message, page) : this;
  }
}
