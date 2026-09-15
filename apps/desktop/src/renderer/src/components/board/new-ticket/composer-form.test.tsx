// @vitest-environment jsdom
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import type { Automation, BlobLinkView, Project } from "@volli/shared";
import { ComposerForm } from "./composer-form";
import type { ComposerFooter } from "./composer-footer";
import type { ComposerBreadcrumb } from "./composer-breadcrumb";
import { useProjectsStore } from "@renderer/stores/projects";
import { runPlainCreate, runKickoff, runCreateWithAutomation } from "./submit";

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
    clear: () => {},
    reset: () => {},
  },
  run: { models: [], tiers: [], selection: null, setSelection: () => {} },
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
  MonacoDocumentEditor: () => <textarea aria-label="Ticket description" />,
}));
vi.mock("./composer-chips", () => ({ ComposerChips: () => null }));
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
  vi.unstubAllGlobals();
});
async function click(text: string) {
  await act(async () =>
    [...host.querySelectorAll("button")].find((el) => el.textContent === text)!.click(),
  );
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
