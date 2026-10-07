// @vitest-environment jsdom
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import type { Automation, BlobLinkView, Project, ModelSelection } from "@volli/shared";
import { ComposerForm } from "./composer-form";
import type { ComposerFooter } from "./composer-footer";
import type { ComposerBreadcrumb } from "./composer-breadcrumb";
import type { ComposerChips } from "./composer-chips";
import { clearDraft } from "./draft";
import { useProjectsStore } from "@renderer/stores/projects";
import { runPlainCreate, runKickoff, runCreateWithAutomation } from "./submit";
import type { MonacoDocumentEditor } from "@renderer/components/editor/monaco-document-editor";

const mocks = vi.hoisted(() => ({
  offer: {
    ready: true,
    groups: [] as { status: "doing"; label: string; current: boolean; automations: Automation[] }[],
  },
  files: { getIndex: () => [], refresh: () => {}, forceRefresh: () => {}, version: 0 },
  attachments: {
    attachments: [] as readonly BlobLinkView[],
    attachFiles: async () => {},
    remove: async () => {},
    clear: vi.fn(() => {
      mocks.attachments.attachments = [];
    }),
    reset: () => {},
  },
  run: {
    models: [],
    tiers: [],
    selection: null as ModelSelection | null,
    explicit: false,
    setSelection: () => {},
  },
  branches: { status: "loading" },
}));
vi.mock("@renderer/hooks/use-file-index", () => ({ useFileIndex: () => mocks.files }));
vi.mock("@renderer/hooks/use-attachments", () => ({ useAttachments: () => mocks.attachments }));
vi.mock("./composer-run", () => ({ useComposerRun: () => mocks.run }));
vi.mock("./composer-branch", () => ({ useBranchListing: () => mocks.branches }));
vi.mock("@renderer/components/automations/automation-run-menu", () => ({
  useAutomationRunOffer: () => mocks.offer,
}));
vi.mock("./draft", () => ({
  loadDraft: () => ({ title: "Typed ticket", body: "Keep this prompt" }),
  saveDraft: vi.fn(),
  clearDraft: vi.fn(),
}));
vi.mock("./submit", () => ({
  runPlainCreate: vi.fn(async () => ({ created: false })),
  runKickoff: vi.fn(async () => ({ created: false })),
  runCreateWithAutomation: vi.fn(async () => ({ created: false })),
}));
vi.mock("@renderer/components/editor/monaco-document-editor", () => ({
  MonacoDocumentEditor: ({
    value,
    onChange,
    ariaLabel,
  }: ComponentProps<typeof MonacoDocumentEditor>) => (
    <textarea
      aria-label={ariaLabel}
      value={value}
      onChange={(event) => onChange(event.target.value)}
    />
  ),
}));
vi.mock("./composer-chips", () => ({
  ComposerChips: ({ createMore, onCreateMoreChange }: ComponentProps<typeof ComposerChips>) => (
    <button aria-pressed={createMore} onClick={() => onCreateMoreChange(!createMore)}>
      Create more
    </button>
  ),
}));
vi.mock("./composer-breadcrumb", () => ({
  ComposerBreadcrumb: ({ projects, onRetarget }: ComponentProps<typeof ComposerBreadcrumb>) => (
    <button onClick={() => onRetarget(projects[1]!)}>Retarget</button>
  ),
}));
// The real menu interactions are exercised in composer-footer.test.tsx. Here
// the small view double makes the Form's keyboard and command routing explicit.
vi.mock("./composer-footer", () => ({
  ComposerFooter: ({
    projectId,
    onLaunchChange,
    onCreate,
    onSubmit,
    disabled,
  }: ComponentProps<typeof ComposerFooter>) => (
    <>
      {/* Plain creation is its own button on the real footer too — it is not a
          launch mode the caret menu can select. */}
      <button disabled={disabled} onClick={onCreate}>
        Create
      </button>
      <button onClick={() => onLaunchChange({ kind: "automation", projectId, automationId: "a1" })}>
        Saved
      </button>
      <button disabled={disabled} onClick={onSubmit}>
        Submit
      </button>
    </>
  ),
}));

