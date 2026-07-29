import { describe, expect, it } from "vite-plus/test";

import { parseHarnessId, type HarnessId } from "../ticket";
import {
  bindsStartupEvent,
  harnessCommandOwner,
  harnessTier,
  isBareHarnessCommand,
  shadowsSystemCommand,
  supportedEvents,
  type HarnessAdapter,
} from "./types";

/** A minimal Declared-tier adapter — nothing injected, nothing reported, no resume. */
function bareAdapter(overrides: Partial<HarnessAdapter> = {}): HarnessAdapter {
  return {
    id: parseHarnessId("my-harness") as HarnessId,
    label: "My Harness",
    command: "my-harness",
    promptFlag: null,
    surfaces: { skillsDir: null, commandsDir: null, instructionsFile: null },
    injection: { kind: "none" },
    sessionId: { kind: "none" },
    resume: { byId: null, latest: null, userResumeTokens: [] },
    events: [],
    startupEvent: null,
    launchSettings: [],
    sessionMarkers: [],
    ...overrides,
  };
}

describe("supportedEvents", () => {
  it("reports the canonical events, never the native names they arrived under", () => {
    const adapter = bareAdapter({
      events: [
        { event: "turn.completed", native: "Stop", delivery: "async" },
        { event: "input.needed", native: "Notification", delivery: "async" },
      ],
    });
    expect([...supportedEvents(adapter)]).toEqual(["turn.completed", "input.needed"]);
  });

  it("counts an event once however many native signals deliver it", () => {
    const adapter = bareAdapter({
      events: [
        {
          event: "input.needed",
          native: "hooks:PermissionRequest",
          delivery: "async",
        },
        { event: "input.needed", native: "notify:blocked", delivery: "async" },
      ],
    });
    expect(supportedEvents(adapter).size).toBe(1);
    expect(supportedEvents(adapter).has("input.needed")).toBe(true);
  });

  it("is empty for a harness that reports nothing", () => {
    expect(supportedEvents(bareAdapter()).size).toBe(0);
  });
});

describe("bindsStartupEvent", () => {
  const sessionStart = [
    { event: "session.started", native: "SessionStart", delivery: "async" },
  ] as const;

  it("accepts a harness that declares no startup signal at all", () => {
    expect(bindsStartupEvent(bareAdapter({ events: sessionStart }))).toBe(true);
    expect(bindsStartupEvent(bareAdapter())).toBe(true);
  });

  it("accepts a startup event the adapter also binds", () => {
    expect(
      bindsStartupEvent(bareAdapter({ events: sessionStart, startupEvent: "session.started" })),
    ).toBe(true);
  });

  // The lie the field exists to remove: a claim that the channel speaks at
  // launch, with nothing rendered that could ever speak.
  it("refuses a startup event nothing binds", () => {
    expect(bindsStartupEvent(bareAdapter({ startupEvent: "session.started" }))).toBe(false);
    expect(
      bindsStartupEvent(bareAdapter({ events: sessionStart, startupEvent: "turn.completed" })),
    ).toBe(false);
  });
});

describe("harnessTier", () => {
  const oneEvent = [{ event: "turn.completed", native: "Stop", delivery: "async" }] as const;

  it("is hooked only when a harness can both be configured and report", () => {
    expect(
      harnessTier(
        bareAdapter({
          injection: { kind: "claude-settings-json", flag: "--settings" },
          events: oneEvent,
        }),
      ),
    ).toBe("hooked");
  });

  it("is not hooked when a harness declares events it has no way to be told about", () => {
    expect(harnessTier(bareAdapter({ events: oneEvent }))).toBe("declared");
  });

  it("is not hooked when a configurable harness reports nothing", () => {
    expect(
      harnessTier(bareAdapter({ injection: { kind: "claude-settings-json", flag: "--settings" } })),
    ).toBe("declared");
  });

  it("falls back to known when an unhooked harness can still resume", () => {
    expect(
      harnessTier(
        bareAdapter({ resume: { byId: ["--resume", "{id}"], latest: null, userResumeTokens: [] } }),
      ),
    ).toBe("known");
    expect(
      harnessTier(
        bareAdapter({ resume: { byId: null, latest: ["--continue"], userResumeTokens: [] } }),
      ),
    ).toBe("known");
  });

  it("is declared when a harness offers neither configuration nor resume", () => {
    expect(harnessTier(bareAdapter())).toBe("declared");
  });

  // `[]` is truthy, so the array itself is not the evidence: a harness promoted
  // to Known on an empty resume argv resumes by running the bare executable,
  // which starts a fresh session while every surface says "resume".
  it("is declared when the resume argv is present but empty", () => {
    expect(
      harnessTier(bareAdapter({ resume: { byId: [], latest: [], userResumeTokens: [] } })),
    ).toBe("declared");
    expect(
      harnessTier(
        bareAdapter({ resume: { byId: [], latest: ["--continue"], userResumeTokens: [] } }),
      ),
    ).toBe("known");
  });
});

