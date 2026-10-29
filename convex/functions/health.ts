import { ConvexError, v } from "convex/values";

import { internalQuery, query } from "./_generated/server";
import { requireIdentity } from "./lib/auth";
import { checkDeployment, describeProblems } from "./lib/deploymentChecks";

/**
 * Who the backend says the caller is. Every public function requires an
 * identity: an unauthenticated public function is callable by anyone who can
 * reach the deployment, and a local backend reflects any CORS origin.
 */
export const whoami = query({
  args: { compatibilityProbe: v.string() },
  handler: async (ctx) => {
    const identity = await requireIdentity(ctx);
    return { subject: identity.subject, issuer: identity.issuer };
  },
});

// The runtime may throw on reading an unset variable; absence is caught.
function readEnv(name: string): string | undefined {
  try {
    return process.env[name];
  } catch {
    return undefined;
  }
}

/**
 * The deployment self-check (`lib/deploymentChecks.ts`), which
 * `scripts/deploy.mjs` runs after every `convex deploy`:
 *
 *   npx convex run health:deploymentChecks '{}'
 *
 * Internal, so only a deploy or admin key reaches it. `mode` defaults to
 * `cloud`; `test` is refused on any deployment that is not loopback. An unsafe
 * configuration throws `deployment_unsafe` with the report, so the CLI exits
 * non-zero; a safe one returns it. Neither carries a value.
 */
export const deploymentChecks = internalQuery({
  args: { mode: v.optional(v.union(v.literal("cloud"), v.literal("test"))) },
  handler: async (_ctx, { mode }) => {
    const report = checkDeployment(mode ?? "cloud", readEnv);
    if (!report.ok) {
      throw new ConvexError({
        code: "deployment_unsafe",
        message: `This deployment is unsafe to serve:\n${describeProblems(report.problems)}`,
        report,
      });
    }
    return report;
  },
});
