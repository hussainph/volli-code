// @vitest-environment jsdom
/**
 * The queued message row's drawing: one shared `ListRow`, words on the first
 * line, ownership status on the line beneath, and the direct actions beside
 * both. The status used to be a non-shrinking item squeezed into the same
 * narrow line as the words and the controls, so at a split width it took the
 * message's measure and left a sliver of text.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { SessionComposer, type SessionComposerProps } from "./composer-ui";

type QueuedRow = SessionComposerProps["queued"][number];

function row(message: QueuedRow): HTMLElement {
  const props: SessionComposerProps = {
    value: "",
    onValueChange: () => undefined,
    models: [],
    selection: { providerId: "", modelId: "", reasoningLevel: "" },
    onSelectionChange: () => undefined,
    working: true,
    ready: true,
    queued: [message],
    onQueuedChange: () => undefined,
    onSteerQueued: () => undefined,
    onSubmit: () => undefined,
    onStop: () => undefined,
  };
  const host = document.createElement("div");
  host.innerHTML = renderToStaticMarkup(<SessionComposer {...props} />);
  const group = host.querySelector<HTMLElement>(`[aria-label="Queued message: ${message.text}"]`);
  if (group === null) throw new Error("expected the queued row");
  return group;
}

describe("the queued row's layout", () => {
  it("sets the status beneath the words, with the actions beside both", () => {
    const text = "Then run the whole suite at the narrowest width and fix whatever fails";
    const group = row({ id: "q", text, queueState: "queued" });
    const status = group.querySelector('[data-slot="queue-status"]')!;
    const reveal = group.querySelector('[data-slot="value-reveal"]')!;
    // The clipped words keep a keyboard-reachable way to read the whole.
    expect(reveal.textContent).toBe(text);
    expect(reveal.getAttribute("aria-label")).toBe(`Queued message · ${text}`);
    expect(reveal.className).toContain("truncate");
    expect(status.textContent).toBe("Queued");
    // Words own the first line; the status is the line beneath, not a sibling
    // on the words' own line.
    const firstLine = reveal.parentElement!;
    const textColumn = firstLine.parentElement!;
    expect(firstLine.contains(status)).toBe(false);
    expect(textColumn.contains(status)).toBe(true);
    expect(firstLine.nextElementSibling).toBe(status);
    // The actions are the row's siblings, beside the text column — never
    // inside the line the words truncate on.
    for (const label of ["Steer", "Remove", "Edit"]) {
      const action = group.querySelector(`[aria-label^="${label} queued message:"]`)!;
      expect(action).not.toBeNull();
      expect(textColumn.contains(action)).toBe(false);
    }
  });

  it("keeps attachment cards beneath the message rather than taking its horizontal measure", () => {
    const group = row({
      id: "q",
      text: "Review the attached notes",
      attachments: [
        {
          linkId: "notes",
          blobHash: "a".repeat(64),
          label: "Notes",
          originalName: "release-notes-for-this-project.pdf",
          mime: "application/pdf",
          sizeBytes: 1024,
        },
      ],
    });
    // At a 265px split, fixed-width leading cards and fixed actions cannot
    // both fit beside a readable message. Cards instead shrink inside the
    // message's own column, below the status, with no leading slot at all.
    group.style.width = "265px";
    const reveal = group.querySelector('[data-slot="value-reveal"]')!;
    const textColumn = reveal.parentElement!.parentElement!;
    const status = group.querySelector('[data-slot="queue-status"]')!;
    const files = group.querySelector('[aria-label="1 attachment"]')!;
    expect(textColumn.contains(files)).toBe(true);
    expect(status.nextElementSibling).toBe(files);
    expect(files.className).toContain("min-w-0");
    expect(textColumn.parentElement!.firstElementChild).toBe(textColumn);
    for (const action of group.querySelectorAll('[aria-label*="queued message:"]'))
      expect(textColumn.contains(action)).toBe(false);
  });

  it("marks a release in flight with the shared spinner, not punctuation", () => {
    const status = row({ id: "q", text: "later", queueState: "releasing" }).querySelector(
      '[data-slot="queue-status"]',
    )!;
    expect(status.textContent).toBe("Sending");
    expect(status.querySelector("svg.animate-spin")).not.toBeNull();
  });

  it("draws settled ownership as plain words", () => {
    const status = row({ id: "q", text: "later", localUnsent: true }).querySelector(
      '[data-slot="queue-status"]',
    )!;
    expect(status.textContent).toBe("Not sent");
    expect(status.querySelector("svg")).toBeNull();
  });
});
