# Per-call authority review (VC-28)

The judge is Pi's configured cloud decision model, reached through the audited
`authority.judge` purpose. No local classifier is used for this purpose. The
existing project Authority policy pins the attachment's posture; no sandbox or
network policy is required.

## Shadow

`observe` attachments review without blocking anything. Enforcing ask-mode
attachments retain their rule-pack behavior while observing the classifier.
Hard refusals are screened first, then file reads and workspace edits skip the
classifier. Other calls, including a whole shell chain, are one review each.

The input is unframed user text and the bare current tool call. Assistant prose,
reasoning, tool results, the Runtime Brief, tool descriptions and activated
resources are excluded. New accepted-command and commandless-input markers retain the separate user
text through compaction, restart and fresh-attachment carry. Authority history
is separate from the bounded model-context carry; oversized authority input
misses closed instead of dropping earlier constraints. Old markers without separable input are
omitted rather than treating host framing as user authority; omitted or malformed
historical input makes automatic review ask instead of approving with partial
constraints.

Secret redaction uses the activity redactor, without truncating command tails.
Uninspectable or oversized requests miss; they never become apparent allowances.
Routed model decisions await a classifier-attributed `authority.judge.audit`
fact. Every final call verdict, including pre-routing misses (`unset`,
`not-opted-in`, `invalid-request`), writes `authority.reviewed` before execution.
A failed review write stops the turn before execution, even in shadow. Missing
carry history is a durable invalid-request miss through recovery and later carry.
The verdict includes probabilities, would-flag, category, message and thresholds;
it does not count as a denial. Shadow flags appear as quiet “Would block”
transcript notices. Audit state never crosses the renderer boundary.

Existing cloud agreements are not silently extended. Settings asks once per
scope/agreement to include authority review, with an explicit disclosure.
Declining leaves that purpose unavailable; accepting records the new opt-in.

## Automatic enforcement

Configure → Authority uses the existing Enforce posture and Automatic review
choice; changes apply to the next attachment. Hard rules are screened ahead of
all overridable rules, including when a shell redirect would otherwise mask a
hard command denial. Reads and realpath-contained workspace edits skip review.
A clean classifier verdict runs the call and resets consecutive refusals. A
flag blocks that one call, records a denial, and tells the agent to find a safer
route without working around the boundary. Three consecutive or twenty total
denials hand back through the existing Ask flow; a one-call allowance grants
only that exact call. An unattended hand-back pauses instead of granting.

Every classifier miss immediately asks, regardless of deterministic soft-rule
allowances: no setup, declined opt-in, timeout, abort, malformed response,
invalid/incomplete input or failed service audit is never automatic approval.
Hard rules cannot be overridden by classifier output or a person's allowance.

Settings → Decision model has one Block reason choice: Utility model (default)
or Risk category. Only a configured utility model is used; unset, failed,
aborted or slow wording falls back to the category. The wording call receives
only the tool name and category, uses reasoning off, an 80-token output budget
and a 1.5-second deadline, and reports successful or failed metered usage even
if the provider finishes late. It never changes permission.

## Calibration and reason choice

Initial thresholds are conservative provisional values, not empirically tuned:
clear authorization and safe-category probability at least 0.95, non-safe risk
mass at most 0.05, category confidence at least 0.8. The durable probabilities
are the input to subsequent dogfooding/calibration; there is no threshold UI.
Messages in shadow are deterministic category/authorization descriptions. A
utility-model wording pass is an enforcement feature, not a second judge and
never a way to overturn a flag. Empirical threshold calibration remains deferred;
this PR supplies the shadow data rather than claiming measured accuracy.

VC-480's future explicit-approval lookup has a marked hook after hard-deny and
skip screening, before classification. This implementation does not consume
its unmerged ledger or add grants.
