/** The shipping Protection page in its real window shell, with fixture-only approvals. */
import { AppShell } from "@renderer/components/app-shell";
import { useProjectsStore } from "@renderer/stores/projects";
import { useWorkspaceStore, DEFAULT_WORKSPACE_UI } from "@renderer/stores/workspace";
import { project } from "../fixtures";
import { appApi, seedApp } from "../seed";
import type { Project, AuthorityApproval, AuthorityPolicyOverride } from "@volli/shared";

export const title = "Protection final review";
export const note = "Shipping components; fixture data only. Check at 1400 × 900.";
export const viewport = "window" as const;
const rows: AuthorityApproval[] = [];
export function seed() {
  rows.splice(0);
  seedApp();
  useWorkspaceStore.setState({
    byProject: { [project.id]: { ...DEFAULT_WORKSPACE_UI, nav: "configure" } },
  });
}
export const api = {
  ...appApi,
  browser: { list: async () => ({ ok: true, tabs: [] }) },
  shells: { list: async () => ({ ok: true, shells: [] }) },
  protection: {
    approvals: async () => ({ ok: true, approvals: [...rows], passedRequestCount: 2 }),
    revoke: async (id: string) => ({
      ok: true,
      approval: rows.splice(
        rows.findIndex((r) => r.id === id),
        1,
      )[0],
    }),
    restore: async () => ({ ok: false, error: "Fixture-only Undo" }),
  },
  projects: {
    ...(appApi.projects as Record<string, unknown>),
    setAuthorityPolicy: async ({
      id,
      override,
    }: {
      id: string;
      override: AuthorityPolicyOverride | null;
    }) => {
      const updated: Project = { ...project, id, authorityPolicy: override };
      if (override?.enforcement === "enforce" && rows.length === 0) {
        for (let n = 1; n <= 3; n++)
          rows.push({
            id: `approval-${n}`,
            projectId: project.id,
            scope: n === 1 ? "session" : "project",
            sessionId: n === 1 ? "session-1" : null,
            operation: "write",
            key: `/Users/demo/code/docs/${["guides", "reference", "examples"][n - 1]}`,
            summary: `Write to ~/code/docs/${["guides", "reference", "examples"][n - 1]}`,
            rule: "path.outside-workspace",
            createdAt: Date.now(),
            useCount: 1,
            lastUsedAt: Date.now(),
            lastUsedBySessionId: null,
            provenance: {
              sessionId: "session-1",
              sessionTitle: "Update documentation",
              ticketDisplayId: "VC-480",
              asked: "write a documentation file",
              reason: "Outside this workspace",
              interactionId: `ask-${n}`,
            },
          });
      }
      useProjectsStore.setState((state) => ({
        projects: state.projects.map((p) => (p.id === id ? updated : p)),
      }));
      return { ok: true, project: updated };
    },
  },
};
export default function ProtectionReview() {
  return <AppShell />;
}
