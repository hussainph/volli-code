/** VC-756: browser-only fixtures for the production expandable system row. */
import type { TranscriptToolRefresh } from "@volli/session-presentation";

import { ToolRefreshNotice } from "@renderer/components/chat/tool-refresh-notice-ui";

export const title = "Tool refresh notice (VC-756)";
export const note = "Quiet refresh rows: additions, compatible updates, and Code Mode namespaces";

const cases: { label: string; refresh: TranscriptToolRefresh }[] = [
  {
    label: "Cold turn",
    refresh: {
      sequence: 8,
      afterMessageId: null,
      trigger: "cold-turn",
      added: ["read", "write", "web_fetch"],
      changed: ["codemode"],
    },
  },
  {
    label: "Compatible update only",
    refresh: {
      sequence: 9,
      afterMessageId: null,
      trigger: "model-switch",
      added: [],
      changed: ["codemode"],
    },
  },
  {
    label: "Code Mode additions",
    refresh: {
      sequence: 10,
      afterMessageId: null,
      trigger: "code-mode",
      added: ["mcp:paper.create_document", "mcp:paper.list_documents"],
      changed: [],
    },
  },
];

export default function ToolRefreshNoticeScratch() {
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-8 p-4">
      {cases.map(({ label, refresh }) => (
        <section key={refresh.sequence} aria-label={label} className="min-w-0 space-y-3">
          <h2 className="text-label text-muted-foreground">{label}</h2>
          <ToolRefreshNotice refresh={refresh} />
        </section>
      ))}
    </div>
  );
}
