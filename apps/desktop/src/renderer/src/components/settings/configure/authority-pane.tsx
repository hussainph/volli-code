/**
 * Configure → Authority: what this project's Sessions are governed by (VC-172).
 *
 * The door migration 025 was missing. VC-44 built the store, every reader it
 * owes, and the Snapshot an attachment pins — and nothing that writes, so every
 * project resolved to the compiled defaults permanently. This is the write.
 *
 * THE AGENT CANNOT REACH THIS, and that is the point rather than a limitation of
 * the surface. Policy is app-owned state precisely so the thing being governed
 * cannot author what governs it (VC-44's non-negotiable). There is deliberately
 * no `volli authority set`: writing policy is control tier, `verb-registry.ts`
 * refuses a `cli` access mode on control-tier verbs, and the socket attributes
 * its caller without authenticating one. Reads may go on the socket one day;
 * this may not, which is why this pane and its IPC channel are the whole door.
 *
 * WHAT IS STORED IS THE DEPARTURES, never the resolved document — migration
 * 025's ruling. So every control here reads its inherited value from
 * `DEFAULT_AUTHORITY_POLICY` and writes only what this project disagrees with,
 * and `OverrideControl` marks the rows that disagree. Storing the resolved
 * policy would pin every field a person never meant to state, and the next
 * tightening of a built-in default would silently skip every project anyone had
 * ever opened this pane on.
 *
 * The scalar policy is here; the list-valued fields (`coordinationVerbs`,
 * `awaitable`) are NOT, and their absence is a decision. `awaitable` has no
 * vocabulary until VC-85 ships something to wait on, and a picker offering await
 * kinds that do not exist would be a guess rendered as a control. Both are
 * PRESERVED across every write from this pane rather than dropped — see
 * `patch` — so a document that states them survives a person changing the
 * enforcement dial.
 */
import * as React from "react";
import { ShieldCheckIcon } from "@phosphor-icons/react/dist/csr/ShieldCheck";
import {
  AUTHORITY_ACTOR_KINDS,
  AUTHORITY_ENFORCEMENTS,
  DEFAULT_AUTHORITY_POLICY,
  JUDGMENT_MODES,
  PEEK_DISCLOSURES,
  resolveAuthorityPolicy,
  type AuthorityActorKind,
  type AuthorityEnforcement,
  type AuthorityPolicyOverride,
  type JudgmentMode,
  type PeekDisclosure,
  type Project,
} from "@volli/shared";

import {
  CommitField,
  CONTROL_W,
  OverrideControl,
  PrefRow,
  PrefSection,
  type CommitResult,
} from "@renderer/components/settings/kit";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@renderer/components/ui/select";
import { writeThrough } from "@renderer/stores/mutate";
import { useProjectsStore } from "@renderer/stores/projects";

/** What each posture actually does to a Session, in the words the type's doc uses. */
const ENFORCEMENT_LABELS: Record<AuthorityEnforcement, string> = {
  off: "Off",
  observe: "Observe",
  enforce: "Enforce",
};

const JUDGMENT_LABELS: Record<JudgmentMode, string> = {
  ask: "Ask me",
  auto: "Classifier",
};

const PEEK_LABELS: Record<PeekDisclosure, string> = {
  none: "No transcripts",
  own: "Its own only",
  project: "Any in this project",
};

/** Named for what each caller IS at the door, not for what it is attributed as. */
const ACTOR_LABELS: Record<AuthorityActorKind, string> = {
  user: "You",
  session: "An authenticated session",
  unauthenticated: "An unauthenticated caller",
};

const ACTOR_HINTS: Record<AuthorityActorKind, string> = {
  user: "You, driving Volli. Bounded by the app's own surfaces rather than by this table.",
  session: "An agent running inside one of this project's Sessions.",
  unauthenticated: "A caller on the agent socket that has not proved who it is.",
};