const project: Project = {
  id: "p1",
  name: "One",
  path: "/repo",
  ticketPrefix: "ONE",
  baseBranch: "main",
  setupCommand: null,
  themeOverride: null,
  colorIndex: 0,
  sortOrder: 0,
  createdAt: 1,
  updatedAt: 1,
};
const automation: Automation = {
  id: "a1",
  projectId: "p1",
  name: "Review",
  instructions: "Saved work",
  trigger: { kind: "columns", columns: ["doing"] },
  runtime: null,
  createdAt: 1,
  updatedAt: 1,
};
let root: Root;
let host: HTMLDivElement;
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  mocks.attachments.attachments = [];
  mocks.run.selection = null;
  mocks.run.explicit = false;
  mocks.offer.ready = true;
  mocks.offer.groups = [
    { status: "doing", label: "Doing", current: false, automations: [automation] },
  ];
  useProjectsStore.setState({ projects: [project, { ...project, id: "p2", name: "Two" }] });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () =>
    root.render(
      <ComposerForm
        initialProject={project}
        expanded={false}
        onToggleExpand={() => {}}
        onClose={() => {}}
      />,
    ),
  );
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function click(text: string) {
  await act(async () =>
    [...host.querySelectorAll("button")].find((el) => el.textContent === text)!.click(),
  );
}
async function typeInto(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  // Go through the DOM event, not a React callback: bypass React's installed
  // value tracker just as a person's keystroke would.
  const prototype =
    element instanceof HTMLInputElement
      ? HTMLInputElement.prototype
      : HTMLTextAreaElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function chord(shiftKey = false, ctrlKey = false) {
  await act(async () =>
    host.querySelector("input")!.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        metaKey: !ctrlKey,
        ctrlKey,
        shiftKey,
        bubbles: true,
      }),
    ),
  );
}

it("sends the default primary action through kickoff, by click and by ⇧⌘Enter", async () => {
  await click("Submit");
  await chord(true);
  expect(runKickoff).toHaveBeenCalledTimes(2);
  expect(runPlainCreate).not.toHaveBeenCalled();
});
it.each([false, true])(
  "only sends a model when the person chose it (explicit=%s)",
  async (explicit) => {
    const model: ModelSelection = {
      providerId: "anthropic",
      modelId: "opus",
      reasoningLevel: "high",
    };
    mocks.run.selection = model;
    mocks.run.explicit = explicit;
    await chord(true);
    expect(runKickoff).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      explicit ? { model } : {},
    );
  },
);
it.each([false, true])(
  "successful kickoff with Create more=%s only closes or resets the composer",
  async (createMore) => {
    const onClose = vi.fn();
    vi.mocked(runKickoff).mockResolvedValueOnce({ created: true });
    await act(async () =>
      root.render(
        <ComposerForm
          initialProject={project}
          expanded={false}
          onToggleExpand={() => {}}
          onClose={onClose}
        />,
      ),
    );
    if (createMore) await click("Create more");
    await click("Submit");

    expect(clearDraft).toHaveBeenCalledOnce();
    expect(runKickoff).toHaveBeenCalledWith(expect.anything(), expect.anything(), {});
    if (createMore) {
      expect(onClose).not.toHaveBeenCalled();
      expect(host.querySelector("input")?.value).toBe("");
    } else {
      expect(onClose).toHaveBeenCalledOnce();
    }
  },
);

it.each([
  ["plain create", "Create", runPlainCreate],
  ["kickoff", "Submit", runKickoff],
  ["automation", "Submit", runCreateWithAutomation],
] as const)(
  "returns Create-more focus with the committed reset after %s",
  async (kind, press, submit) => {
    // A pending animation frame must not leave a blank composer with focus still
    // in the body (or footer). Batch entry is ready in the reset's own commit.
    const frames = vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => 1);
    let finish!: (result: { created: boolean }) => void;
    vi.mocked(submit).mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    await click("Create more");
    if (kind === "automation") await click("Saved");
    const title = host.querySelector("input")!;
    const body = host.querySelector("textarea")!;
    body.focus();
    await click(press);
    expect(title.value).toBe("Typed ticket");
    expect(document.activeElement).toBe(body);

    await act(async () => finish({ created: true }));
    expect(title.value).toBe("");
    expect(body.value).toBe("");
    expect(document.activeElement).toBe(title);
    expect(frames).not.toHaveBeenCalled();
  },
);

