# Agent authority, rebuilt on two axes

This is the authority plan. It replaced the Part I product decision in
`docs/plans/authority-and-runtime-shape.md`, which has since been retired — what
that document got wrong was the conclusion it drew from the sandbox, not its
account of what shipped. The mechanism it recorded is summarised under "What this
supersedes" below; its Part II and Part III work moved to tickets VC-18 through
VC-21.

## Status

Containment is off. The gate is wired, pinned and durable, and refuses nothing
by default.

**The gate is wired and observing.** Slice 7's minimal cut landed in VC-44:
policy is a per-project `AuthorityPolicy` document in app-owned state (a
`projects.authority_policy` column, migration 025), the desktop adapter builds an
`AuthoritySnapshot` from it at every attach, and the Session Engine records that
Snapshot onto `attachment.opened`. `rulePackId`/`rulePackHash` finally pin
something: an `authority.denied` event carries an `attachmentId`, and the
attachment carries the pack.

**And a person can now change it.** VC-172 added the write half: Configure →
Authority records a project's departures, validated at the door, and the next
attachment resolves and pins them. A Session already running keeps the Snapshot
it opened under — policy is pinned for the life of one attachment, so an edit
reaches the next Session rather than one mid-turn. The write is app-only by
construction: no agent verb projects it, because the agent must not author the
policy that governs it.

The posture is data, with three values. `off` builds no Snapshot, so
`SessionRuntimeSpec.authority` is absent and the Pi runtime installs no
`beforeToolCall` — the explicit bypass, and what every Session ran under before
VC-44. `observe` builds the Snapshot, records it, and still hands the runtime
nothing. `enforce` hands it over and the pack binds.

**`observe` is the default, and the reason is the read rule.** Enforcing the nine
rules today refuses two things the product itself asks for: the skills index
tells a Session to activate a skill by reading its `SKILL.md`, and a
personal-tier skill lives at `<home>/.agents/skills/<slug>/SKILL.md` — outside
every workspace, so `path.outside-workspace` refuses it. A ticket brief's
reference to the Main checkout reads the same way. The same bytes stay readable
through `execute`, because no rule judges command operands, so enforcing would
teach the model to reach for `cat` where `read` was refused. Slice 1 is what
makes `enforce` the right default.

One thing did change for `enforce`: `path.outside-workspace` and
`command.git-escapes-workspace` moved into `OVERRIDABLE_AUTHORITY_RULES`. They
were hard denials because Seatbelt refused them regardless and consent was moot;
with no sandbox a person's "yes" would actually be carried out, and the skills
case above is a read a reasonable person plainly wants.

**Containment is off.** `executionEnvFactory` now defaults to Pi's own
`NodeExecutionEnv`, so nothing wraps process execution in Seatbelt and nothing
scopes the file tools to the workspace. A Session's commands run as the user
running Volli, with the network reachable, and reads and writes outside the
workspace succeed. Attachment no longer fails when `sandbox-exec` is
unavailable, because it no longer asks.

The one thing that did not come off with the sandbox is the child's environment,
though it did loosen. The default env spawns through `unsandboxedEnvironment`:
the host's own `PATH`, `HOME` and `SSH_AUTH_SOCK`, the locale and terminal
variables, and none of the host's credentials. `ScopedExecutionEnv` keeps the
stricter `scopedEnvironment` — `PATH` filtered to system roots, no `HOME` —
because behind Seatbelt that filter is one clause of a boundary. On the default
path it was buying no containment and costing real function: it deleted the
Session's nvm, pyenv and cargo toolchains, and dropping `SSH_AUTH_SOCK` failed
`git push` over an agent. Either way this is hygiene, not a boundary — bash
re-derives `~` from the password database whether or not `HOME` is set, so
`~/.pi/agent/auth.json` was always an ordinary readable file. Only Seatbelt's
`denyRead` ever refused that read.

`ScopedExecutionEnv`, its tests and the `@anthropic-ai/sandbox-runtime`
dependency are kept, and `executionEnvFactory` still accepts an injected
environment — slice 6 rebuilds the capability axis on exactly that. Nothing in
the product supplies one today.

Everything below describes the policy that replaces the deferred one, not
behaviour that runs today.

## The mistake

Part I made one bet: containment is the safety story. Seatbelt denies the
network, strips credentials, scopes writes to the workspace and rejects
symlinks, and from that the document concluded a classifier was unnecessary —
"the categories a classifier is best at are largely unreachable."

