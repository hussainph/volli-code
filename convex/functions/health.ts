import { query } from "./_generated/server";

/**
 * Who the backend says the caller is. Every public function requires an
 * identity: an unauthenticated public function is callable by anyone who can
 * reach the deployment, and a local backend reflects any CORS origin.
 */
export const whoami = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (identity === null) throw new Error("Unauthenticated");
    return { subject: identity.subject, issuer: identity.issuer };
  },
});
