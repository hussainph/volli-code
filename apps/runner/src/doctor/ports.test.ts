import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import type { RunnerId } from "@volli/shared/cloud";

import { fileRunnerLinkStore } from "../link/file-store";
import {
  LIVE_DOCTOR_PORTS,
  liveFreeBytes,
  liveReadLink,
  liveReach,
  liveRun,
  piAgentDir,
  reachWith,
  readStoredCredentials,
} from "./ports";

const RUNNER_ID = "11111111-1111-4111-8111-111111111111" as RunnerId;
const DEPLOYMENT = { url: "https://a.convex.cloud", siteUrl: "https://a.convex.site" };

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "runner-doctor-ports-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** A loopback server on a free port, answering every request with 200 and a body. */
async function serve(): Promise<{ url: string; server: Server }> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("ok");
  });
  await new Promise<void>((listening) => server.listen(0, "127.0.0.1", listening));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  return { url: `http://127.0.0.1:${address.port}/`, server };
}

function close(server: Server): Promise<void> {
  return new Promise((closed) => server.close(() => closed()));
}

const failing =
  (error: unknown): typeof globalThis.fetch =>
  async () => {
    throw error;
  };

describe("running a program on the box", () => {
  it("reports the exit status and stdout, and never stderr", () => {
    expect(
      liveRun(process.execPath, [
        "-e",
        "process.stdout.write('git version 2.43.0\\n')\nprocess.stderr.write('a secret')",
      ]),
    ).toEqual({
      status: 0,
      stdout: "git version 2.43.0\n",
    });
  });

  it("reports a program that fails", () => {
    expect(liveRun(process.execPath, ["-e", "process.exit(3)"])).toEqual({ status: 3, stdout: "" });
  });

  it("reports a program that is not installed as a failure, with no output", () => {
    expect(liveRun("volli-does-not-exist-please", ["--version"])).toEqual({
      status: 1,
      stdout: "",
    });
  });
});

describe("reaching a host", () => {
  it("counts any HTTP answer as reachable, and reads the Date the host sent", async () => {
    const { url, server } = await serve();
    try {
      const answered = await liveReach(url);
      expect(answered.reachable).toBe(true);
      if (!answered.reachable) throw new Error("expected an answer");
      expect(answered.status).toBe(200);
      expect(typeof answered.date).toBe("number");
      expect(Math.abs((answered.date ?? 0) - Date.now())).toBeLessThan(60_000);
    } finally {
      await close(server);
    }
  });

  it("reports an empty answer, and a host whose body cannot be cancelled", async () => {
    const empty = createServer((_request, response) => {
      response.writeHead(204);
      response.end();
    });
    await new Promise<void>((listening) => empty.listen(0, "127.0.0.1", listening));
    const address = empty.address();
    try {
      if (address === null || typeof address === "string") throw new Error("no port");
      const answered = await reachWith(
        globalThis.fetch,
        `http://127.0.0.1:${address.port}/`,
        5_000,
      );
      expect(answered).toMatchObject({ reachable: true, status: 204 });
    } finally {
      await close(empty);
    }
    // A body that already errored rejects on cancel, and a response with no
    // Date header has no clock reading: neither changes that a host answered.
    const errored = new ReadableStream({
      start(controller) {
        controller.error(new Error("gone"));
      },
    });
    const answeredBody = (async () =>
      new Response(errored, { status: 200 })) as unknown as typeof globalThis.fetch;
    const answered = await reachWith(answeredBody, "http://example.test/", 5_000);
    expect(answered).toEqual({ reachable: true, status: 200, date: null });
  });

  it("reports a refused connection by its code, never the message", async () => {
    const { url, server } = await serve();
    await close(server);
    const refused = await reachWith(globalThis.fetch, url, 5_000);
    expect(refused.reachable).toBe(false);
    if (refused.reachable) throw new Error("expected no answer");
    expect(refused.reason).toBe("ECONNREFUSED");
  });

  it("reduces every transport failure to a code", async () => {
    expect(
      await reachWith(failing({ cause: { code: "ENOTFOUND" } }), "https://x.test", 10),
    ).toEqual({ reachable: false, reason: "ENOTFOUND" });
    expect(await reachWith(failing({ name: "TimeoutError" }), "https://x.test", 10)).toEqual({
      reachable: false,
      reason: "timed out",
    });
    expect(await reachWith(failing({ cause: { code: 7 }, name: "TimeoutError" }), "u", 10)).toEqual(
      {
        reachable: false,
        reason: "timed out",
      },
    );
    expect(await reachWith(failing({ cause: "a proxy said no" }), "https://x.test", 10)).toEqual({
      reachable: false,
      reason: "no answer",
    });
    expect(await reachWith(failing({ cause: null }), "https://x.test", 10)).toEqual({
      reachable: false,
      reason: "no answer",
    });
    expect(await reachWith(failing("a string"), "https://x.test", 10)).toEqual({
      reachable: false,
      reason: "no answer",
    });
    expect(await reachWith(failing(null), "https://x.test", 10)).toEqual({
      reachable: false,
      reason: "no answer",
    });
  });
});

describe("measuring the disk", () => {
  it("reports the free bytes on the filesystem holding a path", () => {
    const free = liveFreeBytes(root);
    expect(free).not.toBeNull();
    expect(free ?? 0).toBeGreaterThan(0);
  });

  it("reports a path it cannot measure as null rather than guessing", () => {
    expect(liveFreeBytes(join(root, "absent", "deeper"))).toBeNull();
  });
});