That is one dial doing two jobs. Codex and Claude Code both run two independent
axes: a **capability** axis that fixes the blast radius, and a **judgment** axis
that evaluates intent *inside* it. Volli collapsed both onto the workspace
boundary and turned it up. The result is the worst of the trade: the dial that
is tight blocks ordinary work, and the dial that would catch the things that
actually cause harm was never built.

Three facts settle it, none of which Part I recorded:

**Reads are not scoped to the workspace.** The compiled profile is
`(allow file-read*)` globally, then `(deny file-read* (subpath <home>))`, then
`(allow file-read* (subpath <workspace>))`. A shell command reads `/etc`,
`/usr`, `/Library/Keychains`, `/private/var`, `/Volumes/*` and — because they
are not under `homedir()` — **other users' home directories, including their
`.ssh`**. The `read` tool, meanwhile, cannot leave the workspace at all. The
same product has an over-tight rule and an open hole for the same operation,
because two layers enforce it and neither knows about the other.

**Network denial does not close exfiltration.** Everything read enters the
transcript and leaves over the host process's provider connection, which is not
sandboxed and never was. The claim that Seatbelt makes exfiltration unreachable
is false; it makes *direct* egress from the child unreachable.

**The file tools have no kernel behind them.** `read`, `edit` and `write` call
`node:fs` in Electron main. Seatbelt wraps `exec` only. Their sole containment
is a userspace guard that `lstat`s each path component, with a TOCTOU seam
between the check and the open. `<ws>/.volli` is consequently writable from the
shell, since the rule that protects it inspects file-tool writes and redirects
and the sandbox config never denies it.

Once those three are on the table, `classifierModel: null` has no argument left
behind it.

## Axis 1 — Capability

What the environment permits. Kernel-enforced wherever a kernel can see it,
identical for every tool, and declared as data rather than compiled in.

**Read scope becomes one coherent policy for both layers.** Reads are permitted
across the machine except a secrets denylist: every user's home dotfiles,
`~/.ssh`, `~/.aws`, `~/.config`, `~/.pi`, keychain databases, and all other
users' homes outright. This is simultaneously a loosening and a tightening —
the file tools gain a sibling repository, the pnpm store, `/usr/include` and the
project's own toolchain; the shell loses another person's private keys. Reads
are the free tier for both vendors, and they should be here too, but "free" has
to mean the same thing whichever tool asks.

**Write scope becomes `writableRoots`.** The workspace plus whatever a project
declares, minus protected metadata carved out of every root: `.git/hooks`,
`.git/config`, `.gitmodules`, `.volli/`. Codex's habit of carving the same paths
out of every writable root is the right shape, and the carve-out must hold at
the kernel *and* in the file tools, which is what closes the `.volli` gap.

**Network becomes an allowlist.** SRT already ships a proxy that allowlists
domains; today it is handed an empty list and denies everything. A default set —
the package registries, `github.com`, `api.github.com`, documentation hosts —
plus per-project additions, replaces `deniedDomains: ["*"]`. A coding agent
whose unit of work is "a ticket worktree that becomes a pull request" cannot do
its job without this, and every workaround for its absence is worse than the
allowlist.

**Credentials stay out of the sandbox.** Opening egress does not mean handing
the child a token. Pushes and remote reads go through a `volli` CLI verb over
the existing socket, so Volli holds the credential and the agent asks for the
operation. The child environment stays sanitized.

**The file tools get a real boundary.** Either they route through the same
contained execution path as the shell, or the guard is rewritten to open a file
descriptor once and operate on it, closing the TOCTOU seam. Whichever, the
answer must be one enforcement layer with one policy, not two that disagree.

## Axis 2 — Judgment

What is permitted *within* the radius. Three tiers, Anthropic's shape.

**Tier 1 — evaluated by nothing.** Reads, search, code navigation. Non-state
modifying, so there is nothing for a judgment layer to add. This is where the
latency budget is protected.

**Tier 2 — evaluated by nothing, inside the radius.** File writes and edits
within `writableRoots`. Anthropic justifies skipping the classifier here on the
grounds that writes are reviewable via version control. Volli can do better than
justify it: it owns the worktree, so it takes a **pre-image commit** of dirty
work before the first edit of a Session. That converts "reviewable in principle"
into "recoverable in fact", and it is the single best pattern in the original
survey. It also retires the strangest asymmetry in the current pack —
`command.git-discards-work` is main-checkout only, so `git reset --hard` and
`git clean -fd` are permitted in exactly the tree that holds hours of the
agent's own uncommitted work.

