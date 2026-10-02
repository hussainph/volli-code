// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import type { SubagentNotice } from "@volli/session-presentation";

import {
  BrowserHoldNoticeRow,
  HostNoticeRow,
  ShellNoticeRow,
  SubagentNoticeRow,
  UnknownHostNoticeRow,
  WatchNoticeRow,
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
  it("draws the child and outcome without a redundant detail row or message-bubble controls", () => {
    const html = renderToStaticMarkup(<SubagentNoticeRow notice={completed} />);

    expect(html).toContain("Find artifact conventions");
    expect(html).toContain("done");
    expect(html).not.toContain('<p class="truncate text-ui text-muted-foreground/70">');
    expect(html).toContain('data-slot="separator"');
    expect(html).not.toContain('aria-label="Copy"');
  });

  it("puts the complete title and note in the row's hover text", () => {
    const longTitle = "A title long enough to be truncated in a narrow Pane";
    const html = renderToStaticMarkup(
      <SubagentNoticeRow notice={{ ...completed, title: longTitle }} />,
    );

    expect(html).toContain(`title="${longTitle} — done"`);
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

describe("a background shell notice row (VC-495)", () => {
  const exited = {
    kind: "background-shell",
    event: "exited",
    shellId: "sh-1",
    label: "pnpm test --watch",
    code: 1,
    signal: null,
    runtimeMs: 125_000,
    byPerson: false,
  } as const;
  const matched = {
    kind: "background-shell",
    event: "matched",
    shellId: "sh-2",
    label: "dev server",
    pattern: "listening on",
    regex: false,
  } as const;

  it("draws the shell and how it ended in the transcript's quiet host register", () => {
    const html = renderToStaticMarkup(<ShellNoticeRow notice={exited} />);

    expect(html).toContain("pnpm test --watch");
    expect(html).toContain("exited 1");
    expect(html).toContain("Ran 2m 5s.");
    expect(html).toContain('data-slot="separator"');
    expect(html).not.toContain('aria-label="Copy"');
  });

  it("puts the complete label and note in the row's hover text, and says a match is a match", () => {
    const html = renderToStaticMarkup(<ShellNoticeRow notice={matched} />);

    expect(html).toContain("dev server");
    expect(html).toContain("matched");
    expect(html).toContain('title="dev server — matched. Printed &quot;listening on&quot;."');
  });

  it("is what the portable row model dispatches to", () => {
    expect(renderToStaticMarkup(<HostNoticeRow notice={exited} />)).toContain("exited 1");
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

it("renders a ledger-hit historical receipt as a quiet line, without approval actions", () => {
  const html = renderToStaticMarkup(
    <HostNoticeRow
      notice={{
        kind: "approval-used",
        approvalId: "row",
        summary: "Write to docs",
        asked: "write docs/a.md",
      }}
    />,
  );
  expect(html).toContain("Allowed by your earlier approval: Write to docs");
  expect(html).not.toContain("button");
});

describe("a watch notice row (VC-457)", () => {
  const moved = {
    subject: "ticket",
    id: "t-1",
    label: "VC-12",
    fact: "ticket-moved",
    detail: "Done",
  } as const;

  it("draws one change as its headline, with no second line", () => {
    const html = renderToStaticMarkup(
      <WatchNoticeRow notice={{ kind: "watch", events: [moved] }} />,
    );
    expect(html).toContain("VC-12 moved (Done)");
    expect(html).not.toContain("<p ");
  });

  it("counts several changes and lists them underneath", () => {
    const html = renderToStaticMarkup(
      <HostNoticeRow
        notice={{
          kind: "watch",
          events: [
            moved,
            { subject: "session", id: "s-1", label: "ab12cd34", fact: "stopped", detail: null },
          ],
        }}
      />,
    );
    expect(html).toContain("2 watched changes");
    expect(html).toContain("VC-12 moved (Done) · ab12cd34 was stopped");
  });
});
