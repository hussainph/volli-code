// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import type { Automation } from "@volli/shared";
import { TicketAutomationChoices } from "./ticket-automation-choices";

const AUTOMATION: Automation = {
  id: "a1",
  projectId: "p1",
  name: "Implement",
  instructions: "Work the ticket",
  trigger: { kind: "columns", columns: ["doing"] },
  runtime: null,
  createdAt: 1,
  updatedAt: 1,
};
let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

it("shows another column's automation without a dropdown or status change", async () => {
  const run = vi.fn();
  await act(async () =>
    root.render(
      <TicketAutomationChoices
        groups={[{ status: "doing", label: "Doing", current: false, automations: [AUTOMATION] }]}
        onRun={run}
      />,
    ),
  );
  expect(host.textContent).toContain("Doing");
  const button = host.querySelector<HTMLButtonElement>("button")!;
  expect(button.getAttribute("aria-label")).toBe("Run Implement on this ticket");
  await act(async () => button.click());
  expect(run).toHaveBeenCalledExactlyOnceWith(AUTOMATION);
});

it("marks the current column and renders nothing for an empty offer", async () => {
  await act(async () =>
    root.render(
      <TicketAutomationChoices
        groups={[{ status: "doing", label: "Doing", current: true, automations: [AUTOMATION] }]}
        onRun={() => {}}
      />,
    ),
  );
  expect(host.textContent).toContain("Doing · current column");
  await act(async () => root.render(<TicketAutomationChoices groups={[]} onRun={() => {}} />));
  expect(host.textContent).toBe("");
});
