/**
 * The fresh-Session prompt baseline, measured per section (VC-66), and how
 * often each section is bought again (VC-164).
 *
 * A new Session pays a context cost before the user types a word: the system
 * prompt's layers, every RESOURCE block riding it (the skills index above
 * all), and the delimited Runtime Brief and Turn Reminders that open the first
 * message. This module prices that preamble reproducibly — same inputs, same
 * numbers — by measuring the exact strings `composeSystemPrompt` and
 * `composeFirstUserMessage` assemble, through the same section list the
 * composer renders. A section cannot appear in what a Session is sent without
 * appearing here, or here without being sent.
 *
 * Each section also carries what it costs to KEEP: a {@link PromptCacheClass}
 * saying how wide a set of requests reuses those bytes, and a
 * {@link PromptCachePlacement} saying whether a change to them would invalidate
 * the Cache Prefix or nothing at all. Size alone cannot rank two sections —
 * bytes bought once for every Session of a Role are not the same purchase as
 * bytes bought once per Session — and this is the column that says which is
 * which.
 *
 * Token counts are ESTIMATES. There is no tokenizer in this workspace; the
 * only counting primitive anywhere is the renderer's ~4 characters/token
 * heuristic (`context-usage.ts`), and this module deliberately uses the same
 * ratio so the two surfaces tell one story. The honest cross-check is a
 * provider-measured first turn. And the baseline is deliberately not the
 * whole first-turn meter: tool definitions and provider overhead ride on top
 * of everything measured here, are serialized provider-side, and are named as
 * excluded rather than guessed at.
 *
 * Cache classes are CLAIMS, and the word is chosen for the same reason. A class
 * is derived from what a section is composed FROM — Role, project, Session —
 * and asserts how wide a set of requests can reuse its bytes; nothing here has
 * asked a provider anything. The measurement that can falsify one already
 * exists in the shape it will arrive in: `SanitizedUsage.cacheReadTokens` and
 * `cacheWriteTokens` (`@volli/shared`), which VC-87's cost telemetry reports
 * per turn. A section classed `role-static` that turns up in a cache WRITE on
 * the second Session of that Role means this module is wrong and the meter is
 * right.
 */
import { SKILLS_INDEX_RESOURCE_NAME } from "@volli/shared";
import type { RuntimeBrief, RuntimeWorkspaceEnvironment } from "@volli/shared";

import {
  composeBriefBlock,
  composeToolSurfaceBlock,
  composeTurnReminderBlock,
  systemPromptSections,
} from "./prompt";
import type { SystemPromptInput } from "./prompt";

/**
 * The renderer's `CHARS_PER_TOKEN`, spelled again here because the renderer
 * module lives behind a DOM boundary this package must not import across.
 * Close enough for a share, never shown as a count of record.
 */
export const PROMPT_BASELINE_CHARS_PER_TOKEN = 4;

/**
 * How wide a set of requests can reuse a section's bytes — which is to say how
 * often those bytes are bought at cache-write price instead of read at ~0.1x.
 *
 * - `role-static`: composed from Role, its frozen bundle, and product version.
 *   Every Session with those terms composes the same bytes, so the first one to
 *   run pays for them and every overlapping Session reads them.
 * - `project-static`: composed from a project fact. Shared by every Session in
 *   the project — which is where the skills index, far the largest section,
 *   lands.
 * - `session-static`: fixed for one Session's life and shared with no other.
 *   Bought once, read on every turn after the first.
 * - `per-turn`: recomposed while the Session runs. Nothing carries this class
 *   today, and the emptiness is the finding rather than an oversight — see
 *   {@link WORKSPACE_ENVIRONMENT_REMINDER_ID}. The class stays named because a
 *   Turn Reminder is DEFINED by per-turn delivery (CONTEXT.md), and the next
 *   one — live ticket state — will be one.
 */
export type PromptCacheClass = "role-static" | "project-static" | "session-static" | "per-turn";

/**
 * Which side of the shared Cache Prefix a section's bytes land on.
 *
 * A second axis and not a fifth class, deliberately. The four class names
 * answer "how often are these bytes re-bought", and they answer it correctly
 * for the Brief: once per Session, exactly like a session-static prompt byte.
 * What a class cannot say is what a CHANGE costs, and between the two sides
 * that price differs by everything:
 *
 * - `prefix`: the system prompt, ahead of every message in the request. These
 *   bytes ARE the prefix, so a section that differs between two Sessions costs
 *   not only itself but every section after it. A `session-static` section here
 *   is not a defect but it is a real price — bytes no other Session can reuse,
 *   sitting ahead of bytes they otherwise could; a skill named at start is
 *   exactly that, and is why the resource set is one of the four terms the
 *   prompt is a pure function of. A `per-turn` section here would throw the
 *   whole request away every turn, and `prompt.ts` now makes it untypeable
 *   (VC-164 lane A).
 * - `message`: content in the first delivered message, after the entire prompt.
 *   Pi composes the Brief and any reminder exactly once, on an empty message
 *   array (`pi/runtime.ts`), and history is append-only — so these bytes are
 *   never rewritten and can invalidate nothing ahead of them. Compaction can
 *   even drop them from the payload outright, since elision keeps the last
 *   compaction entry onward (`pi/compaction.ts`), where a prompt byte is bought
 *   again on every request for the Session's whole life.
 *
 * Folding this into the class enum would have let "session-static" mean two
 * different prices depending on which section wore it — precisely the thing
 * this readout exists to stop hiding.
 */
