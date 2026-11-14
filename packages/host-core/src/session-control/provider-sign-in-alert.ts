/**
 * Tell a person once when a provider sign-in stops their chats (VC-1236).
 *
 * Every Session on one provider shares one credential. When that credential
 * expires or is revoked, each working Session stops on its next request — four
 * of them, minutes apart, in the incident this answers — and each raises its
 * own `auth_required` Attention in its own chat. A person who is not looking at
 * those chats learns nothing until they go and find them dead.
 *
 * So the host says it once, for the provider: the first Session that ENTERS a
 * sign-in stop while no other Session on that provider stands in one posts one
 * alert, pointed at that Session's Attention, whose row carries the provider's
 * own Sign in. Every later Session that stops on the same provider is part of
 * the same episode and stays quiet. The episode ends when no Session on the
 * provider stands stopped on its sign-in any more — each one clears on its next
 * successful turn — and only then can a later expiry speak again.
 *
 * ── EDGES, NOT STATES; FIRST SIGHTINGS SEED ───────────────────────────────
 * The same rules as `automations/run-attention.ts`, for the same reasons: every
 * durable write re-folds a Session, so only an edge into the stop may speak,
 * and a Session first seen after a relaunch already stopped is a stop that
 * happened before this process watched, so it seeds in silence. It still
 * counts toward its provider's episode, so a relaunch does not re-announce a
 * provider whose chats are already stopped.
 *
 * Recovery is the person's: nothing here resumes a Session. After signing in,
 * a message (or the run's Retry, where offered) continues each one from its
 * last settled point; the failed request was never sent, so nothing repeats.
 *
 * Observer discipline: never throws into the write path that folded it.
 */
import {
  providerSignInStop,
  shortSessionId,
  type ProviderSignInStop,
  type NotificationRequest,
  type SessionProjection,
} from "@volli/shared";

import { hostLogger } from "../log/root";

const log = hostLogger("provider-sign-in-alert");

export interface ProviderSignInAlertPorts {
  /** The one delivery path (VC-295); it owns the preference and focus rules. */
  notify(request: NotificationRequest): void;
  /** Diagnostics seam. Defaults to the host log. */
  onError?: (error: unknown) => void;
}

export interface ProviderSignInAlert {
  /** One folded Session, from the activity watch. Never throws. */
  observe(projection: SessionProjection): void;
  /** A Session this process just minted: it has no stop, which is a fact. */
  observeBirth(sessionId: string): void;
}

/** What the alert says. Product text only; the provider is named by its id. */
export function providerSignInNotification(
  stop: ProviderSignInStop,
  session: { id: string; title: string | null },
): { title: string; body: string } {
  const subject = session.title ?? `Session ${shortSessionId(session.id)}`;
  return {
    title: "Sign-in needed",
    body: `${subject} stopped: the ${stop.providerId} sign-in expired or was refused.`,
  };
}

export function createProviderSignInAlert(ports: ProviderSignInAlertPorts): ProviderSignInAlert {
  const onError =
    ports.onError ?? ((error: unknown) => log.warn("provider sign-in alert failed", { error }));
  /**
   * Per Session this process has seen: the provider it stands stopped on, or
   * `null`. No entry means never seen, which is what makes a first sighting a
   * seed rather than an edge. Bounded by the Sessions written to in this run,
   * like the run-attention memory beside it.
   */
  const seen = new Map<string, string | null>();

  const episodeOpen = (providerId: string, except: string): boolean => {
    for (const [sessionId, stoppedOn] of seen) {
      if (sessionId !== except && stoppedOn === providerId) return true;
    }
    return false;
  };

  return {
    observe(projection) {
      try {
        const sessionId = projection.session.id;
        const stop = providerSignInStop(projection);
        const known = seen.has(sessionId);
        const previous = seen.get(sessionId) ?? null;
        seen.set(sessionId, stop?.providerId ?? null);
        if (!known || stop === null || stop.providerId === previous) return;
        if (episodeOpen(stop.providerId, sessionId)) return;
        ports.notify({
          producer: "provider-sign-in-required",
          ...providerSignInNotification(stop, projection.session),
          target: {
            kind: "session",
            projectId: projection.session.projectId,
            ticketId: projection.session.ticketId,
            sessionId,
            interactionId: null,
            attentionId: stop.attentionId,
          },
        });
      } catch (error) {
        onError(error);
      }
    },
    observeBirth(sessionId) {
      if (!seen.has(sessionId)) seen.set(sessionId, null);
    },
  };
}
