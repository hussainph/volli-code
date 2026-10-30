/** Exercise exact fixture-env restoration through the real admin transport. */
import { expect, test, vi } from "vite-plus/test";

import { scopeDeploymentEnv } from "../fixture/deployment-env";

test("file scopes restore existing, empty and absent deployment variables", async () => {
  const original = await scopeDeploymentEnv({
    VOLLI_TEST_SCOPE_EXISTING: "earlier-fixture",
    VOLLI_TEST_SCOPE_EMPTY: "",
    VOLLI_TEST_SCOPE_ABSENT: null,
  });
  try {
    const owned = await scopeDeploymentEnv({
      VOLLI_TEST_SCOPE_EXISTING: "this-fixture",
      VOLLI_TEST_SCOPE_EMPTY: "this-fixture",
      VOLLI_TEST_SCOPE_ABSENT: "this-fixture",
    });
    try {
      expect(owned.previous).toEqual({
        VOLLI_TEST_SCOPE_EXISTING: "earlier-fixture",
        VOLLI_TEST_SCOPE_EMPTY: "",
        VOLLI_TEST_SCOPE_ABSENT: null,
      });
    } finally {
      await owned.restore();
    }
    const next = await scopeDeploymentEnv({
      VOLLI_TEST_SCOPE_EXISTING: null,
      VOLLI_TEST_SCOPE_EMPTY: null,
      VOLLI_TEST_SCOPE_ABSENT: null,
    });
    try {
      expect(next.previous).toEqual(owned.previous);
    } finally {
      await next.restore();
    }
  } finally {
    await original.restore();
  }
});

test("a lost setup acknowledgement restores the previous deployment setting", async () => {
  const original = await scopeDeploymentEnv({ VOLLI_TEST_SCOPE_ACK: "earlier-fixture" });
  const realFetch = globalThis.fetch;
  let lost = false;
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const response = await realFetch(input, init);
    if (!lost && String(input).endsWith("/api/update_environment_variables")) {
      lost = true;
      throw new Error("Lost fixture update acknowledgement");
    }
    return response;
  });
  try {
    await expect(scopeDeploymentEnv({ VOLLI_TEST_SCOPE_ACK: "this-fixture" })).rejects.toThrow(
      "Lost fixture update acknowledgement",
    );
    expect(lost).toBe(true);
    const next = await scopeDeploymentEnv({ VOLLI_TEST_SCOPE_ACK: null });
    try {
      expect(next.previous).toEqual({ VOLLI_TEST_SCOPE_ACK: "earlier-fixture" });
    } finally {
      await next.restore();
    }
  } finally {
    fetch.mockRestore();
    await original.restore();
  }
});
