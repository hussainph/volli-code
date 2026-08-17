import { ACTIVITY_METADATA_KEY, type ActivityDescriptor } from "@volli/shared";
import type { DynamicToolUIPart } from "ai";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { ActivityBundle, copyActivityObject, ToolRow } from "./activity-ui";

const descriptor: ActivityDescriptor = {
  kind: "read-file",
  nativeToolName: "read",
  subject: { label: "src/session.ts", path: "src/session.ts", lineRange: null },
  outcome: null,
  startedAt: 1,
  endedAt: 2,
};

const row: DynamicToolUIPart = {
  type: "dynamic-tool",
  toolName: "read",
  toolCallId: "read-1",
  state: "output-available",
  input: null,
  output: "export {};",
  toolMetadata: { [ACTIVITY_METADATA_KEY]: descriptor } as DynamicToolUIPart["toolMetadata"],
};

describe("ActivityBundle scroll window", () => {
  it("caps the open bundle without trapping the wheel inside it (VC-32)", () => {
    // A failed row opens the bundle on its own (`bundleNeedsAttention`), so
    // the capped window is in the markup without any click. The cap must
    // stay — an uncapped payload shoves the feed off screen — but
    // `overscroll-contain` must not come back: it turned the cap's edges
    // into a dead zone where the transcript ignored the wheel entirely.
    const failed: DynamicToolUIPart = {
      type: "dynamic-tool",
      toolName: "read",
      toolCallId: "read-2",
      state: "output-error",
      input: null,
      errorText: "boom",
      toolMetadata: { [ACTIVITY_METADATA_KEY]: descriptor } as DynamicToolUIPart["toolMetadata"],
    };
    const html = renderToStaticMarkup(
      <ActivityBundle rows={[{ kind: "tool", part: failed, key: "read-2" }]} />,
    );

    expect(html).toContain("max-h-96");
    expect(html).toContain("overflow-auto");
    expect(html).not.toContain("overscroll-contain");
  });
});

describe("ToolRow copy control", () => {
  it("renders a copy control for an activity object", () => {
    const html = renderToStaticMarkup(<ToolRow part={row} />);

    expect(html).toContain('aria-label="Copy"');
  });

  it("reports a fulfilled clipboard write as copied", async () => {
    const writeText = vi.fn(async () => undefined);

    await expect(copyActivityObject("src/session.ts", { writeText })).resolves.toBe("copied");
    expect(writeText).toHaveBeenCalledWith("src/session.ts");
  });

  it("reports a rejected clipboard write as failed", async () => {
    const writeText = vi.fn(async () => Promise.reject(new Error("denied")));

    await expect(copyActivityObject("src/session.ts", { writeText })).resolves.toBe("failed");
  });
});