export function AuthorityPane({ project }: { project: Project }) {
  const adoptProject = useProjectsStore((store) => store.adoptProject);
  const [saving, setSaving] = React.useState(false);

  const override = project.authorityPolicy ?? null;
  // What this project is ACTUALLY governed by, for the rows to show while
  // inheriting. Resolved in the renderer from the same exported defaults main
  // resolves from, so the two can never disagree about what "inherited" means.
  const effective = React.useMemo(() => resolveAuthorityPolicy(override), [override]);
  const defaults = DEFAULT_AUTHORITY_POLICY;

  /**
   * Merge one departure into the stored document and write the whole thing.
   *
   * MERGE, not replace, because this pane does not render every field the
   * document can carry — the list-valued per-actor fields have no control here.
   * A wholesale write of only what is on screen would silently delete a
   * `coordinationVerbs` somebody had stated, which is the failure mode a
   * departures-only store exists to avoid.
   *
   * Pruning is the same bargain in the other direction: a row reverted to its
   * inherited value must leave NO trace, or "chose the default" and "never
   * spoke" become distinguishable in the column and identical everywhere above
   * it. `updateProjectAuthorityPolicy` finishes the job by storing an empty
   * document as `NULL`.
   */
  async function patch(change: Partial<AuthorityPolicyOverride>): Promise<boolean> {
    if (saving) return false;
    const next: AuthorityPolicyOverride = { ...override, ...change };
    for (const key of Object.keys(next) as (keyof AuthorityPolicyOverride)[]) {
      const value = next[key];
      if (value === undefined) delete next[key];
      // An emptied nested object is an absent one. Reverting the last threshold
      // must not leave `fallback: {}` behind to read as a departure.
      else if (key !== "classifierModel" && isEmptyObject(value)) delete next[key];
    }
    setSaving(true);
    const saved = await writeThrough("save this project's authority policy", () =>
      window.api.projects.setAuthorityPolicy({
        id: project.id,
        override: Object.keys(next).length === 0 ? null : next,
      }),
    );
    setSaving(false);
    if (saved === null) return false;
    adoptProject(saved.project);
    return true;
  }

  /** One actor's departures, merged into the actor map rather than over it. */
  function patchActor(
    kind: AuthorityActorKind,
    peek: PeekDisclosure | undefined,
  ): Promise<boolean> {
    const actors = { ...override?.actors };
    const actor = { ...actors[kind] };
    if (peek === undefined) delete actor.peek;
    else actor.peek = peek;
    if (Object.keys(actor).length === 0) delete actors[kind];
    else actors[kind] = actor;
    return patch({ actors });
  }

  /**
   * A threshold commit. Returns the kit's refusal shape so a bad number is
   * shown beside the field that carries it rather than as a toast — this is
   * the one place on the pane where a person can type something wrong.
   */
  function commitThreshold(
    key: "consecutiveDenials" | "sessionDenials",
  ): (next: string) => Promise<CommitResult> {
    return async (next: string): Promise<CommitResult> => {
      const trimmed = next.trim();
      // Emptying the box is how a threshold reverts to its inherited value.
      if (trimmed === "") {
        const fallback = { ...override?.fallback };
        delete fallback[key];
        const ok = await patch({ fallback });
        return ok
          ? { ok: true, value: String(defaults.fallback[key]) }
          : { ok: false, error: "That did not save." };
      }
      const parsed = Number(trimmed);
      if (!Number.isInteger(parsed) || parsed < 1) {
        // The same floor `validateAuthorityPolicyOverride` enforces, said here
        // so the answer arrives before the round trip. Main still refuses it —
        // this is a courtesy, not the check.
        return { ok: false, error: "Must be a whole number of denials, 1 or greater." };
      }
      const ok = await patch({ fallback: { ...override?.fallback, [key]: parsed } });
      return ok ? { ok: true, value: String(parsed) } : { ok: false, error: "That did not save." };
    };
  }

  // `auto` names a judge that does not exist until a classifier is configured,
  // and `classifierModel` has no surface yet. Offering it would let someone
  // select a decision-maker that cannot decide, so it is visible and disabled
  // rather than hidden — the posture exists, and a person looking for it should
  // find out why it is unavailable rather than wonder where it went.
  const classifierAvailable = effective.classifierModel !== null;

  return (
    <PrefSection
      title="Authority"
      icon={ShieldCheckIcon}
      hint={
        <>
          What this project&rsquo;s Sessions are allowed to do. Each Session is pinned to this
          policy when it attaches, so a change here reaches the next Session rather than one already
          running.
        </>
      }
    >
      <PrefRow
        label="Rule enforcement"
        htmlFor="authority-enforcement"
        testId="authority-enforcement"
        hint={
          <>
            <strong>Off</strong> runs no rule checks at all. <strong>Observe</strong> records what a
            Session was governed by without refusing anything. <strong>Enforce</strong> refuses what
            the rules deny and asks you about the rest.
          </>
        }
      >
        <OverrideControl
          label="Rule enforcement"
          inheritedValue={ENFORCEMENT_LABELS[defaults.enforcement]}
          overridden={override?.enforcement !== undefined}
          onRevert={() => void patch({ enforcement: undefined })}
        >
          <Select
            value={effective.enforcement}
            disabled={saving}
            onValueChange={(next) => void patch({ enforcement: next as AuthorityEnforcement })}
          >
            <SelectTrigger id="authority-enforcement" className={CONTROL_W.md}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {AUTHORITY_ENFORCEMENTS.map((value) => (
                <SelectItem key={value} value={value}>
                  {ENFORCEMENT_LABELS[value]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </OverrideControl>
      </PrefRow>

      <PrefRow
        label="Who judges the rest"
        htmlFor="authority-judgment"
        testId="authority-judgment"
        hint={
          classifierAvailable ? (
            <>Who rules on a call the deterministic rules cannot settle.</>
          ) : (
            <>
              Who rules on a call the deterministic rules cannot settle. No classifier is
              configured, so every such call comes to you.
            </>
          )
        }
      >
        <OverrideControl
          label="Who judges the rest"
          inheritedValue={JUDGMENT_LABELS[defaults.judgmentMode]}
          overridden={override?.judgmentMode !== undefined}
          onRevert={() => void patch({ judgmentMode: undefined })}
        >
          <Select
            value={effective.judgmentMode}
            disabled={saving}
            onValueChange={(next) => void patch({ judgmentMode: next as JudgmentMode })}
          >
            <SelectTrigger id="authority-judgment" className={CONTROL_W.md}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {JUDGMENT_MODES.map((value) => (
                <SelectItem
                  key={value}
                  value={value}
                  disabled={value === "auto" && !classifierAvailable}
                >
                  {JUDGMENT_LABELS[value]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </OverrideControl>
      </PrefRow>

      <PrefRow
        label="Ask me after"
        htmlFor="authority-consecutive"
        testId="authority-consecutive-denials"
        hint={
          <>
            Consecutive refusals before a Session stops and asks you. A Session that keeps hitting
            the same wall is a Session that needs a person.
          </>
        }
      >
        <OverrideControl
          label="Ask me after"
          inheritedValue={`${defaults.fallback.consecutiveDenials} refusals in a row`}
          overridden={override?.fallback?.consecutiveDenials !== undefined}
          onRevert={() => void commitThreshold("consecutiveDenials")("")}
        >
          <CommitField
            id="authority-consecutive"
            type="number"
            width="sm"
            value={String(effective.fallback.consecutiveDenials)}
            disabled={saving}
            onCommit={commitThreshold("consecutiveDenials")}
          />
        </OverrideControl>
      </PrefRow>

      <PrefRow
        label="Or after, in total"
        htmlFor="authority-session"
        testId="authority-session-denials"
        hint={<>Refusals across the whole Session, however far apart, before it asks you.</>}
      >
        <OverrideControl
          label="Or after, in total"
          inheritedValue={`${defaults.fallback.sessionDenials} refusals`}
          overridden={override?.fallback?.sessionDenials !== undefined}
          onRevert={() => void commitThreshold("sessionDenials")("")}
        >
          <CommitField
            id="authority-session"
            type="number"
            width="sm"
            value={String(effective.fallback.sessionDenials)}
            disabled={saving}
            onCommit={commitThreshold("sessionDenials")}
          />
        </OverrideControl>
      </PrefRow>

      {/*
       * Transcript disclosure, per kind of caller. `own` is the default for a
       * Session rather than `project` because a transcript carries another
       * agent's whole context — an orchestrator that needs it can be granted it
       * here, which is the entire reason this row is reachable.
       */}
      {AUTHORITY_ACTOR_KINDS.map((kind) => (
        <PrefRow
          key={kind}
          label={`${ACTOR_LABELS[kind]} can read`}
          htmlFor={`authority-peek-${kind}`}
          testId={`authority-peek-${kind}`}
          hint={<>{ACTOR_HINTS[kind]}</>}
        >
          <OverrideControl
            label={`${ACTOR_LABELS[kind]} can read`}
            inheritedValue={PEEK_LABELS[defaults.actors[kind].peek]}
            overridden={override?.actors?.[kind]?.peek !== undefined}
            onRevert={() => void patchActor(kind, undefined)}
          >
            <Select
              value={effective.actors[kind].peek}
              disabled={saving}
              onValueChange={(next) => void patchActor(kind, next as PeekDisclosure)}
            >
              <SelectTrigger id={`authority-peek-${kind}`} className={CONTROL_W.md}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PEEK_DISCLOSURES.map((value) => (
                  <SelectItem key={value} value={value}>
                    {PEEK_LABELS[value]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </OverrideControl>
        </PrefRow>
      ))}
    </PrefSection>
  );
}

function isEmptyObject(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === 0
  );
}
