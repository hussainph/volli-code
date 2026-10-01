import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import type { VenueSnapshot } from "@volli/shared";

import { TooltipProvider } from "@renderer/components/ui/tooltip";
import type { VenueEntry } from "@renderer/stores/venue";

import { HomeSessionCard, modelMetaLine, type HomeSessionFacts } from "./home-session-card";

/**
 * The Now page's one card, at every state it has to survive (VC-406).
 *
 * Static markup rather than a live DOM: everything asserted here is a drawing
 * decision — which words are printed, which are NOT, and what a keyboard can
 * reach — and all of it is settled on the first paint. The card is pure, so
 * nothing has to be seeded to mount it.
 */
const VENUE: VenueSnapshot = {
  kind: "worktree",
  path: "/Users/someone/.volli/worktrees/volli-code-f3732f45/VC-288-narrow-pane",
  branch: "volli/VC-288-narrow-pane-follow-ups-beyond-vc-264",
  files: { committed: 4, modified: 2, added: 1, untracked: 0 },
  diff: { added: 12, removed: 3, base: "main" },
};

const READY: VenueEntry = { status: "ready", venue: VENUE };

/** Typed as the chat MEMBER: the cases below spread it and vary one field. */
const CHAT: Extract<HomeSessionFacts, { kind: "chat" }> = {
  kind: "chat",
  model: {
    model: { providerId: "anthropic", modelId: "haiku-4.5", label: "Claude Haiku 4.5" },
    providerLabel: "Anthropic",
  },
  tier: "Fast",
  effort: "xhigh",
  activity: "working",
};

function draw(facts: HomeSessionFacts, venue: VenueEntry | undefined = READY): string {
  return renderToStaticMarkup(
    <TooltipProvider>
      <HomeSessionCard facts={facts} venue={venue} onRetryVenue={() => {}} />
    </TooltipProvider>,
  );
}

/** Tags are separators in this markup, not something being sanitized away. */
function text(markup: string): string {
  return markup.split(/<[^>]+>/).join("");
}

