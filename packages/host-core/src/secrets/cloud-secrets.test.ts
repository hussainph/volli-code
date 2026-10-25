import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { RunnerSecretSet } from "@volli/shared/cloud";
import {
  CLOUD_SECRETS_MAX_AGE_MS,
  CloudSecretsError,
  type CloudSecretSource,
} from "./cloud-secrets";
import { SecretStore } from "./index";
import { SecretService } from "./service";

const SESSION = "00000000-0000-4000-8000-0000000000c1";
const TEAM_VALUE = "team-secret-value-4f2a9c0e7b1d";

const dirs: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function teamSet(overrides: Partial<RunnerSecretSet> = {}): RunnerSecretSet {
  return {
    version: 1,
    claim: { kind: "session", sessionId: SESSION as never },
    purpose: "session",
    withheld: null,
    entries: [
      { name: "NODE_ENV", kind: "env", value: "development" },
      { name: "STRIPE_KEY", kind: "secret", value: TEAM_VALUE },
    ],
    ...overrides,
  };
}

/** The body as it arrives off the wire: JSON, not the object the backend built. */
function overTheWire(set: unknown): unknown {
  return JSON.parse(JSON.stringify(set));
}

function setup(fetch: CloudSecretSource["fetch"]) {
  const dir = mkdtempSync(join(process.cwd(), ".cloud-secrets-test-"));
  dirs.push(dir);
  const store = new SecretStore(join(dir, "session-secrets.enc"), {
    isEncryptionAvailable: () => false,
    encryptString: () => {
      throw new Error("unused");
    },
    decryptString: () => {
      throw new Error("unused");
    },
  });
  const source = { fetch: vi.fn(fetch) };
  const service = new SecretService(store, { cloud: source });
  const port = service.port({
    sessionId: SESSION,
    projectId: "p",
    sessionLabel: "Session",
    projectLabel: "Project",
  });
  return { service, store, port, source };
}

