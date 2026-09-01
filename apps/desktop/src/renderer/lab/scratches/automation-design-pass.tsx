/**
 * The owner-approved VC-222 proposal, now mounted from the real production
 * Automations page. Fixture bridge responses keep create/edit/run controls
 * interactive without duplicating the page's layout in a second Lab-only UI.
 */
import {
  NO_AUTOMATION_TRIGGER,
  SKILL_POLICY_DEFAULT,
  type Automation,
  type AutomationRun,
  type AutomationSkippedOccurrence,
  type ColumnArming,
  type ColumnAutomationOrder,
  type SkillReference,
} from "@volli/shared";

import { AutomationsPage } from "@renderer/components/automations/automations-page";
import { TooltipProvider } from "@renderer/components/ui/tooltip";
import { useAutomationsStore } from "@renderer/stores/automations";
import { useBoardStore } from "@renderer/stores/board";
import { useProjectsStore } from "@renderer/stores/projects";

import type { ApiOverrides } from "../fake-api";
import { NOW, project, tickets } from "../fixtures";

export const title = "Automations · VC-222 proposal";
export const note =
  "Production rail, focused editor, floating slash picker, inspector controls, and lanes.";
export const viewport = "window" as const;

const LONG_SKILL: SkillReference = {
  name: "review-every-single-boundary-in-this-extraordinarily-long-automation-skill-name",
  description: "Inspect renderer, preload, main and durable storage boundaries",
  body: "# Boundary review",
  authorPolicy: SKILL_POLICY_DEFAULT,
  effectivePolicy: SKILL_POLICY_DEFAULT,
  policyDiagnostic: null,
  root: ".agents/skills/review-every-boundary",
};

const SEEDED_AUTOMATIONS: readonly Automation[] = [
  {
    id: "automation-review",
    projectId: project.id,
    name: "Review every weekday",
    instructions: "/code-review\nReview changes against the ticket and repository standards.",
    trigger: {
      kind: "schedule",
      schedule: { preset: "weekdays", hour: 9, minute: 0, timeZone: "Asia/Kuwait" },
    },
    runtime: null,
    createdAt: NOW - 4_000,
    updatedAt: NOW - 1_000,
  },
  {
    id: "automation-implement",
    projectId: project.id,
    name: "Implement",
    instructions: "/implement\nWork the ticket through verification.",
    trigger: { kind: "columns", columns: ["doing"] },
    runtime: null,
    createdAt: NOW - 3_000,
    updatedAt: NOW - 900,
  },
  {
    id: "automation-release",
    projectId: project.id,
    name: "Release notes",
    instructions: "/release-notes\nSummarize the week in product language.",
    trigger: {
      kind: "schedule",
      schedule: {
        preset: "weekly",
        weekday: "friday",
        hour: 16,
        minute: 30,
        timeZone: "Asia/Kuwait",
      },
    },
    runtime: null,
    createdAt: NOW - 2_000,
    updatedAt: NOW - 800,
  },
  {
    id: "automation-triage",
    projectId: null,
    name: "Triage",
    instructions: "/triage\nFind the smallest actionable next step.",
    trigger: NO_AUTOMATION_TRIGGER,
    runtime: null,
    createdAt: NOW - 1_000,
    updatedAt: NOW - 700,
  },
  {
    id: "automation-standards",
    projectId: null,
    name: "Standards sweep",
    instructions: "/code-review\nRun the standards axis only.",
    trigger: { kind: "columns", columns: ["doing", "needs_review"] },
    runtime: null,
    createdAt: NOW,
    updatedAt: NOW - 600,
  },
];

const SEEDED_RUNS: readonly AutomationRun[] = [
  {
    id: "run-2",
    automationId: "automation-review",
    automationName: "Review every weekday",
    ticketId: null,
    sessionId: "session-review-2",
    model: { providerId: "anthropic", modelId: "claude-sonnet", reasoningLevel: "high" },
    attendance: "attended",
    createdAt: NOW,
  },
  {
    id: "run-1",
    automationId: "automation-review",
    automationName: "Review every weekday",
    ticketId: null,
    sessionId: "session-review-1",
    model: { providerId: "anthropic", modelId: "claude-sonnet", reasoningLevel: "high" },
    attendance: "attended",
    createdAt: NOW - 86_400_000,
  },
];