describe("HomeSessionCard", () => {
  it("draws the Session as a roster row: the model named, its tier and effort trailing", () => {
    // What it replaces is a `<dl>` of Model/Effort/Activity lines — a string
    // table, and the one shape on the page nothing else in the app was drawn
    // in. The model is the NAME here; the tier and the effort are qualifiers
    // of it, trailing in the muted ink, not fields of their own.
    const markup = draw(CHAT);

    expect(markup).toContain('data-testid="home-session-identity"');
    expect(text(markup)).toContain("Fast · Extra high effort");
    // The old labels are gone with the table that carried them.
    expect(markup).not.toContain(">Model<");
    expect(markup).not.toContain(">Effort<");
    expect(markup).not.toContain(">Activity<");
  });

  it("names the model the way every other model surface does: the mark, then the catalogue's name", () => {
    // The wire id is what this page used to print, and it was the last place in
    // the app a model was still a string you read rather than a thing you
    // recognise. The vendor's mark (`ModelMark`) leads the catalogue's label.
    const markup = draw(CHAT);

    expect(text(markup)).toContain("Claude Haiku 4.5");
    expect(text(markup)).not.toContain("haiku-4.5");
    // The mark is the vendor's own inline `<svg>`, before the name, not a
    // Phosphor kind glyph — which is what a chat with no model falls back to.
    expect(markup.slice(0, markup.indexOf("Claude Haiku 4.5"))).toContain("<svg");
    expect(markup).not.toContain('aria-label="Chat"');
    // And the whole identity is one focus stop away where the row clips.
    expect(markup).toContain('aria-label="Model · Claude Haiku 4.5 · Anthropic"');
  });

  it("never spends the row's width on the account — the mark is what says whose it is", () => {
    // The roomier model surfaces append "· Anthropic" where two signed-in
    // providers ship one name. At rail width that term is what pushes the NAME
    // into an ellipsis, and the mark already tells the two accounts apart.
    const markup = draw(CHAT);

    expect(text(markup)).toContain("Claude Haiku 4.5");
    expect(text(markup)).not.toContain("Claude Haiku 4.5 · Anthropic");
    // Still reachable, in the reveal rather than on the row.
    expect(markup).toContain("Anthropic");
  });

  it("keeps a pinned model the catalogue no longer lists", () => {
    // A provider signed out from under a running Session leaves the Session
    // pinned; the id is what it is pinned TO, so the row draws the id rather
    // than going blank.
    const markup = text(
      draw({
        ...CHAT,
        model: {
          model: { providerId: "openai", modelId: "gpt-5.6-luna", label: "gpt-5.6-luna" },
          providerLabel: "OpenAI",
        },
      }),
    );

    expect(markup).toContain("gpt-5.6-luna");
  });

  it("says the effort in the composer's words, never the wire enum", () => {
    // `xhigh` is what Pi calls it. A surface that prints the identifier is a
    // surface nobody proof-read — `effortLabel` is the one copy of these words.
    expect(text(draw(CHAT))).not.toContain("xhigh");
  });

  it("says the activity in the words every other Session row uses", () => {
    // This page kept a private map that said "Ended" where the sidebar and the
    // ticket rail say "Exited". `SESSION_ACTIVITY_LABEL` is composed in now, so
    // the overlapping states cannot drift again.
    expect(text(draw({ ...CHAT, activity: "exited" }))).toContain("Exited");
    expect(text(draw({ ...CHAT, activity: "waiting" }))).toContain("Waiting for you");
    // The lifecycle's own states have no durable-listing word and keep theirs.
    expect(text(draw({ ...CHAT, activity: "starting" }))).toContain("Starting");
  });

  it("names the kind rather than drawing a title made of punctuation", () => {
    // A chat that has accepted no model policy yet is not a broken reading.
    const markup = draw({ ...CHAT, model: null, tier: null, effort: null });

    expect(text(markup)).toContain("Chat");
    expect(text(markup)).not.toContain("—");
    // With no model there is no mark to lead the row, so the kind glyph does.
    expect(markup).toContain('aria-label="Chat"');
  });

  it("asks a terminal what it actually has, not what a chat has", () => {
    // A PTY has no model and no effort; printing two dashes for them would be
    // calling an absence a reading.
    const markup = draw({ kind: "terminal", running: "Claude Code", activity: "idle" });

    expect(text(markup)).toContain("Claude Code");
    expect(text(markup)).toContain("Idle");
    expect(markup).toContain('aria-label="Terminal"');
  });

  it("says there is no Session in front rather than drawing a row of absences", () => {
    const markup = draw(null);

    expect(markup).toContain("No session in front");
    expect(markup).not.toContain('data-testid="home-session-identity"');
    // The tree is still on screen: it is the project's, not the front tab's.
    expect(markup).toContain('data-testid="home-venue-path"');
  });

  it("puts the whole venue path and branch within a keyboard's reach (VC-288)", () => {
    const markup = draw(CHAT);

    expect(markup).toContain(
      'aria-label="Worktree · /Users/someone/.volli/worktrees/volli-code-f3732f45/VC-288-narrow-pane"',
    );
    expect(markup).toContain(
      'aria-label="Branch · volli/VC-288-narrow-pane-follow-ups-beyond-vc-264"',
    );
    // Both reveals are focus stops — buttons Radix opens on focus as well as on
    // hover — rather than the text elements a pointer alone could ask.
    expect(markup.slice(markup.indexOf("home-venue-path"))).toContain("<button");
  });

  it("reports what is loose in the tree, and is silent at zero", () => {
    // The count rides the branch row in the attention tone. Its sentence lives
    // on a tooltip, which Radix only renders once opened — so what a static
    // render can check is the mark and the figure.
    const markup = draw(CHAT);
    const branchRow = markup.slice(markup.indexOf("home-venue-branch"));

    expect(branchRow).toContain("text-attention");
    expect(branchRow).toContain(">3<");

    const clean: VenueEntry = {
      status: "ready",
      venue: { ...VENUE, files: { committed: 4, modified: 0, added: 0, untracked: 0 } },
    };
    // "0 loose" is a number where there is no news.
    expect(draw(CHAT, clean)).not.toContain("text-attention");
  });

  it("holds the card's resting height while the venue reads", () => {
    // Two skeleton rows, because the card at rest is the identity row plus two
    // — a placeholder of a different shape is what makes the usage card below
    // jump up and back as the read lands.
    const markup = draw(CHAT, { status: "loading" });

    expect(markup).toContain('data-testid="home-venue-loading"');
    expect(markup).not.toContain('data-testid="home-venue-path"');
  });

  it("names a venue fault in one sentence, keeps the diagnostic off the row, and offers the fix", () => {
    // The rail's fault rule: the sentence a person needs on the row, the raw
    // error on `title` (at this width it is an ellipsis that pushes Retry off
    // the end), and the one action that fixes it beside them.
    const markup = draw(CHAT, { status: "error", error: "ENOENT: /code/volli-code is not there" });

    expect(markup).toContain("Couldn&#x27;t read the venue");
    expect(markup).toContain('title="ENOENT: /code/volli-code is not there"');
    expect(markup).toContain("Retry");
  });

  it("keeps a detached HEAD a plain row rather than a reveal repeating itself", () => {
    const detached: VenueEntry = { status: "ready", venue: { ...VENUE, branch: null } };
    const markup = draw(CHAT, detached);

    expect(text(markup)).toContain("detached");
    expect(markup).not.toContain('aria-label="Branch');
  });
});

describe("modelMetaLine", () => {
  it("says the noun, because a bare level reads as a claim about the model", () => {
    expect(modelMetaLine("Fast", "high")).toBe("Fast · High effort");
  });

  it("drops the term it does not have", () => {
    expect(modelMetaLine(null, "low")).toBe("Low effort");
    expect(modelMetaLine("Deep", null)).toBe("Deep");
  });

  it("draws no line at all rather than an empty one", () => {
    expect(modelMetaLine(null, null)).toBeNull();
  });
});
