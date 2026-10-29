// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { CloudMoveStatus } from "@volli/shared";
import { MoveProgress } from "./progress";
import { fakeApi, move } from "./test-support";

const toast = vi.hoisted(() => vi.fn());
vi.mock("@renderer/lib/toast", () => ({ toastError: toast }));
let root: Root;
let container: HTMLElement;
let api: ReturnType<typeof fakeApi>;
const clipboard = vi.fn().mockResolvedValue(undefined);
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: clipboard },
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  api = fakeApi();
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});
async function mount(status: Partial<CloudMoveStatus> = {}, initialCancelMoveId?: string) {
  await act(async () =>
    root.render(
      <MoveProgress
        api={api}
        moves={[{ ...move, ...status }]}
        {...(initialCancelMoveId === undefined ? {} : { initialCancelMoveId })}
      />,
    ),
  );
}
function button(label: string) {
  const found = [...document.querySelectorAll("button")].find(
    (item) => item.textContent?.trim() === label,
  );
  if (!found) throw new Error(`Missing ${label}`);
  return found;
}
async function click(label: string) {
  await act(async () => button(label).click());
}

describe("Move progress and outcomes", () => {
  it.each(["backup", "export"] as const)(
    "explains the uninterruptible snapshot during %s",
    async (step) => {
      await mount({ state: "moving", step });
      expect(container.textContent).toContain("snapshot cannot stop immediately");
    },
  );
  it("opens the cancel confirmation from the paused banner without mutating first", async () => {
    await mount({ state: "waiting", actions: ["resume", "cancel"] }, "move");
    expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain(
      "Cancel this move?",
    );
    expect(api.command).not.toHaveBeenCalled();
  });
  it("keeps changed-cloud rollback distinct from Go back to local and requires the typed project name", async () => {
    await mount({
      state: "check",
      actions: ["roll-back", "go-back"],
      rollback: { requiresConfirmation: true, changes: ["2 tickets changed"] },
    });
    await click("Roll back");
    const dialog = document.querySelector('[role="alertdialog"]')!;
    expect(dialog.textContent).toContain("2 tickets changed");
    expect(dialog.textContent).toContain("will be lost");
    const confirm = [...dialog.querySelectorAll("button")].find(
      (item) => item.textContent === "Roll back",
    )!;
    expect(confirm.disabled).toBe(true);
    expect(api.command).not.toHaveBeenCalled();
    await act(async () => {
      const input = dialog.querySelector("input")!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
        input,
        "Atlas",
      );
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => confirm.click());
    expect(api.command).toHaveBeenCalledWith({
      moveId: "move",
      action: "roll-back",
      confirmation: "Atlas",
    });
  });
  it("shows durable countable progress, completed steps, remaining time, pause, cancel and content-free report", async () => {
    await mount();
    expect(container.querySelector("progress")?.value).toBe(10);
    expect(container.querySelector("progress")?.max).toBe(20);
    expect(container.textContent).toContain("✓ Backup");
    expect(container.textContent).toContain("About 2 min");
    await click("Pause");
    expect(api.command).toHaveBeenCalledWith({ moveId: "move", action: "pause" });
    await click("Report");
    expect(api.report).toHaveBeenCalledWith("move");
    expect(clipboard).toHaveBeenCalledWith('{"ok":true}');
    expect(button("Report copied")).toBeDefined();
    await click("Cancel move");
    expect(api.command).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain(
      "becomes writable",
    );
    await act(async () =>
      [...document.querySelectorAll("button")]
        .findLast((item) => item.textContent === "Cancel move")!
        .click(),
    );
    expect(api.command).toHaveBeenLastCalledWith({ moveId: "move", action: "cancel" });
  });
  it.each<CloudMoveStatus["state"]>([
    "queued",
    "moving",
    "waiting",
    "problem",
    "check",
    "finished",
    "rolled-back",
    "returned",
  ])("renders %s without inventing an allowed action", async (state) => {
    await mount({ state, message: `State ${state}`, actions: [] });
    expect(container.textContent).toContain(`State ${state}`);
    expect([...container.querySelectorAll("button")].map((item) => item.textContent)).toEqual([
      "Report",
    ]);
  });
  it.each([
    ["waiting", "A Session started; the move waits until it’s idle.", ["skip"]],
    ["waiting", "Waiting for network. Nothing is lost; the move resumes.", []],
    ["waiting", "Needs 3.1 GB free.", ["resume", "cancel"]],
    [
      "problem",
      "Volli Cloud refused 2 records. Atlas was rolled back and is unchanged on this Mac.",
      ["retry", "skip"],
    ],
    ["problem", "A check didn’t match. Atlas was rolled back.", ["retry"]],
    ["problem", "This project is already in another Workspace.", []],
    ["problem", "Your Volli Cloud preview access ended.", []],
    ["waiting", "Sign in as the person who started this move.", ["resume"]],
  ] as const)("shows %s recovery for %s", async (state, message, actions) => {
    await mount({ state, message, actions: [...actions] });
    expect(
      container.querySelector(state === "problem" ? '[role="alert"]' : '[role="status"]')
        ?.textContent,
    ).toBe(message);
    expect(container.querySelectorAll("button")).toHaveLength(actions.length + 1);
  });
  it("shows verification counts, backup, paused Automations and credential checklist before Finish move", async () => {
    await mount({
      state: "check",
      checks: [
        { label: "Tickets", passed: true, sourceCount: 12, cloudCount: 12 },
        { label: "Session history", passed: true },
      ],
      actions: ["open-cloud", "finish", "go-back"],
      pausedAutomations: ["Review arrivals"],
      localCredentials: ["Model connection"],
    });
    expect(container.textContent).toContain("Tickets · 12 / 12");
    expect(container.textContent).toContain("All checks passed");
    expect(container.textContent).toContain("safety.tar.gz");
    expect(container.textContent).toContain("Review arrivals");
    expect(container.textContent).toContain("Model connection");
    await click("Finish move");
    expect(api.command).toHaveBeenCalledWith({ moveId: "move", action: "finish" });
    await click("Open in Volli Cloud");
    expect(api.command).toHaveBeenLastCalledWith({ moveId: "move", action: "open-cloud" });
  });
  it("never claims all checks passed for missing or mismatched verification", async () => {
    await mount({
      state: "check",
      checks: [{ label: "Session history", passed: false }],
      actions: ["finish"],
    });
    expect(container.textContent).not.toContain("All checks passed");
    expect(container.querySelector('[aria-label="Not matched"]')).not.toBeNull();
    expect(button("Finish move").disabled).toBe(true);
    await mount({ state: "check", checks: [], actions: ["finish"] });
    expect(container.textContent).not.toContain("All checks passed");
    expect(button("Finish move").disabled).toBe(true);
  });
  it("Go back to local explains preservation and shows the readable export location before and after", async () => {
    await mount({ state: "finished", actions: ["go-back"] });
    await click("Go back to local");
    const dialog = document.querySelector('[role="alertdialog"]')!;
    expect(dialog.textContent).toContain("not applied to the local copy");
    expect(dialog.textContent).toContain("/profile/cloud-moves/move/cloud-changes");
    expect(api.command).not.toHaveBeenCalled();
    await act(async () =>
      [...dialog.querySelectorAll("button")]
        .find((item) => item.textContent === "Go back to local")!
        .click(),
    );
    expect(api.command).toHaveBeenCalledWith({ moveId: "move", action: "go-back" });
    await mount({ state: "returned", actions: [] });
    expect(container.textContent).toContain(
      "Cloud changes saved to: /profile/cloud-moves/move/cloud-changes",
    );
  });
  it("requires an exact typed confirmation for manual removal and honors revoked availability", async () => {
    await mount({ state: "finished", actions: ["remove-local"] });
    await click("Remove local copy…");
    expect(button("Remove local copy").disabled).toBe(true);
    const input = document.querySelector("input")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
        input,
        "Atlas",
      );
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(button("Remove local copy").disabled).toBe(false);
    await mount({ state: "finished", actions: [] });
    expect(button("Remove local copy").disabled).toBe(true);
    expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain(
      "no longer available",
    );
    expect(api.command).not.toHaveBeenCalled();
    await mount({ state: "finished", actions: ["remove-local"] });
    await click("Remove local copy");
    expect(api.command).toHaveBeenCalledWith({
      moveId: "move",
      action: "remove-local",
      confirmation: "Atlas",
    });
  });
  it("reports failed actions and clipboard failures, with no silent success", async () => {
    api.command.mockRejectedValueOnce(new Error("failed"));
    await mount();
    await click("Pause");
    expect(toast).toHaveBeenCalledWith(expect.stringContaining("Couldn't complete"));
    api.report.mockRejectedValueOnce(new Error("failed"));
    await click("Report");
    expect(toast).toHaveBeenCalledWith(expect.stringContaining("Couldn't copy"));
  });
});
