import { describe, expect, it } from "vite-plus/test";
import fixture from "./fixtures/legacy-authority-ledger.json";
import {
  decodeSessionEventPayload,
  decodeRendererSessionEventPayload,
  scrubSessionEventPayload,
} from "./session-event-codec";
import { projectSession, type Session, type SessionEvent } from "./session-ledger";
import {
  parseAuthorityPolicyOverride,
  resolveAuthorityPolicy,
  validateAuthorityPolicyOverride,
} from "./authority-config";

describe("retired authority history", () => {
  it("decodes and replays the recorded ledger without reviving any approval", () => {
    const events = fixture.events.map((event): SessionEvent => ({
      ...event,
      provenance: {
        source: { kind: "system", id: "desktop", detail: null },
        venue: { id: "local", kind: "local" },
      },
      payload: decodeSessionEventPayload(event.payload, "recorded.payload"),
    }));
    for (const event of events) {
      const safe = scrubSessionEventPayload(event.payload);
      expect(() => decodeRendererSessionEventPayload(safe, "renderer.payload")).not.toThrow();
    }
    const projection = projectSession(fixture.session as Session, events);
    expect(projection.liveExecutor?.id).toBe("attachment-1");
    expect(projection.liveExecutor?.authority).toBeNull();
    expect(projection.interactions.active).toEqual([]);
    expect(projection.interactions.resolved).toEqual([]);
    expect(projection.attention.active).toEqual([]);
    expect(projection.commands).toEqual([]);
    expect(projection).not.toHaveProperty("authorityDenials");
    expect(events.filter(({ payload }) => payload.kind === "adapter.observed")).toHaveLength(13);
  });

  it("also accepts retired native event/command spellings as inert evidence on both read seams", () => {
    const records = [
      ...fixture.events
        .map(({ payload }) => payload)
        .filter(
          ({ kind }) =>
            kind === "authority.denied" ||
            kind === "authority.reviewed" ||
            kind.startsWith("interaction."),
        ),
      ...[
        "approval.used",
        "approval-used",
        "approval.revoked",
        "approval.restored",
        "approval.revoke",
        "approval.restore",
      ].map((kind) => ({ kind, approvalId: "old-approval", native: { actionable: true } })),
      {
        kind: "command.recorded",
        command: { intent: { kind: "approval.revoke", approvalId: "old-approval" } },
      },
      {
        kind: "command.recorded",
        command: { intent: { kind: "approval.restore", approvalId: "old-approval" } },
      },
    ];
    for (const record of records) {
      for (const decode of [decodeSessionEventPayload, decodeRendererSessionEventPayload]) {
        const decoded = decode(record, "legacy");
        expect(decoded).toMatchObject({ kind: "adapter.observed", native: null });
      }
    }
  });

  it("keeps budget and confirmation permissions live instead of retiring every permission", () => {
    const recorded = fixture.events[4].payload;
    if (
      !("interaction" in recorded) ||
      !recorded.interaction ||
      !("approval" in recorded.interaction)
    )
      throw new Error("invalid fixture");
    const { approval: _removed, ...interaction } = recorded.interaction;
    for (const id of ["budget-ask:call", "confirm-ask:call", "credential-ask:call"]) {
      const payload = decodeSessionEventPayload(
        { kind: "interaction.opened", interaction: { ...interaction, id } },
        "legacy",
      );
      expect(payload.kind).toBe("interaction.opened");
      const projection = projectSession(fixture.session as Session, [
        {
          ...fixture.events[4],
          payload,
          provenance: { source: { kind: "system", id: "desktop", detail: null }, venue: null },
        },
      ]);
      expect(projection.interactions.active.map((active) => active.id)).toEqual([id]);
    }
  });

  it("ignores retired override fields on read and validation, retaining actors and budgets", () => {
    const stored = {
      enforcement: "enforce",
      judgmentMode: "auto",
      classifierModel: "cloud/model",
      fallback: { consecutiveDenials: 3, sessionDenials: 20 },
      budgets: { delegationExceeded: "refuse" },
      actors: {
        session: {
          coordinationVerbs: ["ticket.comment"],
          peek: "project",
          awaitable: [],
          awaitableSessions: [],
        },
      },
    };
    const retained = { budgets: stored.budgets, actors: stored.actors };
    expect(parseAuthorityPolicyOverride(stored)).toEqual(retained);
    expect(validateAuthorityPolicyOverride(stored)).toEqual({ ok: true, override: retained });
    expect(
      parseAuthorityPolicyOverride({
        enforcement: false,
        judgmentMode: 1,
        classifierModel: {},
        fallback: "obsolete",
        ...retained,
      }),
    ).toEqual(retained);
    expect(
      validateAuthorityPolicyOverride({
        enforcement: false,
        judgmentMode: 1,
        classifierModel: {},
        fallback: "obsolete",
        ...retained,
      }),
    ).toEqual({ ok: true, override: retained });
    const policy = resolveAuthorityPolicy(parseAuthorityPolicyOverride(stored));
    expect(policy.budgets.delegationExceeded).toBe("refuse");
    expect(policy.actors.session).toEqual(stored.actors.session);
    expect(Object.keys(policy).toSorted()).toEqual(["actors", "budgets"]);
  });
});
