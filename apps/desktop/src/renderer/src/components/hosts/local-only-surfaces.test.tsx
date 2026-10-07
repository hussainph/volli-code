// @vitest-environment jsdom
/**
 * The local-only doors a remote project must never reach (VC-711 PR 2 review
 * N2–N4): a file or diff tab restored for a remote project, Home's New Browser,
 * and an attachment dropped on a remote draft. Each stands down without one
 * `window.api` call, and says where it is not available.
 */
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { Ticket } from "@volli/shared";

vi.mock("@renderer/components/editor/monaco-file-editor", () => ({
  MonacoFileEditor: () => null,
}));
vi.mock("@renderer/components/editor/monaco-document-editor", () => ({
  MonacoDocumentEditor: () => null,
}));
vi.mock("@renderer/editor/monaco-runtime", () => ({
  loadMonacoRuntime: vi.fn(async () => {
    throw new Error("Monaco is not loaded in tests");
  }),
}));
const toast = vi.hoisted(() => Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast, Toaster: () => null }));

import { openBrowserTab } from "@renderer/components/browser/open-browser-tab";
import { DiffView } from "@renderer/components/ticket/diff-view";
import { FileView } from "@renderer/components/ticket/file-view";
import { useAttachments, type AttachmentsHandle } from "@renderer/hooks/use-attachments";

import { hostWorld, type HostWorld } from "./hosts.test-support";

let world: HostWorld | null = null;

afterEach(async () => {
  await world?.cleanup();
  world = null;
  toast.mockClear();
});

/** A `window.api` whose every call is recorded and answered with nothing. */
function recordingApi(): string[] {
  const calls: string[] = [];
  const api = new Proxy(
    {},
    {
      get: (_api, area) =>
        new Proxy(() => {}, {
          get:
            (_door, method) =>
            (...args: unknown[]) => {
              calls.push(`${String(area)}.${String(method)}`);
              void args;
              return Promise.resolve({ ok: false, error: "recorded" });
            },
        }),
    },
  );
  vi.stubGlobal("window", Object.assign(window, { api }));
  return calls;
}

const TICKET = {
  id: "t1",
  projectId: "remote",
  branch: null,
  baseBranch: null,
} as unknown as Ticket;

describe("a remote project's local-only doors", () => {
  it("never mounts a restored file or diff tab, and says where it is not available", async () => {
    world = hostWorld();
    const calls = recordingApi();
    const root = await world.render(
      <>
        <FileView projectId="remote" ticketId="t1" relPath="README.md" />
        <DiffView projectId="remote" ticket={TICKET} relPath="README.md" />
      </>,
    );
    expect(
      [...root.querySelectorAll('[data-slot="host-local-only"]')].map((node) => node.textContent),
    ).toEqual(["Not available on hetzner-1 yet", "Not available on hetzner-1 yet"]);
    expect(calls).toEqual([]);
  });

  it("opens no Browser Tab for a remote project from the shared door", async () => {
    world = hostWorld();
    const open = vi.fn();
    const activate = vi.fn();
    await openBrowserTab({ open }, { projectId: "remote" }, activate);
    expect(open).not.toHaveBeenCalled();
    expect(activate).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith("Not available on hetzner-1 yet", { id: "host-local-only" });
  });

  it("imports no attachment into a remote project's draft", async () => {
    world = hostWorld();
    const calls = recordingApi();
    const failures: string[] = [];
    let handle: AttachmentsHandle | null = null;
    function Draft() {
      handle = useAttachments({
        owner: { unowned: true },
        refRoot: "/srv/remote",
        projectId: "remote",
        onError: (message) => void failures.push(message),
      });
      return null;
    }
    await world.render(<Draft />);
    await act(async () => {
      await handle!.attachFiles([new File(["x"], "notes.txt")]);
    });
    expect(failures).toEqual(["Not available on hetzner-1 yet"]);
    expect(calls).toEqual([]);
  });
});
