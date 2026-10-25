import { afterEach, describe, expect, it } from "vite-plus/test";

import { tempInventory } from "../account/test-support";
import {
  inventoryRunnerLinkStore,
  parseRunnerLink,
  runnerLinkPurpose,
  StaleRunnerLinkError,
} from "./identity-store";

const DANA = "11111111-1111-4111-8111-111111111111";
const SAM = "55555555-5555-4555-8555-555555555555";
const RUNNER = "22222222-2222-4222-8222-222222222222";
const OTHER = "33333333-3333-4333-8333-333333333333";
const LINK = { runnerId: RUNNER, name: "danas-mac", credential: "vrc_1", generation: 1 };
const unlock = async () => {};

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function store(owner = DANA) {
  const temp = tempInventory();
  cleanups.push(temp.dispose);
  return { temp, store: inventoryRunnerLinkStore(temp.inventory, unlock, owner) };
}

describe("the sealed runner link", () => {
  it("round-trips through the real sealed inventory, per person", async () => {
    const { temp, store: dana } = store();
    expect(await dana.load()).toBeNull();
    await dana.save(LINK as never);
    expect(await dana.load()).toEqual(LINK);
    const sam = inventoryRunnerLinkStore(temp.inventory, unlock, SAM);
    expect(await sam.load()).toBeNull();
    expect(temp.inventory.list("host-private").map(({ selector }) => selector.purpose)).toEqual([
      runnerLinkPurpose(DANA),
    ]);
    await dana.clear();
    expect(await dana.load()).toBeNull();
  });

  it("refuses a save that is not newer for the same runner, and takes a new runner's", async () => {
    const { store: dana } = store();
    await dana.save({ ...LINK, generation: 2 } as never);
    await expect(dana.save({ ...LINK, generation: 2 } as never)).rejects.toBeInstanceOf(
      StaleRunnerLinkError,
    );
    await expect(dana.save({ ...LINK, generation: 1 } as never)).rejects.toThrow("not newer");
    await dana.save({ ...LINK, credential: "vrc_3", generation: 3 } as never);
    await dana.save({ ...LINK, runnerId: OTHER, generation: 1 } as never);
    expect((await dana.load())?.runnerId).toBe(OTHER);
  });

  it("drops an unreadable record, keeps a newer build's, and reads another owner's as none", async () => {
    const { temp, store: dana } = store();
    const selector = { purpose: runnerLinkPurpose(DANA) };
    temp.inventory.put("host-private", selector, "not json");
    expect(await dana.load()).toBeNull();
    expect(temp.inventory.get("host-private", selector)).toBeNull();
    temp.inventory.put("host-private", selector, JSON.stringify({ v: 2, anything: true }));
    expect(await dana.load()).toBeNull();
    expect(temp.inventory.get("host-private", selector)).not.toBeNull();
    const samsValue = JSON.stringify({ v: 1, ownerUserId: SAM, ...LINK });
    expect(parseRunnerLink(samsValue, DANA)).toBeNull();
    expect(parseRunnerLink(samsValue, SAM)).toEqual(LINK);
    for (const bad of [
      null,
      7,
      "null",
      JSON.stringify({ v: 1, ownerUserId: DANA, ...LINK, generation: 0 }),
      JSON.stringify({ v: 1, ownerUserId: DANA, ...LINK, credential: "" }),
      JSON.stringify({ v: 1, ownerUserId: DANA, ...LINK, runnerId: "not-a-uuid" }),
    ]) {
      expect(parseRunnerLink(bad, DANA)).toBeNull();
    }
  });
});
