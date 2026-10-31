import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import type { RunnerLink } from "@volli/host-core/cloud-runner";
import { fileSecretKey } from "@volli/host-core/secrets";
import type { RunnerId } from "@volli/shared/cloud";

import {
  fileRunnerLinkStore,
  LINK_FILE_NAME,
  LINK_KEY_FILE_NAME,
  StaleRunnerLinkError,
  UnreadableRunnerLinkError,
} from "./file-store";

const DEPLOYMENT = { url: "https://a.convex.cloud", siteUrl: "https://a.convex.site" };
const RUNNER_ID = "11111111-1111-4111-8111-111111111111" as RunnerId;
const OTHER_ID = "22222222-2222-4222-8222-222222222222" as RunnerId;

let configDir: string;

beforeEach(() => {
  configDir = join(mkdtempSync(join(tmpdir(), "runner-link-")), "config");
});

afterEach(() => {
  rmSync(join(configDir, ".."), { recursive: true, force: true });
});

function link(generation: number, runnerId = RUNNER_ID): RunnerLink {
  return { runnerId, name: "hetzner-1", credential: `vrc_secret_${generation}`, generation };
}

describe("the sealed runner link", () => {
  it("is absent on a box never linked", async () => {
    const store = fileRunnerLinkStore({ configDir });
    expect(await store.load()).toBeNull();
    expect(await store.read()).toBeNull();
  });

  it("round-trips sealed, 0600 in a 0700 directory, with no credential in the clear", async () => {
    const store = fileRunnerLinkStore({ configDir, deployment: DEPLOYMENT });
    await store.save(link(1));
    expect(await store.load()).toEqual(link(1));
    expect(await fileRunnerLinkStore({ configDir }).read()).toEqual({
      link: link(1),
      deployment: DEPLOYMENT,
    });
    const file = join(configDir, LINK_FILE_NAME);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(join(configDir, LINK_KEY_FILE_NAME)).mode & 0o777).toBe(0o600);
    expect(statSync(configDir).mode & 0o777).toBe(0o700);
    expect(readFileSync(file).includes("vrc_secret_1")).toBe(false);
    expect(readdirSync(configDir).toSorted()).toEqual([LINK_FILE_NAME, LINK_KEY_FILE_NAME]);
  });

  it("takes a newer generation and keeps the deployment it was linked to", async () => {
    await fileRunnerLinkStore({ configDir, deployment: DEPLOYMENT }).save(link(1));
    // The token source's store knows no deployment: rotation keeps the stored one.
    const rotating = fileRunnerLinkStore({ configDir });
    await rotating.save(link(2));
    expect(await rotating.read()).toEqual({ link: link(2), deployment: DEPLOYMENT });
  });

  it("refuses a generation that is not newer, so a stale writer cannot roll back", async () => {
    const store = fileRunnerLinkStore({ configDir, deployment: DEPLOYMENT });
    await store.save(link(3));
    await expect(store.save(link(3))).rejects.toBeInstanceOf(StaleRunnerLinkError);
    await expect(store.save(link(2))).rejects.toThrow("generation 3; 2 is not newer");
    expect(await store.load()).toEqual(link(3));
  });

  it("never replaces another runner's link, and a new one needs a deployment", async () => {
    await expect(fileRunnerLinkStore({ configDir }).save(link(1))).rejects.toThrow(
      "needs the deployment",
    );
    await fileRunnerLinkStore({ configDir, deployment: DEPLOYMENT }).save(link(5));
    const other = { url: "https://b.convex.cloud", siteUrl: "https://b.convex.site" };
    await expect(
      fileRunnerLinkStore({ configDir, deployment: other }).save(link(1, OTHER_ID)),
    ).rejects.toThrow("already linked as hetzner-1");
    await fileRunnerLinkStore({ configDir }).clear();
    await fileRunnerLinkStore({ configDir, deployment: other }).save(link(1, OTHER_ID));
    expect(await fileRunnerLinkStore({ configDir }).read()).toEqual({
      link: link(1, OTHER_ID),
      deployment: other,
    });
  });

  it("clears, and clearing nothing, even with no config dir, is harmless", async () => {
    const store = fileRunnerLinkStore({ configDir, deployment: DEPLOYMENT });
    await store.clear();
    await store.save(link(1));
    await store.clear();
    expect(await store.load()).toBeNull();
  });

  describe("a file it cannot read is an error, never 'not linked'", () => {
    async function sealedWith(text: string): Promise<void> {
      await fileRunnerLinkStore({ configDir, deployment: DEPLOYMENT }).save(link(1));
      const key = fileSecretKey({ path: join(configDir, LINK_KEY_FILE_NAME) });
      writeFileSync(join(configDir, LINK_FILE_NAME), key.encryptString(text));
    }

    it("when its key is gone", async () => {
      await fileRunnerLinkStore({ configDir, deployment: DEPLOYMENT }).save(link(1));
      rmSync(join(configDir, LINK_KEY_FILE_NAME));
      await expect(fileRunnerLinkStore({ configDir }).load()).rejects.toThrow(
        `could not be opened with its key ${join(configDir, LINK_KEY_FILE_NAME)} (missing).`,
      );
    });

    it("when it is damaged", async () => {
      await fileRunnerLinkStore({ configDir, deployment: DEPLOYMENT }).save(link(1));
      writeFileSync(join(configDir, LINK_FILE_NAME), "garbage");
      await expect(fileRunnerLinkStore({ configDir }).load()).rejects.toThrow(
        "could not be opened: it is damaged.",
      );
    });

    it("when it is not a file", async () => {
      const store = fileRunnerLinkStore({ configDir, deployment: DEPLOYMENT });
      await store.save(link(1));
      rmSync(join(configDir, LINK_FILE_NAME));
      mkdirSync(join(configDir, LINK_FILE_NAME));
      await expect(store.read()).rejects.toThrow("could not be read");
    });

    it.each([
      ["not JSON", "{", "it is not JSON"],
      ["not an object", "null", "it is not an object"],
      ["a newer format", JSON.stringify({ v: 2 }), "a newer volli-runner wrote it (format 2)"],
      ["malformed", JSON.stringify({ v: 1, runnerId: "nope" }), "a field is missing"],
      [
        "no deployment",
        JSON.stringify({ v: 1, runnerId: RUNNER_ID, name: "n", credential: "c", generation: 1 }),
        "a field is missing",
      ],
      [
        "an empty credential",
        JSON.stringify({
          v: 1,
          runnerId: RUNNER_ID,
          name: "n",
          credential: "",
          generation: 1,
          deployment: DEPLOYMENT,
        }),
        "a field is missing",
      ],
    ])("when it is %s", async (_label, text, why) => {
      await sealedWith(text);
      const error = await fileRunnerLinkStore({ configDir })
        .load()
        .then(
          () => null,
          (thrown: unknown) => thrown,
        );
      expect(error).toBeInstanceOf(UnreadableRunnerLinkError);
      expect((error as Error).message).toContain(why);
    });
  });
});
