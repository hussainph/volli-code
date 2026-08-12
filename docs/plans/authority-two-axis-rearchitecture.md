# Agent authority, rebuilt on two axes

This supersedes the Part I product decision in
`docs/plans/authority-and-runtime-shape.md`. That document's account of what
shipped remains accurate and is worth reading first; what it got wrong is the
conclusion it drew from it.

## Status

Both axes are off. Pi runs at its own defaults: ungated and uncontained.

**The gate is off.** `SessionRuntimeSpec.authority` is optional and the desktop
adapter supplies no Snapshot, so the Pi runtime installs no `beforeToolCall` at
all and the rule pack, the fallback thresholds and the escalation port are never
reached.

**Containment is off.** `executionEnvFactory` now defaults to Pi's own
`NodeExecutionEnv`, so nothing wraps process execution in Seatbelt and nothing
scopes the file tools to the workspace. A Session's commands run as the user
running Volli, with the network reachable and the environment's credentials
intact, and reads and writes outside the workspace succeed. Attachment no longer
fails when `sandbox-exec` is unavailable, because it no longer asks.

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

`tool.not-bundled` is deleted. Pi resolves a tool by name and returns
`Tool X not found` before `beforeToolCall` runs, and the snapshot's tool list
and the registered tool list come from the same constant, so the rule cannot
fire.

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

Policy becomes data: a per-project rule pack and a settings surface, with
defaults, so changing authority does not require shipping a build. The
`AuthoritySnapshot` is persisted at attach, which finally gives `rulePackId` and
`rulePackHash` something to pin — today they are written into a live spec that no
reader ever compares, and `authority.denied` records a cause with no record of
the pack that produced it.

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
7. **Policy as data**, and the persisted snapshot.
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
