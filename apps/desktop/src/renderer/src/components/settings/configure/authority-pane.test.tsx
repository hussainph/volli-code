/**
 * Configure → Authority, the door VC-172 added.
 *
 * WHAT THIS LAYER CAN SEE. These render to static markup, which is the house
 * pattern for a pane — and a Radix `Select` renders its trigger with an EMPTY
 * value span there, while an `InfoHint` keeps its prose in an unopened popover.
 * So neither the selected word nor the hint text is assertable here, and
 * pretending otherwise would be a test that passes on markup nobody sees.
 *
 * What IS assertable is the thing worth pinning: which rows exist, and which of
 * them are marked as having departed from the built-in defaults. Divergence is
 * `OverrideControl`'s revert button, its `aria-label` names the inherited value
 * it would return to, and both render. That is the inheritance model itself —
 * the reason the pane stores departures rather than a resolved document.
 *
 * VC-285 adds a second assertable class, and it is assertable for the same
 * reason it was added: the outcome of the selected posture, the unit each
 * threshold counts in, and the attachment cue are PLAIN TEXT in the rows. A
 * popover would be invisible here — which is exactly what a person looking at
 * the pane experienced.
 */
import { DEFAULT_AUTHORITY_POLICY, type Project } from "@volli/shared";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { TooltipProvider } from "@renderer/components/ui/tooltip";

import { configureGroups } from "../configure-groups";
import { AuthorityPane } from "./authority-pane";

function project(authorityPolicy: Project["authorityPolicy"] = null): Project {
  return {
    id: "p1",
    name: "Volli Code",
    path: "/repo/volli",
    ticketPrefix: "VC",
    baseBranch: "trunk",
    setupCommand: null,
    colorIndex: 0,
    sortOrder: 0,
    createdAt: 0,
    updatedAt: 0,
    authorityPolicy,
  };
}

function render(policy: Project["authorityPolicy"] = null): string {
  return renderToStaticMarkup(
    <TooltipProvider>
      <AuthorityPane project={project(policy)} />
    </TooltipProvider>,
  );
}

/** The rail terms that lead to this pane: the category's own label and its keywords. */
function authorityKeywords(): readonly string[] {
  for (const group of configureGroups(project())) {
    for (const category of group.categories) {
      if (category.key === "authority") return [category.label, ...(category.keywords ?? [])];
    }
  }
  throw new Error("no Configure category `authority`");
}

const ENTITIES: Readonly<Record<string, string>> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#x27;": "'",
  "&rsquo;": "\u2019",
};

/**
 * Static markup escapes the few entities a label can carry; search compares the
 * words.
 *
 * ONE PASS, not a chain of replacements. Decoding `&amp;` before the others
 * turns `&amp;lt;` into `<` — a label written to show an entity would be read
 * as the character it names, and the check would then hold the rail to words
 * the pane never drew.
 */
