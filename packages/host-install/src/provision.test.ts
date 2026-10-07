import { describe, expect, it } from "vite-plus/test";

import type { StepId } from "./failures";
import {
  advance,
  answer,
  initialProvisionState,
  nextStep,
  retry,
  type HostProvider,
  type ProvisionRequest,
} from "./provision";
import { recordingLogger } from "./testing/fake-process";

const REQUEST: ProvisionRequest = {
  host: "sprite-1",
  appVersion: "1.1.0",
  device: { publicKey: "SPKI", fingerprint: "SHA256:mac", name: "Mac" },
  pinnedHostId: null,
};

const ENROLLED = {
  v: 1,
  ok: true,
  hostId: "0f6a3a8e-2b1c-4d5e-8f90-1a2b3c4d5e6f",
  deviceId: "1f6a3a8e-2b1c-4d5e-8f90-1a2b3c4d5e6f",
  fingerprint: "SHA256:mac",
  created: true,
  version: "1.1.0",
  listen: null,
} as const;

/**
 * A provider with no shell at all: it delivers an image and links over its
 * own route, as a bring-your-own-account provider would. The engine runs it
 * exactly as it runs SSH.
 */
function imageProvider(failAt: StepId | null = null) {
  const ran: StepId[] = [];
  const provider: HostProvider = {
    id: "image",
    async run(step, { state, secrets, logger }) {
      ran.push(step);
      expect(secrets).toEqual({ sudoPassword: null });
      logger.debug("toy step", { step });
      if (step === failAt) {
        return {
          kind: "failed",
          failure: { code: "tunnel-failed", step: "link", detail: "no route" },
        };
      }
      if (step === "probe" && state.decisions.existing === undefined) {
        return {
          kind: "question",
          question: {
            kind: "existing-hostd",
            step: "probe",
            version: "1.0.0",
            mode: "user",
            adoptable: true,
          },
        };
      }
      if (step === "deliver") return { result: { image: "registry/volli-hostd:1.1.0" } };
      if (step === "enroll") return { result: ENROLLED };
      if (step === "link") return { result: { url: "wss://sprite-1.example/host" } };
      return { result: { ok: true }, decisions: { ...state.decisions, repin: true } };
    },
  };
  return { provider, ran };
}

describe("the provider-neutral step machine", () => {
  it("runs any provider through the same steps, questions and log", async () => {
    const { provider, ran } = imageProvider();
    const log = recordingLogger();
    const steps: StepId[] = [];
    const options = { logger: log.logger, onStep: (step: StepId) => steps.push(step) };
    const asked = await advance(initialProvisionState(REQUEST), provider, options);
    expect(asked.stop).toMatchObject({ kind: "question", question: { kind: "existing-hostd" } });
    expect(await advance(asked, provider, options)).toBe(asked);
    const done = await advance(answer(asked, { kind: "update" }), provider, options);
    expect(done.status).toBe("done");
    expect(done.results.deliver).toEqual({ image: "registry/volli-hostd:1.1.0" });
    expect(done.results.link).toEqual({ url: "wss://sprite-1.example/host" });
    expect(done.decisions).toEqual({ existing: "update", repin: true });
    expect(ran).toEqual([
      "connect",
      "probe",
      "probe",
      "deliver",
      "install",
      "start",
      "enroll",
      "link",
    ]);
    expect(steps).toEqual(ran);
    expect(
      log.lines.every(
        (line) =>
          line.fields["component"] === "host-install" &&
          line.fields["provider"] === "image" &&
          line.fields["host"] === "sprite-1",
      ),
    ).toBe(true);
    expect(log.lines.at(-1)?.msg).toBe("host added");
  });

  it("stops on a failure, and retries from the step that broke", async () => {
    const { provider, ran } = imageProvider("link");
    const options = { logger: recordingLogger().logger };
    const first = answer(initialProvisionState(REQUEST), { kind: "adopt" });
    const failed = await advance(first, provider, options);
    expect(failed.stop).toMatchObject({ kind: "failed", failure: { step: "link" } });
    expect(nextStep(retry(failed))).toBe("link");
    expect(Object.keys(retry(failed, "deliver").results)).toEqual(["connect", "probe"]);
    expect(ran.filter((step) => step === "connect")).toHaveLength(1);
  });

  it("records each answer as a decision, and nothing secret", () => {
    const state = initialProvisionState(REQUEST);
    expect(answer(state, { kind: "open" }).decisions).toEqual({ alreadyPaired: true });
    expect(answer(state, { kind: "user-install" }).decisions).toEqual({ userInstall: true });
    expect(answer(state, { kind: "repair" }).decisions).toEqual({ repin: true });
    expect(answer(state, { kind: "sudo-password", password: "pw" }).decisions).toEqual({});
    const asked = {
      ...state,
      status: "stopped" as const,
      stop: {
        kind: "question" as const,
        question: { kind: "self-add" as const, step: "probe" as const },
      },
    };
    expect(answer(asked, { kind: "open" }).decisions).toEqual({ selfAdd: true });
    const different = {
      ...asked,
      stop: {
        kind: "question" as const,
        question: { kind: "already-paired" as const, step: "probe" as const, hostId: "host" },
      },
    };
    expect(answer(different, { kind: "open" }).decisions).toEqual({ alreadyPaired: true });
  });
});

