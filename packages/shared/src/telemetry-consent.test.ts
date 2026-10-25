import { describe, expect, it } from "vite-plus/test";

import {
  CHOICE_REGIONS,
  TELEMETRY_NOTICE_VERSION,
  resolveTelemetry,
  telemetryChoice,
  type TelemetryAccountState,
  type TelemetryChoice,
  type TelemetryInputs,
  type TelemetryResolution,
} from "./telemetry-consent";

const V = TELEMETRY_NOTICE_VERSION;

function choice(
  crash: boolean,
  usage: boolean,
  patch: Partial<TelemetryChoice> = {},
): TelemetryChoice {
  return { crash, usage, noticeVersion: V, decidedAt: 1000, regionAtDecision: "US", ...patch };
}

function account(patch: Partial<TelemetryAccountState> = {}): TelemetryAccountState {
  return { choice: null, linked: true, ...patch };
}

/** A packaged build in a notice region, notice shown, signed out, no choice. */
function inputs(patch: Partial<TelemetryInputs> = {}): TelemetryInputs {
  return {
    packaged: true,
    env: {},
    osRegion: "US",
    local: null,
    account: null,
    noticeShownVersion: V,
    ...patch,
  };
}

const NO_WRITES = { localWrite: null, accountWrite: null, linkAccount: false } as const;

describe("resolveTelemetry: what always wins", () => {
  const everythingOn = {
    local: choice(true, true),
    account: account({ choice: choice(true, true) }),
  } as const;

  it("sends nothing from a development build, and shows no card", () => {
    expect(resolveTelemetry(inputs({ ...everythingOn, packaged: false }))).toEqual({
      crash: false,
      usage: false,
      why: "dev-build",
      card: null,
      choice: choice(true, true),
      ...NO_WRITES,
    });
    expect(resolveTelemetry(inputs({ packaged: false, osRegion: "DE" })).card).toBeNull();
  });

  it.each(["1", "true", "TRUE", "woodpecker", " yes "])("sends nothing under CI=%j", (CI) => {
    expect(resolveTelemetry(inputs({ ...everythingOn, env: { CI } }))).toMatchObject({
      crash: false,
      usage: false,
      why: "ci",
      card: null,
    });
  });

  it.each(["", " ", "0", "false", "No", "OFF"])("does not read CI=%j as CI", (CI) => {
    expect(resolveTelemetry(inputs({ env: { CI } })).why).toBe("notice-default");
  });

  it.each([
    [{ DO_NOT_TRACK: "1" }],
    [{ DO_NOT_TRACK: " True " }],
    [{ DO_NOT_TRACK: "please" }],
    [{ VOLLI_TELEMETRY: "0" }],
    [{ VOLLI_TELEMETRY: "OFF" }],
    [{ VOLLI_TELEMETRY: "disabled" }],
    [{ VOLLI_TELEMETRY: "1", DO_NOT_TRACK: "1" }],
  ])("sends nothing under %j, even with every choice on", (env) => {
    expect(resolveTelemetry(inputs({ ...everythingOn, env }))).toMatchObject({
      crash: false,
      usage: false,
      why: "env",
      card: null,
      choice: choice(true, true),
    });
  });

  it("does not read DO_NOT_TRACK=0 or VOLLI_TELEMETRY=yes as off", () => {
    expect(resolveTelemetry(inputs({ env: { DO_NOT_TRACK: "0" } })).why).toBe("notice-default");
    expect(resolveTelemetry(inputs({ env: { VOLLI_TELEMETRY: " YES " } })).why).toBe(
      "notice-default",
    );
  });

  it("puts the build ahead of CI, and CI ahead of the environment switches", () => {
    expect(resolveTelemetry(inputs({ packaged: false, env: { CI: "1" } })).why).toBe("dev-build");
    expect(resolveTelemetry(inputs({ env: { CI: "1", DO_NOT_TRACK: "1" } })).why).toBe("ci");
  });

  it("still reconciles and reports the person's choice while off", () => {
    const resolved = resolveTelemetry(
      inputs({
        packaged: false,
        local: choice(false, true),
        account: account({ linked: false, choice: choice(true, true) }),
      }),
    );
    expect(resolved).toMatchObject({ crash: false, usage: false, linkAccount: true });
    expect(resolved.choice).toEqual(choice(false, true));
    expect(resolved.accountWrite).toEqual(choice(false, true));
  });
});

