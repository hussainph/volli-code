/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import type { CliToolStatus } from "../../../../ipc/contract";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

vi.mock("@renderer/hooks/use-selected-project", () => ({
  useSelectedProject: () => null,
}));

import { CliSettings } from "./cli-settings";

function status(overrides: Partial<CliToolStatus> = {}): CliToolStatus {
  return {
    link: { path: "/home/me/.local/bin/volli", state: "ours", target: "/shim/volli" },
    path: { binDir: "/home/me/.local/bin", state: "reachable" },
    environment: {
      loginPath: "/usr/bin:/home/me/.local/bin",
      session: {
        path: "/volli/bin:/usr/bin:/home/me/.local/bin",
        provenance: "adopted",
        interactiveProvenance: "already-complete",
        tools: {
          git: "/usr/bin/git",
          gh: "/opt/homebrew/bin/gh",
          node: "/opt/homebrew/bin/node",
          pnpm: "/opt/homebrew/bin/pnpm",
        },
        dependencies: null,
        installCommand: null,
      },
      systemPathIssues: [],
    },
    socket: { path: "/profiles/volli.sock", live: true },
    wrappers: { commands: ["claude", "codex"] },
    shell: { name: "zsh", supported: true, chainActive: true },
    legacy: { path: "/usr/local/bin/volli", state: "absent" },
    installSuppressed: false,
    ...overrides,
  };
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;

async function renderCli(statusResult: CliToolStatus): Promise<HTMLDivElement> {
  Object.defineProperty(window, "api", {
    configurable: true,
    value: {
      cli: {
        status: vi.fn(async () => ({ ok: true, status: statusResult })),
        doctor: vi.fn(),
      },
    },
  });

  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(<CliSettings />);
    await Promise.resolve();
  });
  return host;
}

function buttonWithText(container: HTMLElement, text: string): HTMLButtonElement {
  const button = [...container.querySelectorAll("button")].find(
    (candidate) => candidate.textContent === text,
  );
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`no button named ${text}`);
  }
  return button;
}

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  host?.remove();
  root = null;
  host = null;
  Reflect.deleteProperty(window, "api");
});

describe("CliSettings", () => {
  it("condenses a healthy install until its details are requested", async () => {
    const pane = await renderCli(status());

    expect(pane.textContent).toContain("Installed and working");
    expect(pane.textContent).toContain("Run Doctor");
    expect(pane.querySelector('button[aria-label="Refresh CLI status"]')).not.toBeNull();
    expect(pane.textContent).not.toContain("Linked");
    expect(pane.textContent).not.toContain("Session PATH");

    const showDetails = buttonWithText(pane, "Show details");
    expect(showDetails.getAttribute("aria-expanded")).toBe("false");
    await act(async () => {
      showDetails.click();
    });

    expect(pane.textContent).toContain("Linked");
    expect(pane.textContent).toContain("Session PATH");
    expect(buttonWithText(pane, "Hide details").getAttribute("aria-expanded")).toBe("true");
  });

  it("keeps a warning and its detail in sight while the healthy diagnostics stay collapsed", async () => {
    const pane = await renderCli(status({ socket: { path: "/profiles/volli.sock", live: false } }));

    expect(pane.textContent).toContain("App socket");
    expect(pane.textContent).toContain("Not running");
    expect(pane.textContent).toContain("/profiles/volli.sock");
    expect(pane.textContent).not.toContain("Installed and working");
    expect(pane.textContent).not.toContain("Linked");
    expect(pane.textContent).not.toContain("Session PATH");

    await act(async () => {
      buttonWithText(pane, "Show details").click();
    });

    expect(pane.textContent).toContain("Linked");
    expect(pane.textContent).toContain("Volli on login PATH");
    expect(pane.textContent).toContain("Session PATH");
  });
});