describe("retrying after the host may have changed", () => {
  const decided = {
    ...initialProvisionState(REQUEST),
    results: {
      connect: { ok: true },
      probe: {},
      deliver: {},
      install: {},
      start: {},
      enroll: ENROLLED,
    },
    decisions: {
      acceptedHostKeys: ["SHA256:box"],
      existing: "adopt",
      alreadyPaired: true,
      userInstall: true,
      repin: true,
    },
    status: "stopped",
    stop: { kind: "failed", failure: { code: "tunnel-failed", step: "link", detail: "" } },
  } as const;

  it("asks again every decision the retried steps' evidence answered, and keeps the person's intent", () => {
    expect(retry(decided).decisions).toEqual(decided.decisions);
    // Enroll runs again from either, and says the host id afresh.
    expect(retry(decided, "start").decisions).toEqual(retry(decided, "enroll").decisions);
    expect(retry(decided, "enroll").decisions).toEqual({
      acceptedHostKeys: ["SHA256:box"],
      existing: "adopt",
      alreadyPaired: true,
      userInstall: true,
    });
    expect(retry(decided, "probe").decisions).toEqual({
      acceptedHostKeys: ["SHA256:box"],
      userInstall: true,
    });
    expect(retry(decided, "connect").decisions).toEqual({ userInstall: true });
    // A decision it does not know (a newer state's) is kept.
    const newer = { ...decided, decisions: { future: true } as never };
    expect(retry(newer, "connect").decisions).toEqual({ future: true });
    // Nothing to retry: nothing dropped.
    const done = { ...decided, results: { ...decided.results, link: { url: "x" } }, stop: null };
    expect(retry(done).decisions).toEqual(decided.decisions);
  });
});

describe("a provider that throws", () => {
  it("stops with unexpected-state at that step, never rejecting", async () => {
    for (const [thrown, detail] of [
      [
        new TypeError("Cannot read properties of null (reading 'binary')"),
        "Cannot read properties of null (reading 'binary')",
      ],
      ["a string", "a string"],
    ] as const) {
      const provider: HostProvider = {
        id: "broken",
        async run(step) {
          if (step === "deliver") throw thrown;
          return { result: step === "enroll" ? ENROLLED : { ok: true } };
        },
      };
      const log = recordingLogger();
      const stopped = await advance(initialProvisionState(REQUEST), provider, {
        logger: log.logger,
      });
      expect(stopped.stop).toEqual({
        kind: "failed",
        failure: { code: "unexpected-state", step: "deliver", detail },
      });
      expect(log.lines.at(-1)).toMatchObject({ level: "warn", msg: "step failed" });
    }
  });
});