describe("resolveTelemetry: the person's choice", () => {
  it("follows this device's choice when signed out, tier by tier", () => {
    expect(resolveTelemetry(inputs({ local: choice(true, false) }))).toEqual({
      crash: true,
      usage: false,
      why: "choice",
      card: null,
      choice: choice(true, false),
      ...NO_WRITES,
    });
  });

  it("lets a choice turn telemetry on in a choice region", () => {
    expect(resolveTelemetry(inputs({ osRegion: "DE", local: choice(true, true) }))).toMatchObject({
      crash: true,
      usage: true,
      why: "choice",
      card: null,
    });
  });

  it("does not let VOLLI_TELEMETRY=1 override a choice", () => {
    expect(
      resolveTelemetry(inputs({ env: { VOLLI_TELEMETRY: "1" }, local: choice(false, false) })),
    ).toMatchObject({ crash: false, usage: false, why: "choice" });
  });

  it("counts a choice made under a newer notice as current", () => {
    expect(
      resolveTelemetry(
        inputs({ osRegion: "FR", local: choice(true, true, { noticeVersion: V + 1 }) }),
      ),
    ).toMatchObject({ crash: true, usage: true, why: "choice" });
  });
});

describe("resolveTelemetry: linking a device to an account", () => {
  it("reconciles once, the more private value winning per tier, and writes both sides", () => {
    const local = choice(false, true, { decidedAt: 2000, regionAtDecision: "GB" });
    const remote = choice(true, true, { decidedAt: 1000 });
    const merged = choice(false, true, { decidedAt: 2000, regionAtDecision: "GB" });
    expect(
      resolveTelemetry(inputs({ local, account: account({ linked: false, choice: remote }) })),
    ).toEqual({
      crash: false,
      usage: true,
      why: "choice",
      card: null,
      choice: merged,
      localWrite: null,
      accountWrite: merged,
      linkAccount: true,
    });
  });

  it("takes a tier the account turned off away from this device", () => {
    const remote = choice(true, false, { decidedAt: 3000 });
    const resolved = resolveTelemetry(
      inputs({ local: choice(true, true), account: account({ linked: false, choice: remote }) }),
    );
    expect(resolved).toMatchObject({ crash: true, usage: false, accountWrite: null });
    expect(resolved.localWrite).toEqual(remote);
  });

  it("keeps the newer notice for a merged tier both sides left on", () => {
    const resolved = resolveTelemetry(
      inputs({
        osRegion: "IE",
        local: choice(true, true, { noticeVersion: V, decidedAt: 2000 }),
        account: account({ linked: false, choice: choice(true, true, { noticeVersion: V - 1 }) }),
      }),
    );
    expect(resolved).toMatchObject({ crash: true, usage: true, why: "choice", card: null });
    expect(resolved.accountWrite?.noticeVersion).toBe(V);
  });

  it("brings an account's choice to a device with none, and this device's to an account with none", () => {
    const remote = choice(false, true);
    expect(
      resolveTelemetry(inputs({ account: account({ linked: false, choice: remote }) })),
    ).toMatchObject({ crash: false, usage: true, localWrite: remote, accountWrite: null });
    const local = choice(true, false);
    expect(resolveTelemetry(inputs({ local, account: account({ linked: false }) }))).toMatchObject({
      crash: true,
      usage: false,
      localWrite: null,
      accountWrite: local,
    });
  });

  it("links with nothing to write when neither side has chosen", () => {
    expect(resolveTelemetry(inputs({ account: account({ linked: false }) }))).toMatchObject({
      choice: null,
      localWrite: null,
      accountWrite: null,
      linkAccount: true,
    });
  });
});

