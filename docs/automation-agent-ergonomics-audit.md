# Automation ergonomics audit — VC-329

## Agent invocation

`automation.run` is a control-tier, tool-only verb in the Board (`project`)
Role bundle. It uses the same main-process Run service as manual launches:
a saved definition, one fresh Session, durable Run history, and no ticket move.
Its Automation argument is a saved name or id, not replacement instructions.
Project-local definitions take precedence over same-named global definitions;
ambiguous matches refuse. The runtime call id supplies retry identity.

Ticket and subagent Role bundles do not include this tool. This change does
not expand their authority, change frozen surfaces, or add a shell write door.
A Ticket Session with only `session_start` must not substitute a custom kickoff
when the person asked for a saved Automation. The descriptions now explain the
missing-tool case and direct it to a Board Session or a manual Run.

### Discovery gap

The tool was exposed in its frozen tool array but omitted from CLI discovery
(`listed: false`). It is now listed alongside other tool-only verbs, with a
help page explaining the real door. Shell execution still returns WRONG_DOOR.
Both launch tool descriptions now distinguish saved Runs from custom kickoffs.

This is a plausible contributor to the reported prompt substitution, **not a
proven root cause**: no offending Session transcripts were examined. Likewise,
under-specified Instructions may contribute, but that needs transcript evidence
rather than an assumption about the user's definitions.

A remaining gap is a dedicated read-only Automation catalogue. Currently the
run tool's unknown-name refusal lists available names; it does not provide a
first-class search/inspect operation. Future discovery should expose name/id,
trigger/target, runtime and Instructions without starting a Run.

## Switch and arming

The existing machine-local switch gates scheduled and column-arrival triggers,
not explicit Run requests (including `automation_run`). Agent-triggered Runs
are still recorded as unattended for attention handling; attendance is not this
switch. The UI now calls it **Automatic triggers**, with **Manual only** for off. It
remains separate from column arming. Column bolts are always visible, outline
when unarmed and filled when armed; a muted filled bolt explicitly names
“automatic triggers off”. The arming menu can change the same trigger switch.
No permission or scheduler behavior changes are implied by the copy.

## Authoring assistance

**Draft in chat** hands the current editor fields and available skill names to
a normal durable Board chat using its configured model. The kickoff requests a
self-contained draft, preserves the user's approach, asks for material missing
decisions, and covers success checks, failure handling and reporting. It asks
for proposals only, not execution, file edits, or arming. This is conversation
intent, not a new read-only runtime authority boundary.

The person reviews and copies suggestions back into the editor. Draft
persistence makes leaving the editor non-destructive. There is deliberately no
automatic application of model output, no silent overwrite, and no agent
create/arm grant. Inline structured suggestions with a reviewed Apply action
remain a possible follow-up.

If agent authoring tools are added later, reuse `automations/engine.ts`'s
idempotent create/update commands via `service.ts`; do not duplicate persistence
in `agent-tool-door.ts`. Creation should leave unattended triggers off, with
human review before enablement. Arming (column selection) and enablement
(permission to start unattended work) must remain separate; a schedule has no
column arming at all.

## Validation

- `pnpm typecheck`, `pnpm lint`, design-token checks, and `pnpm build` passed.
- Focused automation/composer tests: 241 passed.
- Desktop coverage with `--maxWorkers=4`: 8,695 passed, 2 skipped;
  the configured coverage gate is 100% across all four metrics. Other
  workspace packages passed their coverage gates in the workspace run.
- The initial unrestricted workspace coverage run failed in the untouched
  activity-island and tab-strip UI suites. Those passed individually and in
  the bounded-worker desktop coverage rerun; the initial failure is not hidden.
- Visual verification used an isolated headless Chrome against the worktree's
  UI lab after the built-in Browser Tab capture timed out. Editor draft restore,
  column arming menus, the creation menu, and cross-column rail choices were
  exercised and captured. The creation menu was widened after the capture
  exposed clipped short names; the final capture asserts that Triage fits.
  Packed-app smoke and provider-backed drafting remain untested.

## Visual evidence

These are real renderer components with lab fixture data, not a live project.
Editor and Lanes use `automation-design-pass`; board and creation use
`ticket-kickoff` with the same saved-automation fixtures installed through
`installFakeApi`; the rail uses `ticket-rail-automations`.

- [Restored editor draft and drafting assistance](assets/vc-329/automation-editor.webp)
- [Column arming menu](assets/vc-329/column-arming.webp)
- [Board bolts at rest](assets/vc-329/board-arming.webp)
- [Create & run menu](assets/vc-329/ticket-composer.webp)
- [Visible cross-column rail choices](assets/vc-329/ticket-rail.webp)
