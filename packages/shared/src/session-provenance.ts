/**
 * Who started a Session (VC-112, "Observability"; VC-131).
 *
 * One rule sits above this file: **a Session a Run created must be
 * distinguishable from one a person started, everywhere a Session appears.**
 * That makes provenance a property of the Session rather than a badge on one
 * screen, which is why the vocabulary lives here — beside `session.ts`, in the
 * package both processes read — instead of inside whichever surface drew the
 * first mark.
 *
 * **There are exactly three answers, because {@link TicketEventActorKind} has
 * exactly three parties that can start a Session.** A person (`user`), Volli's
 * own machinery (`automation`), and another Session (`session`). No fourth arm
 * may be minted here without a fourth way for a Session to be born, and the
 * `unauthenticated` actor is deliberately NOT one: the built-in policy hands
 * that caller no coordination verb at all, so it cannot reach a Session start —
 * and if it ever could, it names nobody, so there would be nothing for a mark
 * to say. Absence of evidence is not a party.
 *
 * **The `user` arm carries no data on purpose.** It is the resting case and it
 * draws nothing: a rail full of Sessions a person started must gain no
 * persistent visual weight from this feature. Every helper below therefore
 * answers `null`/`false` for it rather than a placeholder string, so a surface
 * that forgets to branch renders nothing instead of rendering noise.
 *
 * Pure and transport-free, like every other module here: main derives one of
 * these from its own durable records and it rides to the renderer on the
 * Session's listing row. The shape is JSON-safe by construction (plain objects,
 * `null` rather than optional fields) because that row crosses an RPC seam —
 * docs/BOUNDARIES.md standing rule 3.
 */

/**
 * The mark one Session carries, as a discriminated union rather than a
 * nullable name: "started by an Automation whose record has since been
 * deleted" and "started by a person" are different facts, and a single
 * `automationName: string | null` beside a `user` default could not tell them
 * apart.
 */
export type SessionProvenance =
  | { kind: "user" }
  | {
      kind: "automation";
      /**
       * The bound Automation's name as it stood at launch, retained after that
       * record is deleted (`AutomationRun.automationName`). `null` is an
       * Unbound Run — one that carried its own Instructions and named no
       * Automation, so there is nothing afterwards to name.
       */
      automationName: string | null;
    }
  | {
      kind: "session";
      /** The parent Session's id — the door a surface with room for one opens. */
      parentSessionId: string;
      /**
       * The parent's title, or `null` for a parent that has none (or has since
       * been deleted). A title is renameable and a mark that quoted a stale one
       * would be worse than a mark that admits it cannot name the parent.
       */
      parentTitle: string | null;
    };

/**
 * The resting answer, as one shared value.
 *
 * A frozen constant rather than a fresh literal per call: main builds one of
 * these for every row in a listing, and the overwhelming majority of rows are
 * this one. Identity is lost the moment it crosses the IPC seam, so this buys
 * nothing on the renderer's side — it is the writer's own economy, and the
 * single place the resting case is spelled.
 */
export const PERSON_STARTED: SessionProvenance = Object.freeze({ kind: "user" });

/**
 * Whether this provenance draws ANY resting mark.
 *
 * The acceptance criterion "a resting rail gains no persistent visual weight
 * from Sessions no Automation started" is a question about a list, and this is
 * how a list asks it: `false` for a person's Session, and `false` for a
 * Session-started one too, because that one's whole mark is a hover tooltip.
 * Only the bolt is resting weight.
 */
export function drawsSessionProvenanceMark(provenance: SessionProvenance): boolean {
  return provenance.kind === "automation";
}

/**
 * The words that ride beside the bolt.
 *
 * "Run once" is the Unbound Run's name in the product already — it is what the
 * ticket rail's menu item creates — so a Run with no Automation behind it is
 * labelled with the act instead of being labelled with nothing. A bolt with no
 * text at all was the alternative and it is worse: the reader would have to
 * know the glyph's meaning before the row said anything, which is the exact
 * failure VC-112 rejects a glyph for on the `session` arm.
 */
export function automationProvenanceName(provenance: {
  readonly automationName: string | null;
}): string {
  return provenance.automationName ?? "Run once";
}

/**
 * The one line a hover tooltip adds for this Session, or `null` when the row
 * has nothing to add.
 *
 * **This is the entire `session` mark**, and no glyph joins it. VC-112 rules
 * that out on a fact rather than a preference: a glyph would answer "an agent
 * started this" and stop there, while the reader's actual question is *which*
 * agent — so the parent's name, in the tooltip every row already has, answers
 * both and costs the resting rail nothing.
 *
 * The `automation` arm gets a line too even though its name is already on
 * screen, because the visible one truncates in a rail this narrow and the
 * tooltip is where the untruncated fact belongs. It leads with the noun so the
 * two lines cannot be confused for each other at a glance.
 *
 * Kept to one short sentence each, per "kept as concise as possible": a tooltip
 * that needs reading twice is a tooltip nobody reads once.
 */
export function sessionProvenanceHoverLine(provenance: SessionProvenance): string | null {
  switch (provenance.kind) {
    case "user":
      return null;
    case "automation":
      return `Automation · ${automationProvenanceName(provenance)}`;
    case "session":
      // A parent we cannot name still says the useful half — that no person
      // opened this Session — rather than falling silent and reading as one a
      // person did.
      return `Started by ${provenance.parentTitle ?? "another Session"}`;
  }
}
