/**
 * One alert per provider sign-in episode (VC-1236): several chats stopping on
 * one expired credential tell the person once, and only an edge speaks.
 */
import { describe, expect, it } from "vite-plus/test";
import type {
  NotificationRequest,
  SessionAttention,
  SessionProjection,
  SessionStopDetail,
} from "@volli/shared";

import { createProviderSignInAlert } from "./provider-sign-in-alert";

const SIGN_IN: SessionStopDetail = {
  category: "auth-failed",
  providerType: "volli.credential-refresh-failed",
  message: "[Provider text withheld: possible request content.]",
  httpStatus: null,
  retry: "not-retried",
  resetsAt: null,
};

function authStop(sessionId: string, stopDetail: SessionStopDetail = SIGN_IN): SessionAttention {
  return {
    id: `pi:attention:${sessionId}:auth`,
    attachmentId: `attachment-${sessionId}`,
    kind: "auth_required",
    detail: stopDetail.message,
    diagnostic: null,
    stopDetail,
  };
}

/** Only the fields the rule reads; the rest of a projection is irrelevant to it. */
function projection(
  sessionId: string,
  options: { providerId?: string; attention?: SessionAttention | null; stopped?: boolean } = {},
): SessionProjection {
  const active = options.attention ? [options.attention] : [];
  return {
    session: {
      id: sessionId,
      projectId: "p",
      ticketId: `ticket-${sessionId}`,
      role: "ticket",
      parentSessionId: null,
      title: `Chat ${sessionId}`,
      createdAt: 0,
    },
    attention: { active, primary: active[0] ?? null },
    modelSelection: {
      providerId: options.providerId ?? "anthropic",
      modelId: "fixture",
      reasoningLevel: "off",
    },
    stopped: options.stopped ? { at: 1, by: { kind: "user" }, reason: null } : null,
  } as unknown as SessionProjection;
}

function harness() {
  const notified: NotificationRequest[] = [];
  const errors: unknown[] = [];
  const alert = createProviderSignInAlert({
    notify: (request) => notified.push(request),
    onError: (error) => errors.push(error),
  });
  return { alert, notified, errors };
}

describe("provider sign-in alert", () => {
  it("tells the person once when four chats stop on one credential", () => {
    const { alert, notified, errors } = harness();
    const ids = ["a", "b", "c", "d"];
    for (const id of ids) alert.observe(projection(id));
    for (const id of ids) {
      alert.observe(projection(id, { attention: authStop(id) }));
      // A re-fold of the same stop is not a new edge.
      alert.observe(projection(id, { attention: authStop(id) }));
    }
    expect(errors).toEqual([]);
    expect(notified).toEqual([
      {
        producer: "provider-sign-in-required",
        title: "Sign-in needed",
        body: "Chat a stopped: the anthropic sign-in expired or was refused.",
        target: {
          kind: "session",
          projectId: "p",
          ticketId: "ticket-a",
          sessionId: "a",
          interactionId: null,
          attentionId: "pi:attention:a:auth",
        },
      },
    ]);
  });

  it("speaks again only after every chat on that provider has recovered", () => {
    const { alert, notified } = harness();
    alert.observeBirth("a");
    alert.observeBirth("b");
    alert.observe(projection("a", { attention: authStop("a") }));
    alert.observe(projection("b", { attention: authStop("b") }));
    expect(notified).toHaveLength(1);
    // The person signs in; one chat continues, the other is still stopped.
    alert.observe(projection("a"));
    alert.observe(projection("a", { attention: authStop("a") }));
    expect(notified).toHaveLength(1);
    // Both continue; a later expiry is a new episode.
    alert.observe(projection("b"));
    alert.observe(projection("a"));
    alert.observe(projection("b", { attention: authStop("b") }));
    expect(notified).toHaveLength(2);
    expect(notified[1]?.target).toMatchObject({ sessionId: "b" });
  });

  it("keeps providers apart: one provider's episode does not silence another's", () => {
    const { alert, notified } = harness();
    alert.observeBirth("a");
    alert.observeBirth("b");
    alert.observe(projection("a", { attention: authStop("a") }));
    alert.observe(projection("b", { providerId: "openai-codex", attention: authStop("b") }));
    expect(notified.map((request) => request.body)).toEqual([
      "Chat a stopped: the anthropic sign-in expired or was refused.",
      "Chat b stopped: the openai-codex sign-in expired or was refused.",
    ]);
  });

  it("stays silent for a stop it did not watch begin, and for causes that are not a sign-in", () => {
    const { alert, notified } = harness();
    // First sighting after a relaunch, already stopped: seeds, and holds the episode.
    alert.observe(projection("a", { attention: authStop("a") }));
    alert.observeBirth("b");
    alert.observe(projection("b", { attention: authStop("b") }));
    // Access a credential lacks, and a stop a person made, are not this alert.
    alert.observeBirth("c");
    alert.observe(
      projection("c", {
        providerId: "other",
        attention: authStop("c", { ...SIGN_IN, providerType: "permission_error", httpStatus: 403 }),
      }),
    );
    alert.observeBirth("d");
    alert.observe(
      projection("d", { providerId: "third", attention: authStop("d"), stopped: true }),
    );
    expect(notified).toEqual([]);
  });

  it("never throws into the write path", () => {
    const { alert, errors } = harness();
    alert.observe({} as SessionProjection);
    expect(errors).toHaveLength(1);
  });
});
