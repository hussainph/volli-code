# Pi's slash commands, surveyed and mapped to Volli

**Status:** Investigated; first tranche implemented in VC-114
**Date:** 2026-08-19
**Scope:** The `/` registry in Volli's chat composer, against every command Pi ships

VC-114 reported that the composer's `/` picker "only shows skills" — tested by
looking for `/compact` and an `/init` for AGENTS.md. This survey answers the
question behind the ticket: what does Pi actually ship as slash commands, which
of them can Volli express today, and what is deliberately not adopted.

## Where Pi's commands actually live

Volli pins `@earendil-works/pi-agent-core@0.84.1` (`packages/agent-runtime`).
That package ships **zero built-in slash commands**. What it does ship is the
grammar the composer already mirrors:

- `dist/harness/prompt-templates.js` — the `$1`/`$@`/`$ARGUMENTS` substitution
  grammar, ported verbatim into `@volli/shared`'s `prompt-template.ts` under a
  parity test;
- `dist/harness/skills.js` — the SKILL.md progressive-disclosure ladder.

Every functional command lives one package up, in the `pi` coding-agent TUI
(`packages/coding-agent/src/core/slash-commands.ts` in badlogic/pi-mono), which
Volli does not depend on and never will — the TUI is a terminal app; Volli is a
GUI with its own surfaces. So nothing is "missing from the registry": none of
these commands were ever imported. Each one is a product decision to adopt, and
per `docs/plans/pi-native-ticket-session.md`: *"Harness feature parity is not a
goal. Volli adopts useful jobs and gives them a Volli-native expression."*

## Why the reporter saw only skills

Three separate things produced that impression, and all three are now addressed
or explained:

1. **The verb registry had one entry.** `/compact` (VC-7) was the entire
   functional-command surface, so a `/` picker in a project with no
   `.volli/commands/` files showed one action plus N skills. VC-114 grows the
   registry (below).
2. **`/compact` hides mid-turn by design.** The picker offers a verb only in a
   moment that verb can act in (rewriting context under a running turn
   corrupts it; a control naming a refusal is worse than no control). A test
   done while a turn was live — including one blocked on a question — sees no
   `/compact`. That rule now lives beside each verb as `refusal(moment)` and
   is stated in the row's absence rather than documented away.
