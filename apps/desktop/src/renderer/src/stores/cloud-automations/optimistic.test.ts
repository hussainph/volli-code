import { describe, expect, it } from "vite-plus/test";
import type { OptimisticLocalStore } from "convex/browser";
import { api } from "@volli/convex/api";
import { parseId } from "@volli/shared/cloud";
import { NO_AUTOMATION_TRIGGER } from "@volli/shared";
import { fakeCloud } from "../cloud-board/fake-cloud.test-support";
import { optimisticDefinition, optimisticArming } from "./optimistic";
import { A, P, R, U, T, automation, arming, runner } from "./fixtures.test-support";
const X = parseId("automation", "10000000-0000-4000-8000-000000000099");
const draft = {
  commandId: T,
  projectId: P,
  name: "Another",
  instructions: "Work",
  runtime: null,
  trigger: NO_AUTOMATION_TRIGGER,
};
const definition = {
  ...automation,
  id: parseId("automation", A),
  projectId: parseId("project", P),
  deletedAt: null,
  triggerSpec: automation.trigger,
  createdBy: { kind: "person" as const, userId: parseId("user", U) },
};
function setup() {
  const cloud = fakeCloud();
  const list = () =>
    cloud.session.client.watchQuery(api.automations.list, { projectId: P }).localQueryResult();
  const arms = () =>
    cloud.session.client.watchQuery(api.automations.armings, { projectId: P }).localQueryResult();
  const apply = async (update: (store: OptimisticLocalStore) => void) => {
    const result = cloud.session.client.mutation(
      api.automations.remove,
      { commandId: T, automationId: A },
      { optimisticUpdate: update },
    );
    cloud.mutations.at(-1)!.resolve({});
    await result;
  };
  return { cloud, list, arms, apply };
}
describe("shared-rule optimistic Automation projections", () => {
  it("leaves cold or refused definition caches untouched", async () => {
    const { cloud, list, apply } = setup();
    await apply((store) =>
      optimisticDefinition(store, api.automations, {
        projectId: P,
        automationId: X,
        draft,
        change: "create",
        userId: U,
        now: 10,
      }),
    );
    expect(list()).toBeUndefined();
    cloud.answer("automations:list", { projectId: P }, [definition]);
    await apply((store) =>
      optimisticDefinition(store, api.automations, {
        projectId: P,
        automationId: X,
        draft: { ...draft, instructions: "" },
        change: "create",
        userId: U,
        now: 10,
      }),
    );
    expect(list()).toEqual([definition]);
  });
  it("creates a sorted accepted draft with caller attribution and preserves evidence on edit", async () => {
    const { cloud, list, apply } = setup();
    cloud.answer("automations:list", { projectId: P }, [definition]);
    await apply((store) =>
      optimisticDefinition(store, api.automations, {
        projectId: P,
        automationId: X,
        draft,
        change: "create",
        userId: U,
        now: 10,
      }),
    );
    expect(list()?.map((row) => row.name)).toEqual(["Another", "Review"]);
    expect(list()?.[0]).toMatchObject({
      createdAt: 10,
      updatedAt: 10,
      createdBy: { userId: U },
      id: X,
    });
    await apply((store) =>
      optimisticDefinition(store, api.automations, {
        projectId: P,
        automationId: A,
        draft: { ...draft, automationId: A, name: "Edited" },
        change: "update",
        userId: U,
        now: 20,
      }),
    );
    expect(list()?.find((row) => row.id === A)).toMatchObject({
      createdAt: 1,
      updatedAt: 20,
      name: "Edited",
    });
  });
  it("does not invent an arming when either planning read is cold", async () => {
    const { cloud, arms, apply } = setup();
    const input = {
      intent: {
        commandId: T,
        projectId: P,
        status: "doing" as const,
        automationId: A,
        runnerId: R,
      },
      userId: U,
      runners: [runner()],
      now: 10,
    };
    await apply((store) => optimisticArming(store, api.automations, input));
    expect(arms()).toBeUndefined();
    cloud.answer("automations:armings", { projectId: P }, []);
    await apply((store) => optimisticArming(store, api.automations, input));
    expect(arms()).toEqual([]);
  });
  it.each([null, { tools: "not-an-array" }, { tools: ["automation.run", 42] }])(
    "uses only shared-rule-valid runners, tools=%s",
    async (capabilities) => {
      const { cloud, arms, apply } = setup();
      cloud.answer("automations:list", { projectId: P }, [definition]);
      cloud.answer("automations:armings", { projectId: P }, []);
      await apply((store) =>
        optimisticArming(store, api.automations, {
          intent: { commandId: T, projectId: P, status: "doing", automationId: A, runnerId: R },
          userId: U,
          runners: [runner({ capabilities })],
          now: 10,
        }),
      );
      if (Array.isArray(capabilities?.tools))
        expect(arms()).toMatchObject([
          { runnerId: R, armedByUserId: U, armedByDisplayName: "You", runnerName: "Ada’s Mac" },
        ]);
      else expect(arms()).toEqual([]);
    },
  );
  it("refuses absent automation/runner facts and disarms without borrowing a runner", async () => {
    const { cloud, arms, apply } = setup();
    cloud.answer("automations:list", { projectId: P }, [definition]);
    cloud.answer("automations:armings", { projectId: P }, [arming]);
    const intent = {
      commandId: T,
      projectId: P,
      status: "doing" as const,
      automationId: A,
      runnerId: R,
    };
    await apply((store) =>
      optimisticArming(store, api.automations, { intent, userId: U, runners: [], now: 10 }),
    );
    expect(arms()).toEqual([arming]);
    await apply((store) =>
      optimisticArming(store, api.automations, {
        intent: { ...intent, automationId: X },
        userId: U,
        runners: [runner()],
        now: 10,
      }),
    );
    expect(arms()).toEqual([arming]);
    await apply((store) =>
      optimisticArming(store, api.automations, {
        intent: { ...intent, automationId: null, runnerId: null },
        userId: U,
        runners: [],
        now: 10,
      }),
    );
    expect(arms()).toEqual([]);
  });
});
