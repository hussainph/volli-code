/**
 * The GitHub webhook through the real HTTP router of the pinned backend:
 * a signed body is accepted once per delivery id, anything unsigned or for
 * another App writes nothing.
 */

import { createHmac, randomUUID } from "node:crypto";

import { describe, expect, test } from "vite-plus/test";

import { TEST_GITHUB_APP_ID, TEST_GITHUB_WEBHOOK_SECRET } from "../fixture/github";

const site = process.env["VOLLI_CONVEX_SITE_URL"]!;

function post(
  event: string,
  payload: unknown,
  options: { id?: string; secret?: string; appId?: string } = {},
) {
  const body = JSON.stringify(payload);
  const signature = createHmac("sha256", options.secret ?? TEST_GITHUB_WEBHOOK_SECRET)
    .update(body)
    .digest("hex");
  return fetch(`${site}/github/webhook`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": event,
      "x-github-delivery": options.id ?? randomUUID(),
      "x-github-hook-installation-target-type": "integration",
      "x-github-hook-installation-target-id": options.appId ?? TEST_GITHUB_APP_ID,
      "x-hub-signature-256": `sha256=${signature}`,
    },
    body,
  });
}

const installation = {
  id: 4242,
  account: { id: 9, login: "acme", type: "Organization" },
  repository_selection: "selected",
  permissions: { metadata: "read" },
  events: [],
  suspended_at: null,
};

describe("POST /github/webhook on the real router", () => {
  test("accepts a signed delivery, and its redelivery, with 202", async () => {
    const id = randomUUID();
    const first = await post("installation", { action: "deleted", installation }, { id });
    expect(first.status).toBe(202);
    const again = await post("installation", { action: "deleted", installation }, { id });
    expect(again.status).toBe(202);
    expect((await post("ping", { zen: "Keep it logically awesome." })).status).toBe(202);
  });

  test("refuses a bad signature and another App's delivery with 401", async () => {
    expect((await post("ping", {}, { secret: "wrong" })).status).toBe(401);
    expect((await post("ping", {}, { appId: "999" })).status).toBe(401);
  });

  test("the browser routes answer pages", async () => {
    const response = await fetch(`${site}/github/oauth/callback?code=x&state=junk`);
    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(await (await fetch(`${site}/github/setup?installation_id=1`)).text()).toContain(
      "Open Volli",
    );
  });
});