describe("resolveTelemetry: a linked account is the authority", () => {
  it("follows the account over this device, and updates this device to match", () => {
    const remote = choice(true, true, { decidedAt: 5000 });
    const resolved = resolveTelemetry(
      inputs({ local: choice(false, false), account: account({ choice: remote }) }),
    );
    expect(resolved).toMatchObject({ crash: true, usage: true, why: "choice", linkAccount: false });
    expect(resolved.localWrite).toEqual(remote);
    expect(resolved.accountWrite).toBeNull();
  });

  it("lets a tier turned off come back on, once the account says so", () => {
    // The person had crash off everywhere, then turned it on in Settings,
    // which writes the new decision to the account.
    const turnedOn = telemetryChoice(
      { crash: true, usage: true },
      { decidedAt: 9000, region: "US" },
    );
    const resolved = resolveTelemetry(
      inputs({ local: turnedOn, account: account({ choice: turnedOn }) }),
    );
    expect(resolved).toMatchObject({ crash: true, usage: true, ...NO_WRITES });
  });

  it("restores this device's choice to an account that lost its own", () => {
    const local = choice(false, true);
    expect(resolveTelemetry(inputs({ local, account: account() }))).toMatchObject({
      crash: false,
      usage: true,
      accountWrite: local,
      localWrite: null,
    });
  });

  it("writes nothing when the two already agree", () => {
    expect(
      resolveTelemetry(
        inputs({ local: choice(true, false), account: account({ choice: choice(true, false) }) }),
      ),
    ).toMatchObject(NO_WRITES);
  });

  it("treats any difference in the record as a change to store", () => {
    const remote = choice(true, false);
    for (const local of [
      choice(false, false),
      choice(true, true),
      choice(true, false, { noticeVersion: V - 1 }),
      choice(true, false, { decidedAt: 1 }),
      choice(true, false, { regionAtDecision: null }),
    ]) {
      expect(
        resolveTelemetry(inputs({ local, account: account({ choice: remote }) })).localWrite,
      ).toEqual(remote);
    }
  });
});

describe("resolveTelemetry: no current choice", () => {
  it.each(CHOICE_REGIONS)("asks first in %s", (osRegion) => {
    expect(resolveTelemetry(inputs({ osRegion }))).toEqual({
      crash: false,
      usage: false,
      why: "awaiting-choice",
      card: "choice",
      choice: null,
      ...NO_WRITES,
    });
  });

  it.each([null, undefined, "", "de", "XK", "419", 49])(
    "asks first where the region is unknown (%j)",
    (osRegion) => {
      expect(resolveTelemetry(inputs({ osRegion }))).toMatchObject({
        crash: false,
        usage: false,
        why: "awaiting-choice",
        card: "choice",
      });
    },
  );

  it("narrows a lower-case or padded region code before deciding", () => {
    expect(resolveTelemetry(inputs({ osRegion: " us " })).why).toBe("notice-default");
    expect(resolveTelemetry(inputs({ osRegion: "de" })).why).toBe("awaiting-choice");
  });

  it("asks first when either the OS or the account names a choice region", () => {
    expect(
      resolveTelemetry(inputs({ osRegion: "US", account: account({ region: "CA" }) })).card,
    ).toBe("choice");
    expect(
      resolveTelemetry(inputs({ osRegion: "FR", account: account({ region: "US" }) })).card,
    ).toBe("choice");
    expect(
      resolveTelemetry(inputs({ osRegion: null, account: account({ region: "US" }) })).why,
    ).toBe("notice-default");
  });

  it("still asks in a choice region under VOLLI_TELEMETRY=1, which only skips a notice", () => {
    expect(
      resolveTelemetry(inputs({ osRegion: "GB", env: { VOLLI_TELEMETRY: "1" } })),
    ).toMatchObject({ crash: false, usage: false, card: "choice" });
  });

  it("holds both tiers until the notice has been shown, elsewhere", () => {
    expect(resolveTelemetry(inputs({ noticeShownVersion: null }))).toMatchObject({
      crash: false,
      usage: false,
      why: "awaiting-notice",
      card: "notice",
    });
    expect(resolveTelemetry(inputs({ noticeShownVersion: V - 1 })).card).toBe("notice");
  });

  it("turns both tiers on once the notice has been shown, or under VOLLI_TELEMETRY=1", () => {
    expect(resolveTelemetry(inputs())).toMatchObject({
      crash: true,
      usage: true,
      why: "notice-default",
      card: null,
    });
    expect(
      resolveTelemetry(inputs({ noticeShownVersion: null, env: { VOLLI_TELEMETRY: "true" } })),
    ).toMatchObject({ crash: true, usage: true, why: "notice-default", card: null });
  });
});

