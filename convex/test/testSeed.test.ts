import { convexTest } from "convex-test";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { internal } from "../functions/_generated/api";
import schema from "../functions/schema";

const modules = import.meta.glob("../functions/**/*.ts");
afterEach(() => vi.unstubAllEnvs());

test("limiter reset is internal and refuses a non-test deployment", async () => {
  const t = convexTest(schema, modules);
  await t.mutation(internal.runnerLinkRateLimit.admitLinkStart, { ip: "192.0.2.1" });
  vi.stubEnv("VOLLI_TEST_JWKS", "");
  await expect(t.mutation(internal.testSeed.resetRunnerLinkLimits, {})).rejects.toThrow(
    "Test seeding runs only on a test deployment.",
  );
  expect(await t.run((ctx) => ctx.db.query("runnerLinkRateLimits").collect())).toHaveLength(2);
  vi.stubEnv("VOLLI_TEST_JWKS", "fixture-only");
  expect(await t.mutation(internal.testSeed.resetRunnerLinkLimits, {})).toBe(2);
  expect(await t.mutation(internal.testSeed.resetRunnerLinkLimits, {})).toBe(0);
});