function decodeEntities(text: string): string {
  return text.replace(/&(?:amp|lt|gt|quot|#x27|rsquo);/g, (entity) => ENTITIES[entity] ?? entity);
}

describe("Configure → Authority", () => {
  it("gives every settable part of the policy a row", () => {
    // The ticket's list of what was settable in principle and unsettable in
    // practice: enforcement, judgment, both thresholds, and the per-actor
    // policy for each of VC-92's three actor kinds.
    const html = render(null);

    for (const testId of [
      "authority-enforcement",
      "authority-judgment",
      "authority-consecutive-denials",
      "authority-session-denials",
      "authority-peek-user",
      "authority-peek-session",
      "authority-peek-unauthenticated",
    ]) {
      expect(html).toContain(`data-testid="${testId}"`);
    }
  });

  it("marks nothing as overridden for a project that has stated nothing", () => {
    // The only state that was reachable before this pane existed: every project
    // resolved to the compiled defaults, permanently.
    expect(render(null)).not.toContain('aria-label="Reset ');
  });

  it("marks the departed row, naming the value its revert returns to", () => {
    const html = render({ enforcement: "enforce" });

    expect(html).toContain("Reset Rule enforcement to the app-wide value, Observe");
    // And ONLY that row. A departure on one field must not mark the rest, or
    // the surface would report departures the stored document does not hold.
    expect(html).not.toContain("Reset Decision mode");
    expect(html).not.toContain("Reset An authenticated session can read");
  });

  it("marks one actor without marking the others", () => {
    const html = render({ actors: { session: { peek: "project" } } });

    expect(html).toContain(
      "Reset An authenticated session can read to the app-wide value, Its own only",
    );
    expect(html).not.toContain("Reset An unauthenticated caller can read");
    expect(html).not.toContain("Reset You can read");
  });

  it("shows the inherited thresholds a Session escalates on", () => {
    const html = render(null);

    expect(html).toContain(`value="${DEFAULT_AUTHORITY_POLICY.fallback.consecutiveDenials}"`);
    expect(html).toContain(`value="${DEFAULT_AUTHORITY_POLICY.fallback.sessionDenials}"`);
  });

  it("shows a departed threshold and leaves the one beside it inheriting", () => {
    const html = render({ fallback: { consecutiveDenials: 7 } });

    expect(html).toContain('value="7"');
    expect(html).toContain("Reset Ask me after to the app-wide value, 3 denials in a row");
    // The additive half of the design: a partial `fallback` must not pin the
    // field it says nothing about.
    expect(html).toContain(`value="${DEFAULT_AUTHORITY_POLICY.fallback.sessionDenials}"`);
    expect(html).not.toContain("Reset Or after, in total");
  });

  /*
   * ── VC-285: the outcome is on the surface ──────────────────────────────
   * The audit's finding was that "Observe" beside "Ask me" reads as active
   * protection, and that the meanings were hidden in information popovers. So
   * what each posture DOES is asserted here as text in the row.
   */
  it("says what each posture does beside the control, not in a popover", () => {
    expect(render({ enforcement: "off" })).toContain("Off — no authority checks.");
    expect(render(null)).toContain("Observe — save this attachment’s policy; allow calls.");
    expect(render({ enforcement: "enforce" })).toContain("Enforce — block rule violations.");
  });

  it("says when a person is asked, and only under Enforce", () => {
    expect(render({ enforcement: "enforce" })).toContain("Ask after the limits below.");
    expect(render(null)).not.toContain("Ask after the limits below.");
    expect(render({ enforcement: "off" })).not.toContain("Ask after the limits below.");
  });

  it("shows one posture's outcome at a time", () => {
    const html = render({ enforcement: "enforce" });

    expect(html).not.toContain("no authority checks");
    expect(html).not.toContain("save this attachment’s policy");
  });

  /*
   * The second half of the audit's complaint: a policy edit looked as though it
   * would change a running Session. It never did — an attachment pins the
   * policy it opened under — and the row where enforcement is changed now says
   * so without being opened.
   */
  it("says that a change reaches new attachments, where the change is made", () => {
    for (const policy of [null, { enforcement: "off" as const }]) {
      const html = render(policy);
      expect(html).toContain("Applies to new attachments");
      expect(html).toContain("the live connection a Session runs on");
    }
  });

  it("carries each threshold's unit beside the number", () => {
    const html = render(null);

    expect(html).toContain("denials in a row");
    expect(html).toContain("denials total");
  });

  /*
   * Under Off and Observe nothing is refused, so nothing can accumulate toward
   * a limit. The controls keep their values — they are still the policy the
   * next Enforce attachment would run under — and stop pretending to be live.
   */
  it("makes the thresholds inert while calls are allowed, keeping their values", () => {
    for (const policy of [null, { enforcement: "off" as const }]) {
      const html = render(policy);
      expect(html).toContain("Not active while calls are allowed.");
      expect(html).toContain(`value="${DEFAULT_AUTHORITY_POLICY.fallback.consecutiveDenials}"`);
      expect(html).toContain(`value="${DEFAULT_AUTHORITY_POLICY.fallback.sessionDenials}"`);
      expect(html.match(/<input[^>]*disabled=""/g) ?? []).toHaveLength(2);
    }
  });

  it("also disables an overridden threshold's reset while that threshold is inactive", () => {
    const inactive = render({ fallback: { consecutiveDenials: 7 } });
    const active = render({
      enforcement: "enforce",
      fallback: { consecutiveDenials: 7 },
    });
    const reset = /<button[^>]*aria-label="Reset Ask me after[^"]*"[^>]*>/;

    expect(inactive.match(reset)?.[0]).toContain('disabled=""');
    expect(active.match(reset)?.[0]).not.toContain('disabled=""');
  });

  it("spells out what each limit means once Enforce is what runs", () => {
    const html = render({ enforcement: "enforce" });

    expect(html).toContain("Asks a person when a call would reach 3 denials in a row.");
    expect(html).toContain("Asks a person when a call would reach 20 denials across the Session.");
    expect(html).not.toContain("Not active while calls are allowed.");
    expect(html.match(/<input[^>]*disabled=""/g) ?? []).toHaveLength(0);
  });

  it("reads a departed threshold back in the same sentence", () => {
    const html = render({ enforcement: "enforce", fallback: { consecutiveDenials: 7 } });

    expect(html).toContain("Asks a person when a call would reach 7 denials in a row.");
  });

  it("describes a limit of one as asking on that would-be denial, not after it", () => {
    const html = render({ enforcement: "enforce", fallback: { consecutiveDenials: 1 } });

    expect(html).toContain("Asks a person when a call would reach 1 denial in a row.");
    expect(html).not.toContain("after 1 denied call");
  });

  /*
   * `judgmentMode` rides the Snapshot and has no runtime reader until VC-28.
   * The row may still be set — it is durable policy — but it must not be read
   * as the thing deciding calls today, which is what "Who judges the rest: Ask
   * me" claimed.
   */
  it("does not present the decision mode as protection that runs today", () => {
    const html = render(null);

    expect(html).toContain("Decision mode — not active yet");
    expect(html).not.toContain("Who judges the rest");
  });

  it("keeps the decision mode revert readable, whatever the row is called", () => {
    expect(render({ judgmentMode: "auto" })).toContain(
      "Reset Decision mode to the app-wide value, Ask me",
    );
  });

  /**
   * The rail's search index against the pane it indexes — the same rule
   * `settings-search-smoke.mjs` states in minutes, stated here in
   * milliseconds, because a row someone can SEE and cannot FIND is a setting
   * that may as well not be there.
   *
   * It is renaming that breaks this, not adding: VC-285 renamed "Who judges
   * the rest" to "Decision mode — not active yet" and the keyword stayed
   * behind, pointing at words nobody could see any more. Only labels are
   * checked, because the shell matches a stored term against the whole typed
   * string and a label is what a person types.
   */
  it("leaves every row label findable from the rail's search", () => {
    const labels = [...render(null).matchAll(/data-slot="pref-row-label"[^>]*>([^<]+)</g)].map(
      (match) => decodeEntities(match[1] ?? "").trim(),
    );
    const terms = authorityKeywords().map((term) => term.toLowerCase());

    expect(labels.length).toBeGreaterThan(0);
    for (const label of labels) {
      expect(
        terms.some((term) => term.includes(label.toLowerCase())),
        `"${label}" is drawn in Configure → Authority and nothing in the rail finds it`,
      ).toBe(true);
    }
  });

  it("names the unauthenticated caller as its own kind, not a borrowed one", () => {
    // VC-92 ruled that "no environment variable means the user" is dead, so the
    // pane has to give that caller a row of its own rather than folding it in.
    const html = render(null);

    expect(html).toContain("An unauthenticated caller can read");
    expect(html).toContain("An authenticated session can read");
  });
});