describe("resolveTelemetry: a choice made under an older notice", () => {
  const stale = (crash: boolean, usage: boolean) => choice(crash, usage, { noticeVersion: V - 1 });

  it("keeps the tiers it turned off and lets the region decide the rest", () => {
    expect(resolveTelemetry(inputs({ local: stale(false, true) }))).toMatchObject({
      crash: false,
      usage: true,
      why: "notice-default",
      card: null,
    });
  });

  it("holds every tier while a stale notice is shown again", () => {
    expect(
      resolveTelemetry(inputs({ local: stale(true, true), noticeShownVersion: V - 1 })),
    ).toMatchObject({ crash: false, usage: false, card: "notice" });
  });

  it("keeps the tiers it turned off under VOLLI_TELEMETRY=1", () => {
    expect(
      resolveTelemetry(
        inputs({
          local: stale(true, false),
          noticeShownVersion: null,
          env: { VOLLI_TELEMETRY: "1" },
        }),
      ),
    ).toMatchObject({ crash: true, usage: false, card: null });
  });

  it("asks again in a choice region, and sends nothing until answered", () => {
    expect(resolveTelemetry(inputs({ osRegion: "FR", local: stale(true, true) }))).toMatchObject({
      crash: false,
      usage: false,
      why: "awaiting-choice",
      card: "choice",
      choice: stale(true, true),
    });
  });
});

// ── The truth table ──────────────────────────────────────────────────────────

function isCurrent(c: TelemetryChoice | null): boolean {
  return c !== null && c.noticeVersion >= V;
}

/** Whether the build or environment turns telemetry off, in the truth table's inputs. */
function gated(input: TelemetryInputs): boolean {
  return !input.packaged || "CI" in input.env || "DO_NOT_TRACK" in input.env;
}

/** Whether the truth table's region asks first: everything but its one notice region. */
function asks(input: TelemetryInputs): boolean {
  return input.osRegion !== "US";
}

