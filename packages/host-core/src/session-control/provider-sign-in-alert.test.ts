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
  options: {
    providerId?: string;
    attention?: SessionAttention | null;
    stopped?: boolean;
    /** The provider the stop belongs to, when it differs from the current model. */
    stoppedOn?: string;
    completedTurn?: string;
    archived?: boolean;
  } = {},
): SessionProjection {
  const active = options.attention ? [options.attention] : [];
  return {
    status: options.archived ? "archived" : "open",
    lastTurnOutcome: options.completedTurn === undefined ? null : "completed",
    latestTurnId: options.completedTurn ?? null,
    ...(options.attention && options.stoppedOn !== undefined
      ? { attentionProviders: { [options.attention.id]: options.stoppedOn } }
      : {}),
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

function harness(labels: Record<string, string> = {}) {
  const notified: NotificationRequest[] = [];
  const errors: unknown[] = [];
  const alert = createProviderSignInAlert({
    providerLabel: (providerId) => labels[providerId] ?? null,
    notify: (request) => notified.push(request),
    onError: (error) => errors.push(error),
  });
  return { alert, notified, errors };
}

describe("provider sign-in alert", () => {
  it("tells the person once when four chats stop on one credential", () => {
    const { alert, notified, errors } = harness({ anthropic: "Anthropic" });
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
        body: "Chat a stopped: the Anthropic sign-in expired or was refused.",
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

  it("a sign-in again ends the episode: a later failure is told again", () => {
    const { alert, notified } = harness();
    for (const id of ["a", "b", "c"]) alert.observeBirth(id);
    alert.observe(projection("a", { attention: authStop("a") }));
    alert.observe(projection("b", { attention: authStop("b") }));
    expect(notified).toHaveLength(1);
    alert.signedIn("anthropic");
    // The stopped chats still hold their stops (nothing resumes them), and a
    // re-fold of one is not a new failure.
    alert.observe(projection("a", { attention: authStop("a") }));
    expect(notified).toHaveLength(1);
    // A chat that fails after the sign-in is a new episode, told once.
    alert.observe(projection("c", { attention: authStop("c") }));
    alert.observe(projection("b"));
    alert.observe(projection("b", { attention: authStop("b") }));
    expect(
      notified.map((request) =>
        request.target?.kind === "session" ? request.target.sessionId : null,
      ),
    ).toEqual(["a", "c"]);
    // Another provider's sign-in answers nothing here.
    alert.signedIn("openai-codex");
    alert.observe(projection("a"));
    alert.observe(projection("a", { attention: authStop("a") }));
    expect(notified).toHaveLength(2);
  });

  it("a chat switched to another model after it stopped is still the first provider's stop", () => {
    const { alert, notified } = harness();
    alert.observeBirth("a");
    alert.observeBirth("b");
    alert.observe(projection("a", { attention: authStop("a") }));
    expect(notified).toHaveLength(1);
    // The person moves chat a to OpenAI to keep working: the same stop, still
    // Anthropic's — no new alert, and no alert naming OpenAI.
    alert.observe(
      projection("a", {
        providerId: "openai-codex",
        stoppedOn: "anthropic",
        attention: authStop("a"),
      }),
    );
    expect(notified).toHaveLength(1);
    // It still holds Anthropic's episode: a second Anthropic chat stays quiet.
    alert.observe(projection("b", { attention: authStop("b") }));
    expect(notified).toHaveLength(1);
    // A turn completing on OpenAI clears a's stop and says nothing about Anthropic.
    alert.observe(projection("a", { providerId: "openai-codex", completedTurn: "t1" }));
    alert.observeBirth("c");
    alert.observe(projection("c", { attention: authStop("c") }));
    expect(notified).toHaveLength(1);
  });

  it("any completed turn on the provider ends its episode, however the sign-in happened", () => {
    const { alert, notified } = harness();
    for (const id of ["a", "b", "c"]) alert.observeBirth(id);
    alert.observe(projection("a", { attention: authStop("a") }));
    expect(notified).toHaveLength(1);
    // Signed in through the `pi` CLI: Volli saw no sign-in, but b's next turn on
    // Anthropic completes. a stays stopped (nothing resumes it).
    alert.observe(projection("b", { completedTurn: "t1" }));
    // Re-folding the same completed turn is not a second proof.
    alert.observe(projection("b", { completedTurn: "t1" }));
    alert.observe(projection("c", { attention: authStop("c") }));
    expect(notified).toHaveLength(2);
  });

  it("an archived Session holds no episode open and raises nothing", () => {
    const { alert, notified } = harness();
    for (const id of ["a", "b"]) alert.observeBirth(id);
    alert.observe(projection("a", { attention: authStop("a") }));
    expect(notified).toHaveLength(1);
    alert.observe(projection("a", { attention: authStop("a"), archived: true }));
    alert.observe(projection("b", { attention: authStop("b") }));
    expect(notified).toHaveLength(2);
    alert.observeBirth("d");
    alert.observe(projection("d", { attention: authStop("d"), archived: true }));
    expect(notified).toHaveLength(2);
  });

  it("an unreadable credential is not an expired sign-in and raises nothing", () => {
    const { alert, notified } = harness();
    alert.observeBirth("a");
    alert.observe(
      projection("a", {
        attention: authStop("a", { ...SIGN_IN, providerType: "volli.credential-unavailable" }),
      }),
    );
    expect(notified).toEqual([]);
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
