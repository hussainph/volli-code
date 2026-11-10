// @vitest-environment jsdom
/** Queue content keeps the full measure; ownership and actions form one row. */
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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
  const group = host.querySelector<HTMLElement>(".composer-queued-item");
  if (group === null) throw new Error("expected the queued row");
  return group;
}

describe("the queued row's layout", () => {
  it("uses the shell's spacing rhythm without compounding primitive insets", () => {
    // jsdom cannot prove pixels. Pin the ownership contract here; the guarded
    // live matrix verifies the resulting ink/card/control axes at split widths.
    const css = readFileSync(resolve(import.meta.dirname, "../../globals.css"), "utf8");
    const rule = (selector: string) => {
      const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return [...css.matchAll(new RegExp(`${escaped}\\s*\\{([^}]+)\\}`, "g"))]
        .map((match) => match[1])
        .join("\n");
    };
    expect(rule(".session-prompt")).toContain("padding: var(--composer-gap)");
    expect(rule(".session-prompt .composer-queue")).toContain("padding: 0");
    expect(rule(".session-prompt .composer-queued-item")).toContain("padding: var(--composer-gap)");
    expect(rule(".session-prompt .composer-draft-attachments")).toContain(
      "padding: var(--composer-gap) var(--composer-gap) 0",
    );
    expect(rule(".session-prompt textarea")).toContain("padding: var(--composer-gap)");
    expect(rule(".session-prompt .prompt-toolbar")).toContain("var(--composer-control-outset)");
    expect(rule(".session-prompt .prompt-toolbar")).not.toContain("margin-left");
    expect(rule('.session-prompt [data-slot="composer-attachments"] > button')).toContain(
      "border: 1px solid var(--border)",
    );
  });

  it("gives words the full card width and groups status with its actions below", () => {
    const text = "Then run the whole suite at the narrowest width and fix whatever fails";
    const group = row({ id: "q", text, queueState: "queued" });
    const status = group.querySelector('[data-slot="queue-status"]')!;
    const reveal = group.querySelector('[data-slot="value-reveal"]')!;
    const footer = group.querySelector('[data-slot="queue-footer"]')!;
    expect(reveal.textContent).toBe(text);
    expect(reveal.getAttribute("aria-label")).toBe(`Queued message · ${text}`);
    expect(reveal.className).toContain("truncate");
    expect(reveal.className).toContain("w-full");
    expect(reveal.parentElement).toBe(group);
    expect(status.textContent).toBe("Queued");
    expect(status.parentElement).toBe(footer);
    expect(reveal.nextElementSibling).toBe(footer);
    for (const label of ["Steer", "Remove", "Edit"]) {
      const action = group.querySelector(`[aria-label^="${label} queued message:"]`)!;
      expect(action).not.toBeNull();
      expect(footer.contains(action)).toBe(true);
      expect(reveal.contains(action)).toBe(false);
    }
  });

  it.each(["Review the attached notes", ""])(
    "keeps files above the status/actions row, including attachment-only messages (%s)",
    (text) => {
      const attachments = Array.from({ length: 50 }, (_, i) => ({
        linkId: `notes-${i}`,
        blobHash: "a".repeat(64),
        label: `Notes ${i}`,
        originalName: `${"long-name-".repeat(30)}-${i}.pdf`,
        mime: "application/pdf",
        sizeBytes: 1024,
      }));
      const group = row({ id: "q", text, attachments });
      const files = group.querySelector('[aria-label="50 attachments"]')!;
      const footer = group.querySelector('[data-slot="queue-footer"]')!;
      expect(files.parentElement).toBe(group);
      expect(files.nextElementSibling).toBe(footer);
      expect(files.className).toContain("min-w-0");
      expect(files.className).toContain("w-full");
      expect(files.textContent).toContain("+49");
      expect(files.children).toHaveLength(2);
      expect(footer.querySelectorAll("button")).toHaveLength(3);
      const label = text || "50 attachments";
      expect(group.getAttribute("aria-label")).toBe(`Queued message: ${label}`);
      for (const action of ["Steer", "Remove", "Edit"])
        expect(
          footer.querySelector(`[aria-label="${action} queued message: ${label}"]`),
        ).not.toBeNull();
      // An attachment-only payload doesn't create an empty focusable text row.
      expect(group.querySelector('[data-slot="value-reveal"]') === null).toBe(text === "");
    },
  );

  it("names a single-file queued message by its filename when there are no words", () => {
    const group = row({
      id: "q",
      text: "",
      attachments: [
        {
          linkId: "notes",
          blobHash: "a".repeat(64),
          label: "Notes",
          originalName: "release-notes.pdf",
          mime: "application/pdf",
          sizeBytes: 1024,
        },
      ],
    });
    expect(group.getAttribute("aria-label")).toBe("Queued message: release-notes.pdf");
    for (const action of ["Steer", "Remove", "Edit"])
      expect(
        group.querySelector(`[aria-label="${action} queued message: release-notes.pdf"]`),
      ).not.toBeNull();
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
