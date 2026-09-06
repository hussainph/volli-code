/**
 * Who holds a Browser Tab — whose turn it is to drive it (VC-239).
 *
 * Domain vocabulary, not transport: every client that shows a held tab — the
 * desktop's chrome pill, its tab-strip dot, the Session cursor main paints
 * over the page, and any client a future host serves — reads the same
 * record. At most one party holds a tab at a time: one Session, or the
 * person; `null` is a free tab.
 *
 * A Session's `name` and `color` travel with the hold rather than being
 * looked up by each surface, so surfaces that share nothing but this record
 * agree on both. The colour is identity, never state ({@link sessionColor}),
 * resolved by the host across every live holder so concurrent Sessions
 * differ; a client cannot re-derive that collision resolution from an id.
 *
 * The runtime's own view of the same fact, {@link RuntimeBrowserHolder},
 * carries `self` instead of a name and colour: a model is told "you" or
 * "Session X", never a hue.
 */
export type BrowserTabSessionHolder = {
  kind: "session";
  sessionId: string;
  name: string;
  color: string;
};

export type BrowserTabHolder = BrowserTabSessionHolder | { kind: "person" };