describe("harnessCommandOwner", () => {
  it("names Volli's own launcher, whatever case a manifest spells it in", () => {
    expect(harnessCommandOwner("volli")).toBe("volli-cli");
    expect(harnessCommandOwner("volli.cjs")).toBe("volli-cli");
    // APFS is case-insensitive by default, so on the only OS we ship this is
    // the same file as `volli` — a case-sensitive check hands it away.
    expect(harnessCommandOwner("Volli")).toBe("volli-cli");
    expect(harnessCommandOwner("VOLLI.CJS")).toBe("volli-cli");
  });

  it("names the built-in a command already belongs to", () => {
    expect(harnessCommandOwner("claude")).toBe("claude-code");
    expect(harnessCommandOwner("codex")).toBe("codex");
    expect(harnessCommandOwner("cursor-agent")).toBe("cursor");
    expect(harnessCommandOwner("Cursor-Agent")).toBe("cursor");
    expect(harnessCommandOwner("opencode")).toBe("opencode");
  });

  it("leaves an unclaimed name free", () => {
    expect(harnessCommandOwner("my-harness")).toBeNull();
    expect(harnessCommandOwner("claudia")).toBeNull();
  });
});

describe("isBareHarnessCommand", () => {
  it("refuses the launcher's name in any case, and anything a shell would read", () => {
    expect(isBareHarnessCommand("volli")).toBe(false);
    expect(isBareHarnessCommand("Volli")).toBe(false);
    expect(isBareHarnessCommand("/usr/local/bin/harness")).toBe(false);
    expect(isBareHarnessCommand("my harness")).toBe(false);
  });

  // Ownership is a separate question: a built-in has to pass this to get its
  // own wrapper written at all, and `harnessCommandOwner` is what stops a
  // stranger claiming the same name.
  it("still accepts a built-in's own command", () => {
    expect(isBareHarnessCommand("claude")).toBe(true);
    expect(isBareHarnessCommand("my-harness")).toBe(true);
  });
});

describe("shadowsSystemCommand", () => {
  it("refuses the system directories a wrapper must never sit in front of", () => {
    expect(shadowsSystemCommand("/usr/bin/git")).toBe(true);
    expect(shadowsSystemCommand("/bin/ls")).toBe(true);
    expect(shadowsSystemCommand("/sbin/ping")).toBe(true);
    expect(shadowsSystemCommand("/usr/sbin/cron")).toBe(true);
    expect(shadowsSystemCommand("/usr/libexec/path_helper")).toBe(true);
  });

  // The ordinary case — every coding agent worth wrapping installs here.
  it("allows a command that resolves anywhere a harness actually installs", () => {
    expect(shadowsSystemCommand("/opt/homebrew/bin/claude")).toBe(false);
    expect(shadowsSystemCommand("/Users/x/.local/bin/codex")).toBe(false);
    expect(shadowsSystemCommand("/usr/local/bin/opencode")).toBe(false);
  });

  it("matches on a path segment, not a prefix, so /usr/binary is not /usr/bin", () => {
    expect(shadowsSystemCommand("/usr/binary/thing")).toBe(false);
    expect(shadowsSystemCommand("/binary/thing")).toBe(false);
  });
});