**Tier 3 — classified.** Process execution, network requests, anything outside
the first two tiers. Two stages: a fast single-token yes/no over every call, and
a chain-of-thought pass only on what the first stage flags. Reasoning-blind by
construction — the classifier sees user messages and tool calls, never the
model's own reasoning and never tool output, because that stripping is what
makes an injection have to beat two independent layers instead of talking its
way past one.

**The input layer.** A probe over tool *output* before it enters context.
Volli's realistic attack is a poisoned README, dependency, or issue body in a
repository the agent was asked to work on, and every action such an injection
would request is *inside* the blast radius, where Seatbelt has nothing to say.
Part I stated plainly that nothing screens injection. That is the gap this
closes, and it is the one gap the capability axis cannot touch.

## What happens to the rule pack

It survives, shrinks, and changes job. It stops being the safety story and
becomes the deterministic fast path in front of Tier 3: the categories that need
no model because the answer never varies — persistence (`launchctl`, `crontab`),
platform weakening (`csrutil`, `spctl`, `sudo`), TLS weakening. Those are cheap,
exact, and a classifier judging them would be waste.

Everything ambiguous goes to the classifier, which is also the honest answer to
the lexer. The vendored shell lexer does not handle `eval`, `base64`, command
substitution, `xargs`, or `echo '…' | sh`; every `command.*` rule is bypassable
through any of them. As a layer beneath something that judges real-world impact
that is fine. As the top of the stack it is not, and it currently is.

`tool.not-bundled` **is deleted** — done in VC-3, ahead of the rest of this
plan, because the rule was a day-one breakage for anything that wired a
Snapshot. The pack is nine rules and `BUILTIN_RULE_PACK_HASH` moved from
`d5e3dd88` to `dca89a93`.

The reason given here was half true when it was written, and VC-3's first job
was to make the other half true. Pi does resolve a tool by name and return
`Tool X not found` before `beforeToolCall` runs — verified in
`prepareToolCall`, which looks the tool up and returns early. But the snapshot's
tool list and the registered tool list did **not** come from the same constant:
they were two fields kept equal by whoever built the spec, and only a test
fixture ever did. Worse, `AuthoritySnapshot.tools` was typed `CodingToolId[]`,
so it could not name `ask_user`, `web_fetch` or `web_search` at all — the three
tools a Session is actually offered beside the bundle. The rule would have
refused every one of them on the first day a Snapshot existed.

So the deletion rides one addition: `sessionToolBindings` / `sessionToolIds` in
`@volli/shared` is the single derivation of a Session's Agent Tool Surface, and
both the Pi tool array and the Snapshot's list are built from it. The rule then
had no call left it could reach. Availability is the enforcement, which is what
`CONTEXT.md` already says the Agent Tool Surface *is*.

One consequence to carry forward: nothing in the pack now judges tool identity.
A later per-call refusal over a tool the Session *does* hold — a revoked grant
(VC-44), a Role-scoped control verb (VC-162), a foreign tool admitted through
the External Agent Surface (VC-8) — is a different question and takes a new rule
id, so the two stay countable apart in the denial ledger.

## Denial semantics

Four changes, all of them things both vendors do and Volli does not.

**A denial gets a one-step recovery.** Codex's `/approve` covers one recent
denied action and permits one retry. Volli requires three consecutive denials
before it asks anything, which means the friction is paid three times before the
user is even offered the chance to relieve it.

**A denial stops coaching the workaround.** The current reasons suggest
alternatives — *"Read configuration with `git config --list`"* — while nothing
memoizes the denied call and nothing prevents a rephrasing. Both vendors instruct
the model not to pursue the same outcome via workaround, indirect execution, or
policy circumvention, and to continue only with a materially safer alternative.
That instruction is a one-line change with more effect than most of the rule
pack.

**Headless terminates.** Anthropic ends the session rather than asking when
nobody is watching. Volli's fallback opens a durable question that, in an
unattended Session, no one will ever answer.

**The thresholds get stated honestly.** `sessionDenials: 20` is not a line, it
is a moving interval — the trip re-bases to `sessionDenials + 20` after every
ask — and `consecutiveDenials` resets after any ask regardless of the answer.
Either behaviour may be right; neither is what the field names say, and Part I
described them as Anthropic's published defaults while implementing something
else.

## What becomes durable

Policy becomes data: a per-project document with defaults, so changing authority
does not require shipping a build. The `AuthoritySnapshot` is persisted at
attach, which finally gives `rulePackId` and `rulePackHash` something to pin —
they used to be written into a live spec that no reader ever compared, while
`authority.denied` recorded a cause with no record of the pack that produced it.

VC-44 landed the document, the store and the persisted Snapshot. One thing it
deliberately did not do, and one it left owing.

