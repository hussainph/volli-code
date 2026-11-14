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
 * the same episode and stays quiet. The episode ends when the provider is
 * shown to work again — the person signs in to it in Volli
 * ({@link ProviderSignInAlert.signedIn}), or any Session's turn on it completes
 * (which also covers a sign-in made elsewhere, such as the `pi` CLI on the
 * same credential file) — or when no Session stands stopped on it any more.
 * Archived Sessions never hold an episode open. The provider is the one that
 * failed, bound to the stop (`providerSignInStop`), so a chat switched to
 * another model after it stopped neither re-announces nor re-attributes it.
 *
 * ── EDGES, NOT STATES; FIRST SIGHTINGS SEED ───────────────────────────────
 * The same rules as `automations/run-attention.ts`, for the same reasons: every
 * durable write re-folds a Session, so only an edge into the stop may speak,
 * and a Session first seen after a relaunch already stopped is a stop that
 * happened before this process watched, so it seeds in silence. It still
 * counts toward its provider's episode, so a relaunch does not re-announce a
 * provider whose chats are already stopped.
 *
 * Recovery is the person's: nothing here resumes a Session, a sign-in
 * included. After signing in, a message continues each one from its last
 * settled point; the failed request was never sent, so nothing repeats.
 *
 * Observer discipline: never throws into the write path that folded it.
 */
import {
  providerSignInStop,
  shortSessionId,
  type NotificationRequest,
  type SessionProjection,
} from "@volli/shared";

import { hostLogger } from "../log/root";

const log = hostLogger("provider-sign-in-alert");

export interface ProviderSignInAlertPorts {
  /** The provider's display name, or `null` when unknown; the id stands in then. */
  providerLabel?(providerId: string): string | null;
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
  /**
   * The person signed in to this provider again (VC-1236). The episode the
   * alert spoke for is over: the chats it stopped still hold their stops until
   * someone continues them, but they no longer keep a later failure quiet. A
   * new stop after this is told again.
   */
  signedIn(providerId: string): void;
}

/** What the alert says. Product text only; the provider by its label, else its id. */
function providerSignInNotification(
  provider: string,
  session: { id: string; title: string | null },
): { title: string; body: string } {
  const subject = session.title ?? `Session ${shortSessionId(session.id)}`;
  return {
    title: "Sign-in needed",
    body: `${subject} stopped: the ${provider} sign-in expired or was refused.`,
  };
}

export function createProviderSignInAlert(ports: ProviderSignInAlertPorts): ProviderSignInAlert {
  const onError =
    ports.onError ?? ((error: unknown) => log.warn("provider sign-in alert failed", { error }));
  /**
   * Per Session this process has seen: the sign-in stop it stands in (its
   * Attention, and the provider that failed), whether a sign-in or a working
   * turn on that provider has since answered it, and the last completed turn
   * seen. No entry means never seen, which is what makes a first sighting a
   * seed rather than an edge. Bounded by the Sessions written to in this run,
   * like the run-attention memory beside it.
   */
  const seen = new Map<
    string,
    {
      attentionId: string | null;
      providerId: string | null;
      answered: boolean;
      completedTurnId: string | null;
    }
  >();

  const episodeOpen = (providerId: string, except: string): boolean => {
    for (const [sessionId, entry] of seen) {
      if (sessionId !== except && entry.providerId === providerId && !entry.answered) return true;
    }
    return false;
  };
  /** The provider works again (a sign-in, or a turn that completed on it): the episode is over. */
  const answer = (providerId: string): void => {
    for (const entry of seen.values()) {
      if (entry.providerId === providerId) entry.answered = true;
    }
  };

  return {
    observe(projection) {
      try {
        const sessionId = projection.session.id;
        const stop = providerSignInStop(projection);
        const previous = seen.get(sessionId);
        const completedTurnId =
          projection.lastTurnOutcome === "completed" && projection.status !== "archived"
            ? projection.latestTurnId
            : null;
        // A turn that completed since this Session was last seen proves its
        // provider's credential works, however it came to (a sign-in here, the
        // `pi` CLI on the same file, a refresh that went through).
        if (
          previous !== undefined &&
          completedTurnId !== null &&
          completedTurnId !== previous.completedTurnId &&
          projection.modelSelection !== null
        ) {
          answer(projection.modelSelection.providerId);
        }
        const attentionId = stop?.attentionId ?? null;
        // The same stop re-folded by any later write — a rename, a model
        // switch — is not a new edge; the edge is keyed by the Attention.
        if (previous !== undefined && previous.attentionId === attentionId) {
          previous.completedTurnId = completedTurnId ?? previous.completedTurnId;
          return;
        }
        seen.set(sessionId, {
          attentionId,
          providerId: stop?.providerId ?? null,
          answered: false,
          completedTurnId: completedTurnId ?? previous?.completedTurnId ?? null,
        });
        if (previous === undefined || stop === null) return;
        if (episodeOpen(stop.providerId, sessionId)) return;
        ports.notify({
          producer: "provider-sign-in-required",
          ...providerSignInNotification(
            ports.providerLabel?.(stop.providerId) ?? stop.providerId,
            projection.session,
          ),
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
    signedIn(providerId) {
      answer(providerId);
    },
    observeBirth(sessionId) {
      if (!seen.has(sessionId)) {
        seen.set(sessionId, {
          attentionId: null,
          providerId: null,
          answered: false,
          completedTurnId: null,
        });
      }
    },
  };
}
