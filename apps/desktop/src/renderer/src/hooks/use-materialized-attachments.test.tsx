// @vitest-environment jsdom
/**
 * The materialized-attachment read (VC-373): held while the owner's strip has
 * not landed (`revision === null`), so a Ticket with attachments pays ONE
 * `attachments.materialized` read instead of one against the not-yet-loaded
 * empty strip and a second when the real revision arrives.
 */
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { useMaterializedAttachments } from "./use-materialized-attachments";

function Probe({ revision }: { revision: string | null }) {
  useMaterializedAttachments({ ticketId: "t1" }, revision);
  return null;
}

let root: Root | null = null;
let container: HTMLElement | null = null;

async function render(revision: string | null): Promise<void> {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(<Probe revision={revision} />);
  });
}

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  root = null;
  container?.remove();
  container = null;
  vi.unstubAllGlobals();
});

describe("useMaterializedAttachments", () => {
  it("holds the read until the strip has landed", async () => {
    const materialized = vi.fn(async () => ({ ok: true as const, links: [] }));
    Object.defineProperty(window, "api", {
      configurable: true,
      value: { attachments: { materialized } },
    });
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

    await render(null);
    expect(materialized).not.toHaveBeenCalled();

    await act(async () => {
      root?.render(<Probe revision="" />);
    });
    expect(materialized).toHaveBeenCalledTimes(1);

    // A later attachment moves the revision, and that earns its own read.
    await act(async () => {
      root?.render(<Probe revision="hash-1" />);
    });
    expect(materialized).toHaveBeenCalledTimes(2);
  });
});