const ARMINGS: readonly ColumnArming[] = [
  {
    projectId: project.id,
    status: "doing",
    automationId: "automation-implement",
    armedAt: NOW,
  },
  {
    projectId: project.id,
    status: "needs_review",
    automationId: "automation-standards",
    armedAt: NOW,
  },
];

const ORDERS: readonly ColumnAutomationOrder[] = [
  {
    projectId: project.id,
    status: "doing",
    rankedAutomationIds: ["automation-implement", "automation-standards"],
    orderedAt: NOW,
  },
  {
    projectId: project.id,
    status: "needs_review",
    rankedAutomationIds: ["automation-standards"],
    orderedAt: NOW,
  },
];

let records: Automation[] = [];
let enabledIds: string[] = [];
let armings: ColumnArming[] = [];
let orders: ColumnAutomationOrder[] = [];

export function seed(): void {
  records = [...SEEDED_AUTOMATIONS];
  enabledIds = ["automation-review", "automation-implement", "automation-standards"];
  armings = [...ARMINGS];
  orders = [...ORDERS];
  useProjectsStore.setState({ projects: [project], selectedProjectId: project.id });
  useBoardStore.setState({ ticketsByProject: { [project.id]: tickets } });
  useAutomationsStore.setState({
    byProject: {},
    armingByProject: {},
    orderByProject: {},
    runsByProject: {},
    skipsByProject: {},
    enabledIds: [],
    enablementRead: false,
    editor: null,
  });
}

export const api: ApiOverrides = {
  automations: {
    list: async () => ({ ok: true, automations: records }),
    runsForProject: async () => ({ ok: true, runs: SEEDED_RUNS }),
    skipsForProject: async () => ({
      ok: true,
      skips: [] as AutomationSkippedOccurrence[],
    }),
    enablement: async () => ({ ok: true, enabledAutomationIds: enabledIds }),
    armings: async () => ({ ok: true, armings }),
    columnOrders: async () => ({ ok: true, orders }),
    create: async (input: {
      projectId: string | null;
      name: string;
      instructions: string;
      trigger: Automation["trigger"];
      runtime: Automation["runtime"];
    }) => {
      const automation: Automation = {
        id: crypto.randomUUID(),
        projectId: input.projectId,
        name: input.name,
        instructions: input.instructions,
        trigger: input.trigger,
        runtime: input.runtime,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      records = [...records, automation];
      return { ok: true, automation };
    },
    update: async (input: {
      automationId: string;
      name: string;
      instructions: string;
      trigger: Automation["trigger"];
      runtime: Automation["runtime"];
    }) => {
      const current = records.find((automation) => automation.id === input.automationId)!;
      const automation: Automation = {
        ...current,
        ...input,
        id: input.automationId,
        updatedAt: Date.now(),
      };
      records = records.map((candidate) =>
        candidate.id === automation.id ? automation : candidate,
      );
      return { ok: true, automation };
    },
    delete: async (input: { automationId: string }) => {
      records = records.filter((automation) => automation.id !== input.automationId);
      return { ok: true, receipt: {} };
    },
    setEnabled: async (input: { automationId: string; enabled: boolean }) => {
      enabledIds = input.enabled
        ? [...new Set([...enabledIds, input.automationId])]
        : enabledIds.filter((id) => id !== input.automationId);
      return { ok: true, enabledAutomationIds: enabledIds, receipt: {} };
    },
    arm: async (input: {
      projectId: string;
      status: ColumnArming["status"];
      automationId: string | null;
    }) => {
      armings = armings.filter(
        (arming) => arming.projectId !== input.projectId || arming.status !== input.status,
      );
      if (input.automationId !== null) {
        armings.push({ ...input, automationId: input.automationId, armedAt: Date.now() });
      }
      return { ok: true, armings, receipt: {} };
    },
    setColumnOrder: async (input: {
      projectId: string;
      status: ColumnAutomationOrder["status"];
      rankedAutomationIds: readonly string[];
    }) => {
      orders = orders.filter(
        (order) => order.projectId !== input.projectId || order.status !== input.status,
      );
      orders.push({
        ...input,
        rankedAutomationIds: [...input.rankedAutomationIds],
        orderedAt: Date.now(),
      });
      return { ok: true, orders, receipt: {} };
    },
  },
  files: {
    promptTemplates: async () => ({ ok: true, templates: [], skills: [LONG_SKILL] }),
    index: async () => ({ ok: true, files: [] }),
  },
};

export default function AutomationDesignPassScratch() {
  return (
    <TooltipProvider>
      <AutomationsPage />
    </TooltipProvider>
  );
}