export type PromptCachePlacement = "prefix" | "message";

/**
 * The Turn Reminder carrying VC-156's dependency fact, priced as a section
 * because it is real delivered bytes that nothing else counts.
 *
 * Classed `session-static` and NOT `per-turn`, which is where this departs from
 * the shape VC-164 was filed in. Turn Reminders are per-turn by definition, but
 * this one is not delivered per turn: `composeFirstUserMessage` runs only when
 * the message array is empty, so the block is composed once, on the Session's
 * first delivered message, and never again — a re-attach onto existing history
 * does not re-send it. Calling it per-turn would over-state its cost by every
 * turn after the first.
 *
 * The self-invalidation that got it evicted from the prompt is a real cost and
 * it is not this one: it makes the NEXT Session's measurement differ, not this
 * Session's bytes churn. On the message side that costs its own ~60 tokens once
 * and nothing else, which is the whole point of having moved it.
 */
export const WORKSPACE_ENVIRONMENT_REMINDER_ID = "reminder:workspace-environment";

/**
 * The Role bundle block riding the same first message (VC-162).
 *
 * `session-static` and not `role-static`, which is the whole reason it is a
 * message-side block instead of a system-prompt layer: membership is
 * `bundle(Role) ∪ grants(session)`, so two Project Sessions differing only by a
 * grant compose different bytes here. In the prompt that would have split their
 * Cache Prefix; on the message side it is bought once and invalidates nothing.
 *
 * Always priced, never conditional. Unlike the workspace reminder — which
 * composes null for a healthy workspace — this block is delivered to every
 * Session, because a Session holding no verbs is exactly the one that most
 * needs to be told so.
 */
export const TOOL_SURFACE_REMINDER_ID = "reminder:session-tools";

/** One measured slice of the baseline. */
export interface PromptBaselineSection {
  /**
   * The section id `systemPromptSections` names it by, plus `brief` and
   * `reminder:<name>` for the message-side blocks.
   */
  id: string;
  chars: number;
  /** `ceil(chars / 4)` — an estimate, labeled as one everywhere it renders. */
  tokens: number;
  /** How often these bytes are re-bought. A claim, not a measurement. */
  cacheClass: PromptCacheClass;
  /** Prompt bytes or message bytes — what a change to them would invalidate. */
  placement: PromptCachePlacement;
}

export interface PromptBaselineTotal {
  chars: number;
  tokens: number;
}

export interface PromptBaseline {
  /** The estimate's whole model of tokenization. */
  charsPerToken: number;
  /**
   * Every system-prompt layer in delivery order, then the message-side blocks
   * in the order the first delivered message carries them.
   */
  sections: readonly PromptBaselineSection[];
  /** The assembled system prompt exactly — section separators included. */
  system: PromptBaselineTotal;
  /** The delimited Brief block that opens the first delivered message. */
  brief: PromptBaselineTotal;
  /**
   * The Turn Reminder riding that same message, or a measured zero when the
   * Session's environment has nothing to say. Zero is a real answer here, the
   * same way a null skills index is: a healthy workspace composes no reminder.
   */
  reminder: PromptBaselineTotal;
  /**
   * The Role bundle block riding that same message (VC-162).
   *
   * Its own rollup rather than folded into {@link reminder}, because that field
   * means one specific thing — the workspace-environment fact, whose measured
   * zero for a healthy workspace is an assertion several callers make. Adding
   * bytes to it would have quietly changed what a zero there proves.
   *
   * Never zero in practice: every Session is told what its Role bundle holds,
   * including the Sessions that hold nothing.
   */
  toolSurface: PromptBaselineTotal;
  /**
   * `system + brief + reminder + toolSurface`: everything Volli composes into a fresh
   * Session's context. The provider's first-turn meter also carries tool
   * definitions, the user's own text, the newlines joining the message-side
   * blocks to it, and provider overhead — real costs this breakdown cannot see
   * and does not invent.
   */
  total: PromptBaselineTotal;
}

/**
 * What the baseline is priced from: the prompt's own inputs, plus the two
 * message-side blocks the first delivered message carries.
 *
 * `workspaceEnvironment` is spelled as `SessionRuntimeSpec` spells it, so a
 * caller holding a real spec passes it through unchanged. It is deliberately
 * NOT part of {@link SystemPromptInput} — Lane A made that field unreachable
 * from the prompt (VC-164) — and it arrives here only because the baseline
 * prices what a Session is actually sent, not only what its prompt holds.
 */
