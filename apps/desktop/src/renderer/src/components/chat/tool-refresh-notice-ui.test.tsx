import { renderToStaticMarkup } from "react-dom/server";
import type { TranscriptToolRefresh } from "@volli/session-presentation";
import { expect, it } from "vite-plus/test";
import { ToolRefreshNotice } from "./tool-refresh-notice-ui";

it("shows a quiet expandable row with additions, changed names and trigger", () => {
  const html = renderToStaticMarkup(
    <ToolRefreshNotice
      refresh={{
        sequence: 8,
        afterMessageId: null,
        trigger: "cold-turn",
        added: ["read", "write"],
        changed: ["codemode"],
      }}
    />,
  );
  expect(html).toContain("Tools updated: 2 added");
  expect(html).toContain("<details");
  expect(html).toContain("<summary");
  expect(html).toContain("Cold turn");
  expect(html).toContain("read");
  expect(html).toContain("write");
  expect(html).toContain("codemode (updated)");
  expect(html).not.toContain('role="alert"');
});

it.each([
  ["warm-turn", "Warm turn"],
  ["compaction", "Compaction"],
  ["model-switch", "Model switch"],
  ["code-mode", "Code Mode"],
  ["future-trigger", "future-trigger"],
])("names an update-only %s refresh without suggesting nothing changed", (trigger, label) => {
  const html = renderToStaticMarkup(
    <ToolRefreshNotice
      refresh={{
        sequence: 9,
        afterMessageId: null,
        trigger: trigger as TranscriptToolRefresh["trigger"],
        added: [],
        changed: ["codemode"],
      }}
    />,
  );
  expect(html).toContain("Tools updated: 1 updated");
  expect(html).toContain(label);
  expect(html).toContain("codemode (updated)");
  expect(html).not.toContain("0 added");
});
