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
resources are excluded. New accepted-command markers retain the separate user
text through compaction and restart. Old markers without separable input are
omitted rather than treating host framing as user authority.

Secret redaction uses the activity redactor, without truncating command tails.
Uninspectable or oversized requests miss; they never become apparent allowances.
Routed model decisions await a classifier-attributed `authority.judge.audit`
fact. Every final call verdict, including pre-routing misses (`unset`,
`not-opted-in`, `invalid-request`), writes `authority.reviewed` before execution.
The verdict includes probabilities, would-flag, category, message and thresholds;
it does not count as a denial. Shadow flags appear as quiet “Would block”
transcript notices. Audit state never crosses the renderer boundary.

Existing cloud agreements are not silently extended. Settings asks once per
scope/agreement to include authority review, with an explicit disclosure.
Declining leaves that purpose unavailable; accepting records the new opt-in.

## Calibration and reason choice

Initial thresholds are conservative provisional values, not empirically tuned:
clear authorization and safe-category probability at least 0.95, non-safe risk
mass at most 0.05, category confidence at least 0.8. The durable probabilities
are the input to subsequent dogfooding/calibration; there is no threshold UI.
Messages in shadow are deterministic category/authorization descriptions. A
utility-model wording pass is an enforcement feature, not a second judge and
never a way to overturn a flag.

VC-480's future explicit-approval lookup has a marked hook after hard-deny and
skip screening, before classification. This implementation does not consume
its unmerged ledger or add grants.