The **rule pack stays compiled**: what became data is the posture, the judge and
the per-actor policy, not the rules, because rules-as-data needs a rule language
before it needs a store.

The **settings surface** was the thing owed, and VC-172 shipped it: Configure →
Authority writes a project's departures through `volli:project-authority-policy`,
and `updateProjectAuthorityPolicy` is the write `getProjectAuthorityPolicy` had
been missing since migration 025. Two properties are load-bearing and are held
by tests rather than by intent:

- **Departures, never the resolved document.** The column, the `Project` field
  the renderer edits, and the IPC payload all carry only what a project
  disagreed with, so tightening a built-in default still reaches every project
  that never disagreed. An override that states nothing is stored as `NULL`, so
  "reverted the last departure" and "never spoke" are the same bytes.
- **The agent cannot write it.** There is no `volli authority set`, and there
  cannot be one: writing the policy that governs a Session is control tier, and
  `verbTier` refuses a `cli` access mode on a control-tier verb outright. The
  write is an app-only IPC channel with no verb behind it. Reads are a different
  question — `volli authority defaults|effective` stays scoped as a
  nice-to-have, and stays legitimate on the socket, because reading a policy is
  not authoring one.

Validation splits along the same seam. `resolveAuthorityPolicy` is total and
degrades a bad document to the defaults, because it runs where a throw costs a
Session its attachment; `validateAuthorityPolicyOverride` refuses at the write,
where a person is present to be told. The difference that matters is an unknown
key: the read path drops it silently, which is indistinguishable from a project
that never spoke, so the write path is the only place a typo can be caught.

Still not tamper-proof, and the plan should not pretend otherwise. A Session's
`execute` still reaches `volli.db` through an ordinary shell command until slice
2 lands `writableRoots`. What the surface buys is that policy has a door, and
that the door is not one the agent can open.

## Slices

Each is independently shippable and independently valuable.

1. **One read policy, both layers.** Secrets denylist; file tools gain
   out-of-workspace reads. No new risk while egress is still denied.
2. **Writable roots and the metadata carve-out.** Closes `.volli`; makes write
   scope declarable.
3. **Pre-image commit, and `git-discards-work` in every location.**
4. **Denial semantics**: one-step override, the no-workaround instruction,
   headless termination, honest threshold names.
5. **The injection probe** over tool output.
6. **Network allowlist and the Tier 3 classifier, together.** Never separately:
   the moment egress opens, the argument for no classifier expires.
7. **Policy as data**, and the persisted snapshot. *(Minimal cut landed in
   VC-44: the policy document, the app-owned store, the Snapshot built at attach
   and recorded on the attachment, and `observe` as the day-one posture. VC-172
   added the write — Configure → Authority, an app-only IPC channel, and a
   rejecting validator — so a project's departures are reachable through the
   product. Still open: the CLI inspection READS, and the rule pack itself
   becoming data.)*
8. **The file-tool boundary** — one enforcement layer, TOCTOU seam closed.

## What this supersedes

Part I's "Why no classifier yet", its "Deliberately not in the first pass" list,
and the Role-policy section, which is folded into slices 2 and 3. The shipped
mechanism — `beforeToolCall`, the pure `evaluate`, the durable `authority.denied`
event and its projection, the escalation port and the interaction channel — is
all kept. It is the policy the mechanism carries that changes, not the mechanism.

The open work items at the end of Part I are re-scoped by this: the escalation
smoke trips the policy with symlinks pointing outside the tree, which is exactly
the read rule slice 1 changes, so that test needs a different trip mechanism
before slice 1 lands.

## Research record

Carried from the retired plan, which held the sources for this line of work.

- <https://claude.com/blog/auto-mode-default-in-claude-code> — the default-mode
  change, its approval-rate reasoning, the classifier's categories and the
  fallback thresholds. `docs/research/claude-code-auto-mode-semantics.md` holds
  the full semantics, including why the 93% and 97% approval figures are both
  real and five months apart.
- `czottmann/pi-automode` at `bd82e29e` — evaluated and rejected as a
  dependency; its deterministic layer is the vendoring candidate.
- Claude Code permission modes, `PreToolUse` hooks and `canUseTool`; the
  Apache-2.0 `@anthropic-ai/sandbox-runtime`, already a direct dependency.
- OpenAI Codex CLI — `SandboxPolicy` × `AskForApproval`, and protected metadata
  paths carved from writable roots.
- Goose, Aider and OpenHands — respectively the granularity failure mode, the
  dirty-work pre-image commit, and model-self-reported risk.