export interface PromptBaselineInput extends SystemPromptInput {
  brief: RuntimeBrief;
  workspaceEnvironment?: RuntimeWorkspaceEnvironment | undefined;
}

function measure(text: string): PromptBaselineTotal {
  return {
    chars: text.length,
    tokens: Math.ceil(text.length / PROMPT_BASELINE_CHARS_PER_TOKEN),
  };
}

/** Layers whose inputs are fixed by Role, its bundle and product version. */
const SYSTEM_SECTION_CACHE_CLASS: Readonly<Record<string, PromptCacheClass>> = {
  role: "role-static",
  authority: "role-static",
  workspace: "role-static",
};

/** The prefix `systemPromptSections` gives a resource block's id. */
const RESOURCE_SECTION_PREFIX = "resource:";

/**
 * Whether the actual resource-set shape proves project-wide reuse.
 *
 * Production composes named skill bodies first, then an index built with those
 * names removed. The index is therefore project-static only when it is the
 * entire resource set. The moment another resource is present, both the index
 * bytes and the operating/header decision came from a Session-specific
 * selection. An empty set is conservative too: this shape cannot distinguish a
 * project with no skills from one whose only skills are manual and named by
 * some Sessions, so it claims no cross-Session reuse it cannot prove.
 */
function hasProjectStaticResourceSet(input: SystemPromptInput): boolean {
  const resources = input.promptResources ?? [];
  return resources.length === 1 && resources[0]?.name === SKILLS_INDEX_RESOURCE_NAME;
}

/**
 * What a system-prompt section claims about its own reuse.
 *
 * `operating`, `resources-header`, and every resource block derive their answer
 * from the actual resource-set shape above. Everything unrecognized falls to
 * `session-static`: a new layer under-claims rather than promising a cache read
 * it has not earned, while the pinned section-id test makes the omission visible.
 */
function systemSectionCacheClass(id: string, input: SystemPromptInput): PromptCacheClass {
  const projectStaticResources = hasProjectStaticResourceSet(input);
  if (id === "operating" || id === "resources-header") {
    return projectStaticResources ? "project-static" : "session-static";
  }
  if (id.startsWith(RESOURCE_SECTION_PREFIX)) {
    // A project-static resource set contains exactly the skills index, so every
    // resource section in that shape is the index by construction.
    return projectStaticResources ? "project-static" : "session-static";
  }
  /* v8 ignore next -- fixed section ids are pinned in prompt.test; resource ids returned above. */
  return SYSTEM_SECTION_CACHE_CLASS[id] ?? "session-static";
}

function priced(
  id: string,
  text: string,
  cacheClass: PromptCacheClass,
  placement: PromptCachePlacement,
): PromptBaselineSection {
  const measured = measure(text);
  return { id, chars: measured.chars, tokens: measured.tokens, cacheClass, placement };
}

/**
 * Price one fresh Session's composed prompt, per section.
 *
 * Per-section tokens each round up, so the section column can sum to slightly
 * more than the rollups; `system` is measured on the joined string (separators
 * and all) and is the number to trust.
 */
export function promptBaseline(input: PromptBaselineInput): PromptBaseline {
  const sections = systemPromptSections(input);
  const system = measure(sections.map((section) => section.text).join("\n\n"));
  const briefBlock = composeBriefBlock(input.role, input.brief);
  // The same composers the first message uses, so a block cannot be delivered
  // without being priced: no environment, or a healthy one, composes null and
  // costs a measured nothing.
  const reminderBlock = composeTurnReminderBlock(input.workspaceEnvironment);
  const toolSurfaceBlock = composeToolSurfaceBlock(input.role, input.tools);
  const brief = measure(briefBlock);
  const reminder = measure(reminderBlock ?? "");
  const toolSurface = measure(toolSurfaceBlock);
  return {
    charsPerToken: PROMPT_BASELINE_CHARS_PER_TOKEN,
    sections: [
      ...sections.map((section) =>
        priced(section.id, section.text, systemSectionCacheClass(section.id, input), "prefix"),
      ),
      // Session-static, both of them: composed once from this Session's ticket
      // state and this workspace's measurements, and carried by a message no
      // later turn rewrites.
      priced("brief", briefBlock, "session-static", "message"),
      priced(TOOL_SURFACE_REMINDER_ID, toolSurfaceBlock, "session-static", "message"),
      ...(reminderBlock === null
        ? []
        : [priced(WORKSPACE_ENVIRONMENT_REMINDER_ID, reminderBlock, "session-static", "message")]),
    ],
    system,
    brief,
    reminder,
    toolSurface,
    total: {
      chars: system.chars + brief.chars + reminder.chars + toolSurface.chars,
      tokens: system.tokens + brief.tokens + reminder.tokens + toolSurface.tokens,
    },
  };
}
