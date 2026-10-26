import { randomUUID } from "node:crypto";

import { describe, expect, test } from "vite-plus/test";

import { PREVIEW_ENROLLMENT_AGREEMENT_VERSION } from "@volli/shared/cloud";

import { api, internal } from "../functions/_generated/api";
import { connectBackend } from "../fixture/testing";

const backend = connectBackend();

// The backend is shared by every file in the run: each test signs in as fresh subjects.
const subject = () => `user:${randomUUID()}`;

describe("accounts on the pinned local backend", () => {
  test("refuses an anonymous caller with a typed error", async () => {
    await expect(backend.client().mutation(api.accounts.ensureViewer, {})).rejects.toMatchObject({
      data: { code: "unauthenticated" },
    });
  });

  test("creates the viewer once from the token's claims, then returns the same one", async () => {
    // VC-936: the preview admits only allowlisted accounts, by verified email.
    await backend.admin(internal.previewAccess.set, {
      kind: "email",
      value: "dana@example.com",
      enabled: true,
    });
    const client = backend.client(subject(), {
      claims: { email: "Dana@Example.com", email_verified: true, name: "Dana" },
    });
    await expect(client.query(api.accounts.viewer, {})).resolves.toBeNull();

    const first = await client.mutation(api.accounts.ensureViewer, {
      acceptedAgreementVersion: PREVIEW_ENROLLMENT_AGREEMENT_VERSION,
    });
    expect(first).toMatchObject({
      displayName: "Dana",
      primaryEmail: "dana@example.com",
      previewAccess: "granted",
      previewAgreementAccepted: true,
      created: true,
    });
    expect(first.userId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );

    // A refresh without the version never infers acceptance: the receipt stands.
    await expect(client.mutation(api.accounts.ensureViewer, {})).resolves.toEqual({
      ...first,
      created: false,
    });
    await expect(client.query(api.accounts.viewer, {})).resolves.toEqual({
      userId: first.userId,
      displayName: "Dana",
      primaryEmail: "dana@example.com",
      status: "active",
      purgeAfter: null,
      previewAccess: "granted",
      previewAgreementAccepted: true,
    });
  });

  test("concurrent first calls for one identity still make one user", async () => {
    const client = backend.client(subject());
    const results = await Promise.all(
      Array.from({ length: 4 }, () => client.mutation(api.accounts.ensureViewer, {})),
    );
    expect(new Set(results.map((result) => result.userId)).size).toBe(1);
    expect(results.filter((result) => result.created)).toHaveLength(1);
  });

  test("different identities are different people", async () => {
    const [a, b] = await Promise.all(
      [subject(), subject()].map((name) =>
        backend.client(name).mutation(api.accounts.ensureViewer, {}),
      ),
    );
    expect(a!.userId).not.toBe(b!.userId);
    expect(a!.displayName).toBe("Volli user");
    // Neither address is allowlisted: both accounts exist, the preview stays closed.
    expect(a!.previewAccess).toBe("waitlisted");
    expect(b!.previewAccess).toBe("waitlisted");
  });
});
