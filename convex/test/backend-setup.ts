/** The serial backend suite shares one loopback IP; quotas belong to a test, not the suite. */
import { beforeEach } from "vite-plus/test";
import { internal } from "../functions/_generated/api";
import { connectBackend } from "../fixture/testing";
import { RATE_LIMIT_SWEEP_PAGE_SIZE } from "../functions/lib/runnerLinkRateLimit";

beforeEach(async () => {
  // Internal, test-issuer-only reset. Rate-limit tests still exercise the real
  // policy within each test; no deployment setting weakens the limiter.
  while (
    (await connectBackend().admin(internal.testSeed.resetRunnerLinkLimits, {})) ===
    RATE_LIMIT_SWEEP_PAGE_SIZE
  ) {
    // Reset is paged to stay inside the mutation's transaction budget.
  }
});
