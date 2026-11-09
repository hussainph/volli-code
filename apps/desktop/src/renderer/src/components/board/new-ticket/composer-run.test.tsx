// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";
import {
  EMPTY_MODEL_ACCESS_DEFAULTS,
  type ModelAccessSnapshot,
  type ModelSelection,
} from "@volli/shared";
import type { ComposerRunner } from "@renderer/components/chat/runner-picker-model";
import { useComposerRun, type ComposerRun } from "./composer-run";

const access = vi.hoisted(() => ({
  inspect: vi.fn(async (): Promise<ModelAccessSnapshot> => ({
    observedAt: 1,
    models: [],
    providers: [],
  })),
  hiddenModels: vi.fn(async () => []),
  defaults: vi.fn(),
  revision: 0,
}));
vi.mock("@renderer/lib/model-access-client", () => ({ useModelAccessClient: () => access }));
const DEFAULT: ModelSelection = {
  providerId: "anthropic",
  modelId: "opus",
  reasoningLevel: "high",
};
let root: Root | undefined;
let run: ComposerRun;
function Probe({
  projectId = "p1",
  runner,
}: {
  projectId?: string;
  runner?: ComposerRunner | null;
}) {
  run = useComposerRun(null, projectId, runner);
  return null;
}
afterEach(async () => {
  await act(async () => root?.unmount());
  vi.unstubAllGlobals();
});
async function mount() {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  access.defaults.mockResolvedValue({ ...EMPTY_MODEL_ACCESS_DEFAULTS, global: DEFAULT });
  root = createRoot(document.createElement("div"));
  await act(async () => root!.render(<Probe />));
}
it("shows the seeded default without naming it as an explicit choice", async () => {
  await mount();
  expect(run.selection).toEqual(DEFAULT);
  expect(run.explicit).toBe(false);
});
it.each([DEFAULT, { ...DEFAULT, reasoningLevel: "low" } as const])(
  "marks model and effort choices explicit, even when picking the default (%s)",
  async (selection) => {
    await mount();
    await act(async () => run.setSelection(selection));
    expect(run.explicit).toBe(true);
    expect(run.selection).toEqual(selection);
    // Catalog refresh cannot erase a person's explicit choice.
    access.revision += 1;
    await act(async () => root!.render(<Probe />));
    expect(run.explicit).toBe(true);
    expect(run.selection).toEqual(selection);
    await act(async () => root!.render(<Probe projectId="p2" />));
    expect(run.explicit).toBe(false);
    expect(run.selection).toEqual(DEFAULT);
  },
);

it("filters cloud models and drops an unsupported pick when the runner changes", async () => {
  access.inspect.mockResolvedValue({
    observedAt: 1,
    providers: [],
    models: [
      {
        providerId: "anthropic",
        modelId: "opus",
        label: "Opus",
        state: "available",
        reasoningLevels: ["high"],
        acceptsImageInput: true,
      },
      {
        providerId: "openai",
        modelId: "remote",
        label: "Remote",
        state: "authentication-required",
        reasoningLevels: ["low"],
        acceptsImageInput: true,
      },
    ],
  });
  await mount();
  const runner: ComposerRunner = {
    id: "runner",
    name: "Linux",
    kind: "linux",
    status: "online",
    statusChangedAt: 1,
    providers: ["anthropic"],
    version: "1",
    upgradeRequired: false,
  };
  await act(async () => root!.render(<Probe runner={runner} />));
  await act(async () => run.setSelection(DEFAULT));
  expect(run.selection).toEqual(DEFAULT);
  await act(async () =>
    root!.render(<Probe runner={{ ...runner, id: "other", providers: ["openai"] }} />),
  );
  expect(run.models.map((model) => model.providerId)).toEqual(["openai"]);
  expect(run.selection).toBeNull();
  expect(run.explicit).toBe(false);
  expect(run.tiers.filter((row) => row.state === "ready")).toEqual([]);
  await act(async () => root!.render(<Probe runner={null} />));
  expect(run.models).toEqual([]);
  expect(run.selection).toBeNull();
});
