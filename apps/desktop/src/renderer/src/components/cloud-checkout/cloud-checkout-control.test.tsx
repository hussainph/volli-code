// @vitest-environment jsdom
/**
 * "Choose the folder…" (VC-895 N2-3) over a stand-in for main's `checkouts.*`
 * tier: when it draws, where its press goes, and that a local launch asks
 * main nothing.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { CloudCheckoutChoice, CloudCheckoutStatus, Project } from "@volli/shared";
import { toast } from "sonner";

import { useProjectsStore } from "@renderer/stores/projects";

import { CloudCheckoutControl } from "./cloud-checkout-control";
import type { CloudCheckoutRpc } from "./use-cloud-checkout";

vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PROJECT = "00000000-0000-4000-8000-0000000000c1";
const REPO = "00000000-0000-4000-8000-0000000000c2";

function standIn(states: CloudCheckoutStatus["state"][]) {
  const answers = [...states];
  const rpc = {
    checkouts: {
      status: {
        query: vi.fn(async (_input: { projectId: string }) => ({
          state: answers.length > 1 ? answers.shift()! : answers[0]!,
        })),
      },
      chooseFolder: {
        mutate: vi.fn(async (_input: { projectId: string }): Promise<CloudCheckoutChoice> => ({
          outcome: "chosen",
          projectRepoId: REPO,
        })),
      },
    },
  } satisfies CloudCheckoutRpc;
  return rpc;
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  useProjectsStore.setState({ projects: [{ id: PROJECT, name: "Volli" } as Project] });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  useProjectsStore.setState({ projects: [] });
  vi.clearAllMocks();
});

async function render(rpc: CloudCheckoutRpc, cloud = true) {
  await act(async () => {
    root.render(<CloudCheckoutControl projectId={PROJECT} rpc={rpc} cloud={cloud} />);
  });
}

const control = () => container.querySelector("button");

describe("Choose the folder…", () => {
  it("draws nothing and asks main nothing outside a Volli Cloud launch", async () => {
    const rpc = standIn(["missing"]);
    await render(rpc, false);
    expect(control()).toBeNull();
    expect(rpc.checkouts.status.query).not.toHaveBeenCalled();
  });

  it("draws nothing when the folder is known or this Mac is not a runner yet", async () => {
    for (const state of ["located", "no_runner"] as const) {
      const rpc = standIn([state]);
      await render(rpc);
      expect(rpc.checkouts.status.query).toHaveBeenCalledWith({ projectId: PROJECT });
      expect(control()).toBeNull();
    }
  });

  it("draws nothing when the status cannot be read", async () => {
    const rpc = standIn(["missing"]);
    rpc.checkouts.status.query.mockRejectedValueOnce(new Error("Volli Cloud is off."));
    await render(rpc);
    expect(control()).toBeNull();
  });

  it("offers the folder for a project this Mac has none for, and hides once it is chosen", async () => {
    const rpc = standIn(["missing", "located"]);
    await render(rpc);
    const button = control()!;
    expect(button.textContent).toBe("Choose the folder…");
    expect(button.getAttribute("aria-label")).toBe("Choose the folder for Volli on this Mac");
    await act(async () => button.click());
    expect(rpc.checkouts.chooseFolder.mutate).toHaveBeenCalledWith({ projectId: PROJECT });
    expect(rpc.checkouts.status.query).toHaveBeenCalledTimes(2);
    expect(control()).toBeNull();
  });

  it("stays when the person closes the picker, and asks nothing more", async () => {
    const rpc = standIn(["missing"]);
    rpc.checkouts.chooseFolder.mutate.mockResolvedValueOnce({ outcome: "cancelled" });
    await render(rpc);
    await act(async () => control()!.click());
    expect(rpc.checkouts.status.query).toHaveBeenCalledOnce();
    expect(control()).not.toBeNull();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("says why a folder was refused, and stays to try again", async () => {
    const rpc = standIn(["missing"]);
    rpc.checkouts.chooseFolder.mutate.mockRejectedValueOnce(
      new Error("Choose the project's own folder, not your home folder."),
    );
    await render(rpc);
    await act(async () => control()!.click());
    expect(toast.error).toHaveBeenCalledWith(
      "Choose the project's own folder, not your home folder.",
      expect.anything(),
    );
    expect(control()!.disabled).toBe(false);
  });

  it.each(["chosen", "cancelled"] as const)(
    "waits for main's local-project confirmation before refreshing the picker state (%s)",
    async (outcome) => {
      const rpc = standIn(outcome === "chosen" ? ["missing", "located"] : ["missing"]);
      let confirm!: (choice: CloudCheckoutChoice) => void;
      rpc.checkouts.chooseFolder.mutate.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            confirm = resolve;
          }),
      );
      await render(rpc);
      await act(async () => control()!.click());
      expect(control()!.disabled).toBe(true);
      expect(rpc.checkouts.status.query).toHaveBeenCalledOnce();
      // Main owns the native warning and keeps this call pending until the
      // person cancels or explicitly selects “Use this folder anyway”.
      await act(async () =>
        confirm(outcome === "chosen" ? { outcome, projectRepoId: REPO } : { outcome }),
      );
      if (outcome === "chosen") {
        expect(control()).toBeNull();
        expect(rpc.checkouts.status.query).toHaveBeenCalledTimes(2);
      } else {
        expect(control()!.disabled).toBe(false);
        expect(rpc.checkouts.status.query).toHaveBeenCalledOnce();
      }
      expect(toast.error).not.toHaveBeenCalled();
    },
  );

  it("is disabled while the picker is open", async () => {
    const rpc = standIn(["missing"]);
    let answer!: (choice: CloudCheckoutChoice) => void;
    rpc.checkouts.chooseFolder.mutate.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    await render(rpc);
    await act(async () => control()!.click());
    expect(control()!.disabled).toBe(true);
    await act(async () => answer({ outcome: "cancelled" }));
    expect(control()!.disabled).toBe(false);
  });
});