describe("Volli Cloud team secrets on the runner", () => {
  it("injects the Session's set under stored values, redacts it first, and fetches once", async () => {
    const { service, store, port, source } = setup(async () => overTheWire(teamSet()));
    store.put({ name: "NODE_ENV", value: "local-choice", scope: "session", sessionId: SESSION });
    expect(port.hasValues()).toBe(true);
    const env = await service.environmentAsync(SESSION);
    expect(env).toEqual({ NODE_ENV: "local-choice", STRIPE_KEY: TEAM_VALUE });
    expect(source.fetch).toHaveBeenCalledWith({ sessionId: SESSION, purpose: "session" });
    // Every delivered value is in the redaction set, tool results and spills alike.
    expect(port.redact(`curl -H "Authorization: ${TEAM_VALUE}"`)).toBe(
      'curl -H "Authorization: ‹secret:STRIPE_KEY›"',
    );
    const step = port.redactStreamStep(new TextEncoder().encode(`key=${TEAM_VALUE}\n`), 0, true);
    expect(new TextDecoder().decode(step.bytes)).toBe("key=‹secret:STRIPE_KEY›\n");
    await Promise.all([service.environmentAsync(SESSION), service.environmentAsync(SESSION)]);
    expect(source.fetch).toHaveBeenCalledTimes(1);
  });

  it("redacts sealed secrets only: an env var's plain value stays readable", async () => {
    const { service, port } = setup(async () => overTheWire(teamSet()));
    await service.environmentAsync(SESSION);
    expect(port.redact("NODE_ENV is development")).toBe("NODE_ENV is development");
  });

  it("asks again once the held set is older than its max age", async () => {
    vi.useFakeTimers();
    const { service, source } = setup(async () => overTheWire(teamSet()));
    await service.environmentAsync(SESSION);
    vi.advanceTimersByTime(CLOUD_SECRETS_MAX_AGE_MS - 1);
    await service.environmentAsync(SESSION);
    expect(source.fetch).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    await service.environmentAsync(SESSION);
    expect(source.fetch).toHaveBeenCalledTimes(2);
  });

  it("fetches again after the Session's secrets end, and keeps redacting the old value", async () => {
    let value = TEAM_VALUE;
    const { service, port, source } = setup(async () =>
      overTheWire(teamSet({ entries: [{ name: "STRIPE_KEY", kind: "secret", value }] })),
    );
    await service.environmentAsync(SESSION);
    value = "rotated-team-secret-value";
    await service.endSession(SESSION);
    service.port({ sessionId: SESSION, projectId: "p", sessionLabel: "S", projectLabel: "P" });
    expect(await service.environmentAsync(SESSION)).toEqual({ STRIPE_KEY: value });
    expect(source.fetch).toHaveBeenCalledTimes(2);
    expect(port.redact(`${TEAM_VALUE} ${value}`)).toBe("‹secret:STRIPE_KEY› ‹secret:STRIPE_KEY›");
  });

  it("asks nothing for a Session that may not receive stored secrets", async () => {
    const { service, source } = setup(async () => overTheWire(teamSet()));
    const other = "00000000-0000-4000-8000-0000000000c2";
    service.port(
      { sessionId: other, projectId: "p", sessionLabel: "Sub", projectLabel: "P" },
      undefined,
      false,
    );
    expect(await service.environmentAsync(other)).toEqual({});
    expect(source.fetch).not.toHaveBeenCalled();
  });

  it("a withheld set injects nothing", async () => {
    const { service } = setup(async () =>
      overTheWire(teamSet({ withheld: "runner_opt_out", entries: [] })),
    );
    expect(await service.environmentAsync(SESSION)).toEqual({});
  });

  it("a failed fetch fails the command and the next one asks again", async () => {
    let fail = true;
    const { service, source } = setup(async () => {
      if (fail) throw new Error("not_claimed");
      return overTheWire(teamSet());
    });
    await expect(service.environmentAsync(SESSION)).rejects.toThrow("not_claimed");
    fail = false;
    await expect(service.environmentAsync(SESSION)).resolves.toMatchObject({
      STRIPE_KEY: TEAM_VALUE,
    });
    expect(source.fetch).toHaveBeenCalledTimes(2);
  });

  it.each<[string, unknown]>([
    ["a malformed body", { version: 2 }],
    [
      "a control name",
      teamSet({ entries: [{ name: "LD_PRELOAD", kind: "env", value: TEAM_VALUE }] }),
    ],
    ["another Session's set", teamSet({ claim: { kind: "session", sessionId: "x" as never } })],
    ["a job's set", teamSet({ claim: { kind: "job", jobId: SESSION as never } })],
    ["a setup set", teamSet({ purpose: "setup" })],
  ])("refuses %s whole, without echoing a value", async (_label, body) => {
    const { service, port } = setup(async () => overTheWire(body));
    const error = await service.environmentAsync(SESSION).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CloudSecretsError);
    expect(String(error)).not.toContain(TEAM_VALUE);
    // Nothing from a refused set was adopted: it was never handed out.
    expect(port.redact(TEAM_VALUE)).toBe(TEAM_VALUE);
  });

  it("an abandoned wait leaves the shared fetch to the others", async () => {
    const gate = Promise.withResolvers<unknown>();
    const { service, source } = setup(() => gate.promise);
    const controller = new AbortController();
    const abandoned = service.environmentAsync(SESSION, controller.signal);
    const waiting = service.environmentAsync(SESSION);
    controller.abort(new Error("command cancelled"));
    await expect(abandoned).rejects.toThrow("command cancelled");
    await expect(
      service.environmentAsync(SESSION, AbortSignal.abort(new Error("already"))),
    ).rejects.toThrow("already");
    gate.resolve(overTheWire(teamSet()));
    await expect(waiting).resolves.toMatchObject({ STRIPE_KEY: TEAM_VALUE });
    expect(source.fetch).toHaveBeenCalledTimes(1);
  });
});