describe("resolveTelemetry: every combination", () => {
  const regions: unknown[] = ["DE", "US", null, "zz"];
  const tierPairs = [
    [true, true],
    [true, false],
    [false, true],
    [false, false],
  ] as const;
  const versions = [V - 1, V, V + 1];
  const choices: (TelemetryChoice | null)[] = [
    null,
    ...tierPairs.flatMap(([crash, usage]) =>
      versions.map((noticeVersion) => choice(crash, usage, { noticeVersion })),
    ),
  ];
  const accounts: (TelemetryAccountState | null)[] = [
    null,
    ...[false, true].flatMap((linked) =>
      [null, choice(true, true), choice(false, false, { noticeVersion: V - 1 })].map((c) =>
        account({ linked, choice: c }),
      ),
    ),
  ];
  const envs = [{}, { VOLLI_TELEMETRY: "1" }, { DO_NOT_TRACK: "1" }, { CI: "1" }];

  const rows: [TelemetryInputs, TelemetryResolution][] = [];
  for (const osRegion of regions)
    for (const local of choices)
      for (const acct of accounts)
        for (const noticeShownVersion of [null, V - 1, V])
          for (const env of envs)
            for (const packaged of [true, false]) {
              const input = inputs({
                osRegion,
                local,
                account: acct,
                noticeShownVersion,
                env,
                packaged,
              });
              rows.push([input, resolveTelemetry(input)]);
            }

  it("covers thousands of rows", () => {
    expect(rows.length).toBeGreaterThan(5000);
  });

  it("never sends from a gated build or environment, and never shows a card there", () => {
    for (const [, out] of rows.filter(([row]) => gated(row))) {
      expect([out.crash, out.usage, out.card]).toEqual([false, false, null]);
    }
  });

  it("never sends a tier the decision in force turned off", () => {
    for (const [, out] of rows) {
      if (out.choice?.crash === false) expect(out.crash).toBe(false);
      if (out.choice?.usage === false) expect(out.usage).toBe(false);
    }
  });

  it("sends in a choice or unknown region only on a current choice", () => {
    for (const [, out] of rows.filter(([row]) => asks(row))) {
      if (out.crash) expect(isCurrent(out.choice) && out.choice?.crash).toBe(true);
      if (out.usage) expect(isCurrent(out.choice) && out.choice?.usage).toBe(true);
    }
  });

  it("sends in a notice region without a current choice only after the notice", () => {
    for (const [input, out] of rows) {
      if (asks(input) || isCurrent(out.choice)) continue;
      if (out.crash || out.usage) {
        expect(
          input.noticeShownVersion === V || input.env.VOLLI_TELEMETRY === "1",
          JSON.stringify(input),
        ).toBe(true);
      }
    }
  });

  it("shows a card exactly when the person still has to decide or be told", () => {
    for (const [input, out] of rows) {
      const due =
        !gated(input) &&
        !isCurrent(out.choice) &&
        (asks(input) || (input.noticeShownVersion !== V && input.env.VOLLI_TELEMETRY !== "1"));
      expect(out.card !== null, JSON.stringify(input)).toBe(due);
    }
  });

  it("reconciles only when linking, and otherwise follows a linked account", () => {
    for (const [input, out] of rows) {
      const acct = input.account;
      if (acct === null) {
        expect(out.choice).toBe(input.local);
        expect([out.localWrite, out.accountWrite, out.linkAccount]).toEqual([null, null, false]);
        continue;
      }
      expect(out.linkAccount).toBe(!acct.linked);
      if (acct.linked && acct.choice !== null) {
        expect(out.choice).toBe(acct.choice);
        expect(out.accountWrite).toBeNull();
      }
      if (!acct.linked) {
        for (const tier of ["crash", "usage"] as const) {
          if (input.local?.[tier] === false || acct.choice?.[tier] === false) {
            expect(out.choice?.[tier]).toBe(false);
          }
        }
      }
      // After the writes, both sides hold the decision in force.
      expect(out.localWrite ?? input.local).toEqual(out.choice ?? input.local);
      expect(out.accountWrite ?? acct.choice).toEqual(out.choice ?? acct.choice);
    }
  });
});

describe("telemetryChoice", () => {
  it("records a decision under the current notice, with a narrowed region", () => {
    expect(telemetryChoice({ crash: true, usage: false }, { decidedAt: 42, region: "ca" })).toEqual(
      {
        crash: true,
        usage: false,
        noticeVersion: V,
        decidedAt: 42,
        regionAtDecision: "CA",
      },
    );
    expect(
      telemetryChoice({ crash: false, usage: false }, { decidedAt: 1, region: "" })
        .regionAtDecision,
    ).toBeNull();
  });
});

describe("CHOICE_REGIONS", () => {
  it("is the EEA, its EU territories with their own codes, the United Kingdom and Canada", () => {
    const eu = "AT BE BG CY CZ DE DK EE ES FI FR GR HR HU IE IT LT LU LV MT NL PL PT RO SE SI SK";
    const euTerritories = "AX GF GP MF MQ RE YT";
    const restOfEea = "IS LI NO";
    const expected = `${eu} ${euTerritories} ${restOfEea} GB CA`.split(" ");
    expect([...CHOICE_REGIONS].toSorted()).toEqual(expected.toSorted());
    expect(new Set(CHOICE_REGIONS).size).toBe(CHOICE_REGIONS.length);
  });
});
