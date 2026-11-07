---
name: volli-copy
description: Copy for Volli. Use whenever writing or reviewing any UI text, string, label, accessible name, tooltip/help tag, empty state, error message, PR-facing UI copy, or documentation sentence.
---

# Let controls talk

## 1. Establish what the words can claim

Read the affected UI, command/read model and tests, plus
[DESIGN copy rules](../../../docs/DESIGN.md#copy-and-feedback) and the existing neighbouring
strings. Use `CONTEXT.md` to resolve domain names; code decides current behaviour. Inventory
visible **and accessible** text, menu-model strings, generated plurals, toasts and tooltips.

Name the audience and job. UI copy identifies a thing, action or observed state. Documentation
explains a task; choose a how-to, tutorial, explanation or reference before drafting. PR copy
states changed behaviour and actual evidence, without claiming unverified capabilities.

**Done when:** every string's subject, state, scope and evidence are known. Preserve authored
names/instructions, quoted tool output and backend refusal details; they are not copy to polish.

## 2. Choose the smallest useful form

| Role | Rule |
|---|---|
| Labels / headings | Concrete nouns, sentence case: Trigger, Instructions, Runtime, History. Keep established Session/Workspace/Runner names and proper brands. No terminal period on labels. |
| Actions | Direct verb + object where context needs it: Add server, Clear search, Rename. Save/Cancel inside an already named editor; separate Run from inspection, selection and arming. |
| Empty titles | Short factual reason: No tickets yet, Nothing archived, No MCP servers. Page/Panel retain a reason title; Chat is text-free and Inline is silent. Never call pending or failed empty. |
| Failure titles | Name the failed operation/object: Couldn’t load runs. One real recovery action. Keep diagnostics in closed Details/Copy or support evidence, not the headline. |
| Tooltips / help tags | Name the action/identity or reveal a clipped value, with its real shortcut where applicable. Available on focus as well as hover. No tutorial or displaced explanatory paragraph. |
| Accessible names | Keep visible wording; add only missing context: Arrival → Run {name} on arrival in {column}. Distinguish primary navigation, Rename, Run and Arm, without renaming the heading accidentally. |
| Documentation | Outcome first, then necessary steps; active voice and direct verbs. Address the reader as you. Headings name the topic; each paragraph adds one concrete fact. Cut generic introductions and recaps. |

Treat the control as its explanation. Remove prose that reads back a slider, switch or picker.
The narrow exceptions are an irreversible consequence, a one-line trust boundary, or a blocked
state with one recovery. Necessary qualifiers remain: scope, permission, zone, incomplete
results and unavailable data. Do not move unwanted prose into an information tooltip.

**Done when:** every retained word adds identity, intent, state, a required qualifier or recovery;
no label is explained a second time by its own sentence.

## 3. Check truth, counts and feedback

- Pending uses `Spinner`/`LoadingLabel`, busy/disabled semantics and the existing accessible
  name. No skeletons or Loading… / Saving… punctuation. An action such as Open file… may
  use an ellipsis when another decision follows, not to imply progress.
- Use count-aware singular/plural at 0/1/2/many, including search and hidden/omitted counts.
  Count the actual entity: omitted candidate directories are not known readable skills;
  occurrences include skipped work, which is not a Run. Search over a subset stays qualified.
- Reuse shared number/date/age/duration/effort formatters. Include units for ambiguous values
  and the stored time zone once. Distinguish elapsed wall time from compute time. Do not
  append an English `s` to a translated phrase or fabricate unknown counts/durations.
- Keep state distinctions: pending, successful zero, filtered zero, unavailable, failed and
  retained refresh failure. Keep last-good data during refresh. Reason titles state facts,
  not invitations or apologies.
- Surface every failed **requested** mutation with the operation and one recovery. Never
  announce success on refusal or infer that nothing changed after a partial failure. A
  completed nested mutation is not rolled back by a later program error; careless Retry
  could repeat accepted work. Unrequested background refinements may log and retain fallback.
- A person's deliberate setting or Stop is not a fault. Report what happened, not a judgment
  about a loud theme or low-contrast choice. Move technical measurements to support evidence.
- Tool/activity receipts use verb + object and the observed tense. Started or Delegated
  confirms acceptance, not completion; Clicked confirms dispatched input, not its business
  outcome. Quote actual source/element names rather than generating paraphrases. Ordinary
  detail omits internal tool-policy framing; full output remains available in its audit view.
- Use catalogue display names instead of wire IDs when known; user-facing ticket/Session
  names instead of UUIDs. Preserve a way to reveal needed disambiguation and full values.
  Name link destinations; raw URLs belong in links or actual URL fields/values, not help prose.

**Done when:** interpolations, tense, units and outcomes match the real data; failure and
recovery remain truthful under partial completion, refresh, permission and transport errors.

## 4. Cut banned patterns

| Pattern to remove | Replace with |
|---|---|
| Eyebrows/kickers above a heading, tracked uppercase | One sentence-case heading |
| Explanatory paragraphs under controls; restating the label | The noun label and the control |
| Onboarding-wizard tone: Let’s get started, click below, configure your experience | The actual action or current state |
| Marketing adjectives: Seamlessly, Effortlessly, Powerful, robust, cutting-edge | A specific supported behaviour, or nothing |
| Apologetic/chatty system text: Sorry, Oops, Great job | Observed state and recovery |
| Vague verbs: Manage, Configure, Continue when the consequence is known | Name the operation: Rename, Save, Re-arm |
| Title-Case Sprawl, emoji in authored UI | Sentence case and semantic seam icons |
| Warm-ups, faux insights, dramatic fragments, slogan triads, generic conclusions | Start and end with useful facts |
| Repeated synonym changes for one concept | One established product term |
| Unproved claims: Finished, Scheduled, nothing changed | Stored fact or omitted unknown value |

This applies to product-authored text, not user-authored emoji/names, code values or faithful
quoted output. For longer prose, remove stock praise, filler adverbs and rhetorical setup;
keep technical precision and strong clear sentences. Do not impose a uniform punchy rhythm.

## Worked tightening examples

These are wording examples, not permission to change a current command or product rule.

| Before | After | Why |
|---|---|---|
| When it runs | Trigger | Noun heading |
| What it does | Instructions / Runtime | Separate the two groups |
| Runs only when you start it | Manual only | Factual state; Run remains available |
| Off on this Mac. It runs only when you start it. | Manual only | Remove switch explanation |
| Next run {date} | Next · {date} · {IANA zone} | Include the real zone |
| Available in | Scope | Stable noun |
| From a ticket, the board, or this page. | Omit | Controls already expose those doors |
| No automation matches “{query}”. | No matching automations | Short scoped result |
| Its past Runs stay in history, but this Automation cannot be run again. | Past runs and Sessions stay in history. | Confirmation title already names deletion |
| Project activity | History | Name the destination |
| 1 settings found | 1 setting found | Count-aware singular |

## 5. Check in context

Run `vp run --filter @volli/desktop check:ui-copy` after any renderer-copy change and before
review, with `vp check`. If changing the matcher, run its self-tests too. Reduce fixed
file/rule allowlist ceilings; do not add debt to make new copy pass. The linter skips `.ts`
label maps and many indirect strings, docs, tests and lab fixtures: inspect those manually.
A green linter does not approve eyebrows, misleading counts or inaccessible tooltips.

For UI text, use [volli-design](../volli-design/SKILL.md) and
[verify-volli](../verify-volli/SKILL.md) to inspect narrow panes, long/localised content,
hover/focus, 0/1/many and pending/error states. For docs, verify named controls/commands and
links against the product. For PR wording, separate implementation, test and live evidence.

**Done when:** every changed string passes the truth/voice pass, actual UI context is checked
where affected, and exact lint results and any unverified claims are reported.