it("creates a second ticket in the same mount with fresh fields and no inherited attachments", async () => {
  const onClose = vi.fn();
  const frames = vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => 1);
  const linkDrafts = vi.fn(async () => ({ ok: true }));
  vi.stubGlobal("api", { attachments: { linkDrafts } });
  const attachment: BlobLinkView = {
    linkId: null,
    blobHash: "a".repeat(64),
    label: "first-ticket.png",
    originalName: "first-ticket.png",
    mime: "image/png",
    sizeBytes: 1024,
  };
  mocks.attachments.attachments = [attachment];
  await act(async () =>
    root.render(
      <ComposerForm
        initialProject={project}
        expanded={false}
        onToggleExpand={() => {}}
        onClose={onClose}
      />,
    ),
  );
  vi.mocked(runKickoff)
    .mockImplementationOnce(async (_fields, deps) => {
      await deps.linkAttachments?.("first-ticket");
      return { created: true };
    })
    .mockImplementationOnce(async (_fields, deps) => {
      await deps.linkAttachments?.("second-ticket");
      return { created: true };
    });
  await click("Create more");
  const title = host.querySelector("input")!;
  const body = host.querySelector("textarea")!;
  body.focus();
  await click("Submit");
  expect(runKickoff).toHaveBeenNthCalledWith(
    1,
    expect.objectContaining({ title: "Typed ticket", body: "Keep this prompt" }),
    expect.anything(),
    {},
  );
  expect(linkDrafts).toHaveBeenCalledWith({
    ticketId: "first-ticket",
    blobs: [{ blobHash: attachment.blobHash, label: attachment.label }],
  });
  expect(mocks.attachments.clear).toHaveBeenCalledOnce();
  expect(title.value).toBe("");
  expect(body.value).toBe("");
  expect(host.querySelector('[aria-label="Attachments"]')).toBeNull();
  expect(document.activeElement).toBe(title);
  expect(frames).not.toHaveBeenCalled();
  expect(host.querySelector('[aria-pressed="true"]')?.textContent).toBe("Create more");

  await typeInto(title, "Second ticket");
  await typeInto(body, "Only the second brief");
  body.focus();
  await chord(true);

  expect(runKickoff).toHaveBeenNthCalledWith(
    2,
    expect.objectContaining({ title: "Second ticket", body: "Only the second brief" }),
    expect.anything(),
    {},
  );
  expect(linkDrafts).toHaveBeenCalledOnce(); // no first-ticket blob linked to the second ticket
  expect(runKickoff).toHaveBeenCalledTimes(2);
  expect(clearDraft).toHaveBeenCalledTimes(2);
  expect(mocks.attachments.clear).toHaveBeenCalledTimes(2);
  expect(onClose).not.toHaveBeenCalled();
  expect(title.value).toBe("");
  expect(body.value).toBe("");
  expect(host.querySelector('[aria-pressed="true"]')?.textContent).toBe("Create more");
  expect(document.activeElement).toBe(title);
  expect(frames).not.toHaveBeenCalled();
});

it("gives plain creation its own button and the unmodified chord", async () => {
  await click("Create");
  await chord();
  await chord(false, true);
  expect(runPlainCreate).toHaveBeenCalledTimes(3);
  expect(runKickoff).not.toHaveBeenCalled();
});
it("leaves the launch mode alone when plain creation runs", async () => {
  await click("Saved");
  await click("Create");
  expect(runPlainCreate).toHaveBeenCalledOnce();
  expect(runCreateWithAutomation).not.toHaveBeenCalled();
  // The saved selection survives, so the primary still runs it afterwards.
  await click("Submit");
  expect(runCreateWithAutomation).toHaveBeenCalledOnce();
});
it("the saved mode passes the actual current Automation and preserves ticket fields", async () => {
  await click("Saved");
  expect(runCreateWithAutomation).not.toHaveBeenCalled();
  await chord(true);
  expect(runCreateWithAutomation).toHaveBeenCalledWith(
    expect.objectContaining({ status: "backlog", body: "Keep this prompt", projectId: "p1" }),
    expect.anything(),
    { automation },
  );
  expect(runKickoff).not.toHaveBeenCalled();
});
it("points Shift+⌘Enter at whatever the caret menu selected, not always chat", async () => {
  await click("Saved");
  await chord(true);
  expect(runCreateWithAutomation).toHaveBeenCalledOnce();
  expect(runKickoff).not.toHaveBeenCalled();
});
it("retargeting cannot run the previous project's selected Automation", async () => {
  await click("Saved");
  await click("Retarget");
  await chord(true);
  expect(runKickoff).toHaveBeenCalledWith(
    expect.objectContaining({ projectId: "p2" }),
    expect.anything(),
    expect.anything(),
  );
  expect(runCreateWithAutomation).not.toHaveBeenCalled();
});
it("blocks submission if the saved record vanishes after selection", async () => {
  await click("Saved");
  mocks.offer.groups = [];
  await chord(true);
  expect(runCreateWithAutomation).not.toHaveBeenCalled();
  expect(runKickoff).not.toHaveBeenCalled();
  expect(runPlainCreate).not.toHaveBeenCalled();
});
/**
 * The composer opens at 36rem, and its tray commits rather than sends: Create,
 * the primary and the launch caret take 215px of the settings' own line, so
 * model and effort have to fold into one control far earlier than a chat
 * footer's 24rem (VC-382). The threshold is asked for by MARKING the container
 * — `globals.css` and the model pill's portalled popover both read this exact
 * value — so losing the mark silently restores the wrapped footer.
 */