describe("where this runner keeps Pi's profile", () => {
  it("uses <dataDir>/pi unless the environment names a directory", () => {
    expect(piAgentDir({}, "/var/lib/volli-runner")).toBe(join("/var/lib/volli-runner", "pi"));
    expect(piAgentDir({ PI_CODING_AGENT_DIR: "" }, "/var/lib/volli-runner")).toBe(
      join("/var/lib/volli-runner", "pi"),
    );
    expect(piAgentDir({ PI_CODING_AGENT_DIR: "/srv/pi" }, "/var/lib/volli-runner")).toBe("/srv/pi");
  });

  it("expands a leading ~ against HOME, and leaves it alone when there is none", () => {
    expect(
      piAgentDir({ PI_CODING_AGENT_DIR: "~/pi", HOME: "/home/volli" }, "/var/lib/volli-runner"),
    ).toBe(join("/home/volli", "pi"));
    expect(piAgentDir({ PI_CODING_AGENT_DIR: "~", HOME: "/home/volli" }, "/data")).toBe(
      "/home/volli",
    );
    expect(piAgentDir({ PI_CODING_AGENT_DIR: "~/pi" }, "/data")).toBe("~/pi");
    expect(piAgentDir({ PI_CODING_AGENT_DIR: "/custom", HOME: "/home/volli" }, "/data")).toBe(
      "/custom",
    );
  });
});

describe("listing what the box is signed in to", () => {
  const agent = (): string => {
    const dir = join(root, "agent");
    mkdirSync(dir, { recursive: true });
    return dir;
  };
  const stored = (text: string): void => {
    writeFileSync(join(agent(), "auth.json"), text);
  };

  it("reports a box with no store as signed in to nothing", async () => {
    expect(await readStoredCredentials(join(root, "absent"))).toEqual({
      state: "listed",
      providers: [],
    });
  });

  it("reports each provider's id and kind, and never the credential itself", async () => {
    stored(
      JSON.stringify({
        openai: { type: "api_key", key: "sk-SECRET-VALUE" },
        anthropic: { type: "oauth", access: "SECRET-TOKEN", refresh: "SECRET-REFRESH" },
      }),
    );
    const listing = await readStoredCredentials(agent());
    expect(listing).toEqual({
      state: "listed",
      providers: [
        { providerId: "anthropic", kind: "subscription" },
        { providerId: "openai", kind: "api-key" },
      ],
    });
    expect(JSON.stringify(listing)).not.toContain("SECRET");
  });

  it("reports newer or malformed credential shapes as unreadable, never as absent", async () => {
    for (const value of [{ type: "passkey" }, 5, null, []]) {
      stored(JSON.stringify({ provider: value }));
      expect(await readStoredCredentials(agent())).toEqual({ state: "unreadable" });
    }
    stored("{}");
    expect(await readStoredCredentials(agent())).toEqual({ state: "listed", providers: [] });
  });

  it("reports a store it cannot parse as unreadable, without quoting it", async () => {
    stored('{"anthropic": {"type": "api_key", "key": "sk-SECRET-VALUE"');
    const listing = await readStoredCredentials(agent());
    expect(listing).toEqual({ state: "unreadable" });
    expect(JSON.stringify(listing)).not.toContain("SECRET");
  });

  it("reports a document that is not a provider map as unreadable", async () => {
    stored("null");
    expect(await readStoredCredentials(agent())).toEqual({ state: "unreadable" });
    stored("5");
    expect(await readStoredCredentials(agent())).toEqual({ state: "unreadable" });
    stored("[]");
    expect(await readStoredCredentials(agent())).toEqual({ state: "unreadable" });
  });

  it("reports a store it cannot open as unreadable", async () => {
    mkdirSync(join(agent(), "auth.json"), { recursive: true });
    expect(await readStoredCredentials(agent())).toEqual({ state: "unreadable" });
  });
});

describe("reading the link on disk", () => {
  it("reports an unlinked box", async () => {
    expect(await liveReadLink(join(root, "config"))).toEqual({ state: "unlinked" });
  });

  it("reports the link and the deployment it was made against", async () => {
    const configDir = join(root, "config");
    await fileRunnerLinkStore({ configDir, deployment: DEPLOYMENT }).save({
      runnerId: RUNNER_ID,
      name: "hetzner-1",
      credential: "vrc_secret",
      generation: 1,
    });
    expect(await liveReadLink(configDir)).toEqual({
      state: "linked",
      name: "hetzner-1",
      runnerId: RUNNER_ID,
      deployment: DEPLOYMENT,
    });
  });

  it("reports a link file this build cannot open, by name", async () => {
    const configDir = join(root, "config");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "credential"), "not a sealed link");
    const link = await liveReadLink(configDir);
    expect(link.state).toBe("unreadable");
    if (link.state !== "unreadable") throw new Error("expected unreadable");
    expect(link.error).toContain(join(configDir, "credential"));
  });
});

it("gives the checks the live box", () => {
  expect(Object.keys(LIVE_DOCTOR_PORTS).toSorted()).toEqual([
    "configureProxy",
    "exists",
    "freeBytes",
    "reach",
    "readLink",
    "run",
    "storedCredentials",
  ]);
});
