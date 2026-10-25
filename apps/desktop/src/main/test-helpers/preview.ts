/** Explicit preview enrollment for live tests on the throwaway Convex fixture only. */
import { ConvexHttpClient } from "convex/browser";
import { internal } from "@volli/convex/api";

export async function inviteTestEmail(url: string, email: string): Promise<void> {
  const key = process.env["VOLLI_CONVEX_ADMIN_KEY"];
  if (!key) throw new Error("Live preview tests require the fixture's admin key.");
  const admin = new ConvexHttpClient(url);
  (admin as unknown as { setAdminAuth(key: string): void }).setAdminAuth(key);
  await admin.mutation(
    internal.previewAccess.set as never,
    { kind: "email", value: email, enabled: true } as never,
  );
}