it("asks for the commit tray's own fold by marking its composer container", () => {
  expect(
    host.querySelector("[data-composer-container]")?.getAttribute("data-composer-container"),
  ).toBe("commit-tray");
});

it("gives the attachment strip the same air above the tiles and below them", async () => {
  mocks.attachments.attachments = [
    {
      linkId: null,
      blobHash: "a".repeat(64),
      label: "screenshot.png",
      originalName: "screenshot.png",
      mime: "image/png",
      sizeBytes: 1024,
    },
  ];
  await act(async () =>
    root.render(
      <ComposerForm
        initialProject={project}
        expanded={false}
        onToggleExpand={() => {}}
        onClose={() => {}}
      />,
    ),
  );
  // The strip is the last band before the tray's own top edge, so a top-only
  // inset left the 64px tiles sitting ON that hairline beside the buttons.
  const strip = host.querySelector('[aria-label="Attachments"]');
  expect(strip?.className).toContain("py-2");
  expect(strip?.className).not.toContain("pt-2");
});

it.each([
  ["plain-create", "Create", runPlainCreate],
  ["kickoff", "Submit", runKickoff],
] as const)(
  "re-enables the composer when the %s submission rejects",
  async (_kind, press, submit) => {
    vi.mocked(submit).mockRejectedValueOnce(new Error("bridge unavailable"));
    await click(press);
    expect(
      [...host.querySelectorAll("button")].find((button) => button.textContent === press)?.disabled,
    ).toBe(false);
  },
);

/**
 * Read-only (VC-576): a composer already open when p1's host goes away keeps
 * its draft and submits nothing — by button or chord — and says why above the
 * footer. Back online, it submits as before.
 */
it("refuses every submission while the project's host cannot serve, keeping the draft", async () => {
  const { useExperimentsStore } = await import("@renderer/stores/experiments");
  const { useHostConnectionStore } = await import("@renderer/stores/host-connection");
  const { createFakeHostSource, hostSnapshot, remoteHost } =
    await import("@renderer/stores/host-sources");
  const remote = createFakeHostSource(
    hostSnapshot([remoteHost("h1", "hetzner-1")], { p1: "h1", p2: "h1" }),
  );
  useExperimentsStore.setState({ snapshot: { cloud: { enabled: true, source: "storage" } } });
  const detach = useHostConnectionStore.getState().attach(remote);
  try {
    await act(async () =>
      remote.setHost("h1", { link: { status: "offline", since: 0, retryAt: null } }),
    );
    const note = host.querySelector('[data-slot="host-read-only-note"]');
    expect(note?.textContent).toBe("Can’t reach hetzner-1 · Read-only");
    const create = [...host.querySelectorAll("button")].find((el) => el.textContent === "Create");
    expect(create?.disabled).toBe(true);
    await chord();
    await chord(true);
    await click("Saved");
    await chord(true);
    expect(runPlainCreate).not.toHaveBeenCalled();
    expect(runKickoff).not.toHaveBeenCalled();
    expect(runCreateWithAutomation).not.toHaveBeenCalled();
    expect(host.querySelector("input")?.value).toBe("Typed ticket");

    await act(async () => remote.setHost("h1", { link: { status: "open" } }));
    expect(host.querySelector('[data-slot="host-read-only-note"]')).toBeNull();
    await chord();
    expect(runPlainCreate).toHaveBeenCalledOnce();
  } finally {
    detach();
    useExperimentsStore.setState({ snapshot: null });
  }
});
