// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import type { SubagentNotice } from "@volli/session-presentation";

import {
  BrowserHoldNoticeRow,
  HostNoticeRow,
  SubagentNoticeRow,
  UnknownHostNoticeRow,
} from "./host-notice-ui";

const completed: SubagentNotice = {
  kind: "subagent",
  childSessionId: "ses-child-1",
  sessionHandle: "ses-chil",
  title: "Find artifact conventions",
  state: "completed",
  reason: null,
};

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(async () => {
  if (root !== null) await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.unstubAllGlobals();
});

describe("a Subagent Session notice row", () => {
  it("draws the child, outcome, and receipt without message-bubble controls", () => {
    const html = renderToStaticMarkup(<SubagentNoticeRow notice={completed} />);

    expect(html).toContain("Find artifact conventions");
    expect(html).toContain("done");
    expect(html).toContain("Finished its task; its answer is in its own Session.");
    expect(html).toContain('data-slot="separator"');
    expect(html).not.toContain('aria-label="Copy"');
  });

  it("puts the complete title and note in the row's hover text", () => {
    const longTitle = "A title long enough to be truncated in a narrow Pane";
    const html = renderToStaticMarkup(
      <SubagentNoticeRow notice={{ ...completed, title: longTitle }} />,
    );

    expect(html).toContain(`title="${longTitle} — done. Finished its task`);
  });

  it("opens the durable child id from its real button", async () => {
    const onOpenSession = vi.fn();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(<SubagentNoticeRow notice={completed} onOpenSession={onOpenSession} />);
    });

    const button = container.querySelector<HTMLButtonElement>("button");
    expect(button?.textContent).toContain("Open");
    await act(async () => button?.click());
    expect(onOpenSession).toHaveBeenCalledExactlyOnceWith("ses-child-1");
  });

  it("keeps a historical answer reachable without inventing a full child id", () => {
    const html = renderToStaticMarkup(
      <SubagentNoticeRow notice={{ ...completed, childSessionId: null }} onOpenSession={vi.fn()} />,
    );

    expect(html).not.toContain("<button");
    expect(html).toContain("Answer: volli session answer ses-chil");
  });

  it("preserves relaunch context in the visible receipt", () => {
    const html = renderToStaticMarkup(
      <SubagentNoticeRow
        notice={{ ...completed, state: "interrupted", reason: "app-relaunched" }}
      />,
    );

    expect(html).toContain("Volli relaunched while its turn was active");
  });
});

describe("other host-notice rows", () => {
  it("keeps the affected Browser Tab visible", () => {
    const html = renderToStaticMarkup(
      <BrowserHoldNoticeRow
        notice={{
          kind: "browser-hold",
          tabId: "long-opaque-tab-id",
          label: "GitHub",
          action: "person-took",
        }}
      />,
    );

    expect(html).toContain(">GitHub</span>");
    expect(html).toContain("You took control");
    expect(html).toContain("Browser Tab long-opaque-tab-id — GitHub");
    expect(html).not.toContain('aria-label="Copy"');
  });

  it("keeps a newer host fact in Volli's voice", () => {
    const html = renderToStaticMarkup(
      <UnknownHostNoticeRow notice={{ kind: "unknown", text: "A newer host fact." }} />,
    );

    expect(html).toContain("Volli");
    expect(html).toContain("A newer host fact.");
    expect(html).not.toContain('aria-label="Copy"');
  });

  it("dispatches the portable row model without parsing metadata", () => {
    expect(renderToStaticMarkup(<HostNoticeRow notice={completed} />)).toContain(
      "Find artifact conventions",
    );
    expect(
      renderToStaticMarkup(
        <HostNoticeRow
          notice={{
            kind: "browser-hold",
            tabId: "tab-2",
            label: "Documentation",
            action: "ask-to-leave",
          }}
        />,
      ),
    ).toContain("Documentation");
    expect(
      renderToStaticMarkup(<HostNoticeRow notice={{ kind: "unknown", text: "Future fact" }} />),
    ).toContain("Future fact");
  });
});