3. **`/init` was never Pi's.** It is Claude Code's command (scaffolds
   `CLAUDE.md`). Pi instead **auto-loads** `AGENTS.md`/`CLAUDE.md` as context
   files at startup (`docs/usage.md` → "Context Files") — no scaffold command.
   Volli's runtime deliberately does not auto-load either file today
   (`prompt-baseline.ts`: "Your instructions come from Volli and from the
   user's messages in this session"), so an `/init` would have no substrate to
   act on. Adopting context files — and then a scaffold affordance for them —
   is a separate product decision, listed under Follow-ups.

## The complete inventory

Pi's built-ins, from `packages/coding-agent/src/core/slash-commands.ts`
(cross-checked against `docs/usage.md` and `docs/sessions.md`), with the
Volli disposition. Sources: `pi-mono` main, 2026-08-19.

| Pi command | What Pi does | Volli's expression | Disposition |
| --- | --- | --- | --- |
| `/compact [prompt]` | Summarize older context | Composer verb → `context.compact` (VC-7) | **Adopted** (already) |
| `/copy` | Copy last agent message | Composer verb → clipboard, `lastAssistantText` | **Adopted** (VC-114) |
| `/model [--default] <m>` | Switch model | Composer verb → opens the model pill's own popover | **Adopted** (VC-114) |
| `/reload` | Re-read keybindings/extensions/skills/prompts/themes | Composer verb → re-fetch commands + skills tiers | **Adopted**, narrowed to what Volli reads from disk (VC-114) |
| `/settings` | Open the TUI settings menu | Composer verb → Settings window | **Adopted** (VC-114) |
| `/login <provider>` | Configure provider auth | Composer verb → Settings on Model Access | **Adopted** as a door; the page owns the act (VC-114) |
| `/logout` | Remove provider auth | Model Access → per-account sign-out | **Covered by a Volli surface** — no verb, because logout is per-account and a verb cannot honestly choose one |
| `/thinking <level>` | Set thinking level | The effort chip beside the model pill | **Covered by a Volli surface** |
| `/scoped-models` | Pick models for Ctrl+P cycling | No cycling concept; the pill lists all offerable models | **Not adopted** — TUI-specific |
| `/llama` | Manage llama.cpp router models | Local inference is a Model Access concern | **Not adopted yet** — rides Model Access's local-inference story when that lands |
| `/new` | Start a new session | New Session affordances (Home, shortcuts) | **Covered by a Volli surface**; a verb would need cross-surface routing — listed under Follow-ups only if users ask |
| `/resume` | Pick a previous session | Session history in Home's tab strip; command palette | **Covered by a Volli surface** |
| `/name <name>` | Set session display name | Session titles exist (create-time) | **Needs work first** — no rename Command in the Session vocabulary yet; see Follow-ups |
| `/session` | Show file/ID/tokens/cost | Details surfaces; context-usage pill | **Covered by Volli surfaces**, spread across them |
| `/tree` | Navigate the session tree | Conversation Branches are target language, not yet surfaced | **Needs work first** — branch navigation is its own ticket-sized product decision |
| `/fork` | New session from an earlier message | Conversation Branch semantics | **Needs work first** — same as `/tree` |
| `/clone` | Duplicate active branch to a new session | Durable child Sessions are roadmap | **Needs work first** |
| `/export [file]` | Export session HTML/JSONL | Transcripts are durable local files | **Needs work first** — an export renderer (main-process) does not exist; see Follow-ups |
| `/import <file>` | Resume from a JSONL file | — | **Not adopted** — imports Pi's file format, which the migration plan pins as "bounded diagnostic metadata", never a Volli contract |
| `/share` | Upload private GitHub gist | — | **Not adopted** — a network publish of a transcript is a product decision with privacy weight, not a parity checkbox |
| `/trust` | Save project trust decision | Volli has no per-project trust prompt | **Not adopted** — no such concept; nothing to save |
| `/hotkeys` | Show keyboard shortcuts | Command palette + platform conventions | **Covered by a Volli surface** (loosely) |
| `/changelog` | Show version history | App-level concern | **Not adopted** — app updates are Electron's, not a Session's |
| `/quit` | Quit the TUI | Closing the window / tab | **Not adopted** — a Session does not "quit"; the surface that owns closing is the tab strip |

Beside the built-ins, Pi has three registration sources
(`SlashCommandSource`: `extension` | `prompt` | `skill`). Volli's equivalents
are prompt templates (`.volli/commands/` + global `commands/`, Pi's file
format), skills (`.agents/skills/` + `~/.agents/skills/`, invoked `/name`
rather than Pi's `/skill:name` — a deliberate flattening from VC-5), and
verbs (Volli's own; the analogue of an extension command that closes over app
chrome). Pi has no extension mechanism Volli needs: verbs are registered in
`@volli/shared`'s closed `COMPOSER_VERBS` union, where a caller that performs
one switches on its name and a new verb stops the compiling.

## What VC-114 shipped

The registry went from one verb to six, each wired to a surface that already
existed:

- `/compact` — the act is unchanged (VC-7). Its mid-turn refusal is now
  answered by the client rather than round-tripped to the runtime: a live turn
  is a fact the client already holds, and the words are the same. The runtime
  still owns the refusals only it can see, such as a history with nothing left
  to summarize, which arrive as `false` and hand the draft back.
- `/copy` — `lastAssistantText` (pure, in `chat-plane-model.ts`) → clipboard.
  Offered only when a turn has settled AND said something: mid-turn the newest
  reply is still arriving, and half a sentence under "Copied last reply" is a
  copy that looked right and pasted wrong.
- `/model` — opens the model pill's popover (the pill gained a controlled
  open). Refused mid-turn and on an empty catalog — both halves of the pill's
  own disabled rule, each with its own words.
- `/reload` — re-runs the commands/skills fetch (`usePromptTemplates.reload`),
  which now resolves whether the lists were actually replaced. The success
  toast waits for that answer, and a failed read leaves the working list in
  place rather than emptying the picker.
- `/settings` — `setSettingsOpen(true)`.
- `/login` — `setSettingsOpen(true, "model-access")`; credentials stay where
  CONTEXT.md puts them, in Model Access, never in the transcript.

Design rules the tranche follows (all in `composer-verb.ts`'s header, now
generalized from compact's):

- **Offer = perform, because it is one function.** Each verb carries
  `refusal(moment)`, which returns either null or the sentence naming why not.
  `offeredComposerVerbs` hides every verb whose refusal is non-null, and the
  press toasts that same string — so the list cannot invite something the app
  will refuse, and a refusal cannot be reported as the wrong cause. It is a
  predicate rather than a category (`idle` / `has-reply` / `always`) because a
  category cannot say *why*, and because each verb's precondition is its own:
  `/model` needs a catalog as well as an idle turn, `/reload` needs a project.
  A category would have forced those into the press as a second, drifting copy
  of the rule — which is exactly where the wrong "can't change mid-turn"
  message for an empty catalog came from.
- **The registry is additive by construction.** The act (`chat-plane.tsx`) and
  the glyph (`composer-picker-ui.tsx`) are each a `Record` keyed by the closed
  `ComposerVerbName`, so adding a verb fails to compile at both sites with the
  new name in the error. A `switch` cannot do this in a void-returning handler
  — a missing arm compiles, and the verb is offered and then silently does
  nothing.
- **No silent drops.** A verb owns the whole draft, and words after a verb that
  takes none (`takesInstructions: false`) come back with a toast rather than
  vanishing.
- **Names are reserved.** A template or skill spelled `model`, `settings`,
  `copy`, `reload`, or `login` loses its row — the same visible-cost bargain
  `compact` already made.
- **Every verb gets its glyph** (`composer-picker-ui.tsx`), because the glyph
  names the act, not the category.
- **An act that runs takes the words with it.** The draft clears on every verb
  that acts, not just the two that used to, and comes back — over an empty box
  only — when an act reports it did not happen. A refusal the press can see
  first (trailing words, a moment the verb refuses) never takes them at all.

The offer rule and the grammar are unit-tested in `@volli/shared`; the half
that only a running app can show — that an offered row's press performs, that a
refusal says the right sentence, and that the draft lands where each outcome
promises — is `apps/desktop/e2e/composer-verbs-smoke.mjs`. The press lives in
`.tsx` that the coverage gate deliberately excludes as view glue, so that smoke
is its gate. It submits no turn and costs nothing at a provider.

## Follow-ups this survey surfaces (not in VC-114)

1. **Session rename** (`/name`): needs a rename Command in the Session
   vocabulary (session-engine → RPC → surface) before a verb can carry it.
2. **Branch navigation** (`/tree`, `/fork`, `/clone`): Conversation Branches
   are CONTEXT.md target language with no UI yet; verbs would ride that work,
   and "keep resume, terminal recreation, and history navigation as distinct
   semantics" applies.
3. **Export** (`/export`): a main-process transcript→HTML/JSONL renderer.
   Sharing (`/share`) should be decided with it, separately, for its privacy
   weight.
4. **Context files** (the `/init` question): decide whether Volli auto-loads
   `AGENTS.md`/`CLAUDE.md` the way Pi does. If yes, a scaffold affordance
   becomes meaningful; if no, `/init` stays not-Pi's and not-Volli's.
