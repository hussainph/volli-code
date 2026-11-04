// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { TooltipProvider } from "@renderer/components/ui/tooltip";
import { SectionHeading } from "@renderer/components/ui/section-heading";
import { EMPTY_INLINE, EMPTY_PAGE } from "@renderer/components/ui/empty-classes";
import { AsyncSection, Empty } from "./async-section";
import { PrefRow } from "./pref-row";
import { SectionAction } from "./pref-section";

function documentFor(html: string) {
  return new DOMParser().parseFromString(html, "text/html");
}

describe("Settings field hierarchy and alignment", () => {
  it("centres every control on its full label block with symmetric row padding", () => {
    const doc = documentFor(
      renderToStaticMarkup(
        <PrefRow label="Notifications" description="Know when a session needs you." align="start">
          <input type="checkbox" />
        </PrefRow>,
      ),
    );
    const row = doc.body.firstElementChild!;
    expect(row.className).toContain("items-center");
    expect(row.className).toContain("py-4");
    expect(row.className).not.toContain("first:pt-0");
    expect(row.className).not.toContain("last:pb-0");
    expect(doc.querySelector("p")!.className).not.toContain("font-medium");
    expect(doc.querySelector("button")).toBeNull();
  });

  it("keeps section states in-flow and left-aligned; full-pane empties stay centred", () => {
    expect(EMPTY_INLINE).toContain("text-left");
    expect(EMPTY_PAGE).toContain("text-center");
    const empty = renderToStaticMarkup(<Empty>No commands</Empty>);
    expect(empty).toContain("text-left");
    const loading = renderToStaticMarkup(
      <AsyncSection title="Commands" state={{ status: "loading" }}>
        {() => null}
      </AsyncSection>,
    );
    expect(loading).toContain('aria-label="Loading Commands"');
    expect(loading).toContain('aria-busy="true"');
    const error = renderToStaticMarkup(
      <AsyncSection
        title="Commands"
        state={{ status: "error", message: "Read failed", onRetry: () => {} }}
      >
        {() => null}
      </AsyncSection>,
    );
    expect(error).toContain("Copy error");
    expect(error).toContain("Try again");
    expect(error).not.toContain("text-center");
  });

  it("makes heading levels visibly distinct without changing their document roles", () => {
    const doc = documentFor(
      renderToStaticMarkup(
        <>
          <SectionHeading as="h2">Sessions</SectionHeading>
          <SectionHeading as="h3">Earlier</SectionHeading>
        </>,
      ),
    );
    expect(doc.querySelector("h2")!.className).toContain("text-heading");
    expect(doc.querySelector("h3")!.className).toContain("text-ui");
    expect(doc.querySelector("h2")!.className).toContain("font-semibold");
  });

  it("turns Refresh text actions into named icon buttons", () => {
    const doc = documentFor(
      renderToStaticMarkup(
        <TooltipProvider>
          <SectionAction label="Refresh commands" />
        </TooltipProvider>,
      ),
    );
    const button = doc.querySelector("button")!;
    expect(button.getAttribute("aria-label")).toBe("Refresh commands");
    expect(button.textContent).toBe("");
    expect(button.querySelector("svg")).not.toBeNull();
  });
});
