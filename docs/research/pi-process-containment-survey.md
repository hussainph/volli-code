# Process containment in coding harnesses

**Research note — 2026-08-08**

**Question.** Can a local coding harness safely run arbitrary project commands without allowing a model to read or write outside its ticket worktree, use the network, or leave processes behind? This distinguishes four commonly conflated controls.

| Control | What it does | What it does not prove |
| --- | --- | --- |
| `cwd` | Chooses a command's starting directory. | Filesystem confinement; absolute paths, `..`, symlinks, inherited credentials, and child processes remain available. |
| Tool permissions | Ask, allow, or deny a requested tool/command before launch. | That the launched process cannot do something different, including a shell expansion or a child process. |
| OS sandbox | Kernel-enforced filesystem/network policy inherited by the process tree. | That the harness can reliably account for and kill daemonized/re-parented descendants. |
| Container/VM | Runs the work in a separate OS environment, optionally with PID/network namespaces. | Safe egress, credentials, or policy by itself; those still need explicit configuration. |

## Findings by harness

### OpenCode — permission and `cwd`, not containment

OpenCode's current V2 specification explicitly says Bash is **not sandboxed**: the shell retains the host user's filesystem, process, and network authority. It checks an external workdir and makes an advisory scan of command arguments, but calls neither a security boundary. [V2 session spec, pinned `fe82a1b`](https://github.com/anomalyco/opencode/blob/fe82a1b6ca4f535beb973b0867017e3f639f85ed/specs/v2/session.md#L354-L365) and [Bash tool, pinned `fe82a1b`](https://github.com/anomalyco/opencode/blob/fe82a1b6ca4f535beb973b0867017e3f639f85ed/packages/core/src/tool/bash.ts#L62-L152).

Its documented `allow` / `ask` / `deny` permission policy gates tool calls; `external_directory` prompts for access beyond the starting worktree, and Bash patterns can be approved by command text. That is useful consent UX, but it cannot confine an approved shell. [Permissions documentation, pinned `fe82a1b`](https://github.com/anomalyco/opencode/blob/fe82a1b6ca4f535beb973b0867017e3f639f85ed/packages/web/src/content/docs/permissions.mdx#L109-L199).

The legacy shell implementation resolves the requested workdir from the instance directory, then launches a host shell with that `cwd`; it inherits `process.env` plus plugin environment. Cancellation and timeout kill the handle, but the POSIX command is detached. The V2 Bash source still marks process-group cleanup and cross-platform coverage as unproven work, so it is not a descendant-supervision design to borrow. [Shell launch and inherited environment, pinned `fe82a1b`](https://github.com/anomalyco/opencode/blob/fe82a1b6ca4f535beb973b0867017e3f639f85ed/packages/opencode/src/tool/shell.ts#L293-L310) [launch, pinned `fe82a1b`](https://github.com/anomalyco/opencode/blob/fe82a1b6ca4f535beb973b0867017e3f639f85ed/packages/opencode/src/tool/shell.ts#L605-L640) [cancellation, pinned `fe82a1b`](https://github.com/anomalyco/opencode/blob/fe82a1b6ca4f535beb973b0867017e3f639f85ed/packages/opencode/src/tool/shell.ts#L481-L559) [V2 TODO, pinned `fe82a1b`](https://github.com/anomalyco/opencode/blob/fe82a1b6ca4f535beb973b0867017e3f639f85ed/packages/core/src/tool/bash.ts#L66-L77).

**Result:** OpenCode is direct evidence that permissions plus `cwd` are not strict containment. Its official source contains no OpenCode-owned Seatbelt, container, or VM backend for Bash on macOS; do not adopt its model for Session 3.

### Codex CLI — native OS sandbox policy, with deliberately broader defaults

Codex's open source core states that macOS uses `/usr/bin/sandbox-exec`; the resolved Seatbelt policy enforces filesystem read/write roots and network policy. Its `workspace-write` policy keeps `.git`, the resolved worktree `gitdir:`, and `.codex` read-only even within an otherwise writable root. [Codex core README, current main](https://github.com/openai/codex/blob/main/codex-rs/core/README.md#L210-L218).

That is an actual OS boundary, but the standard **workspace-write** product mode is not the Session 3 “no outside reads” policy: Codex documents it as read-anywhere with writes restricted to the workspace and extra supplied roots. [Codex sandboxing documentation](https://openai-codex.mintlify.app/concepts/sandboxing#sandbox-modes). The source documents more exact split filesystem policies: on Linux it selects Bubblewrap when policy needs read-only or denied carve-outs beneath broader roots, and fails unsupported WSL1 sandboxed shell commands rather than running them with that backend. [Codex core README, current main](https://github.com/openai/codex/blob/main/codex-rs/core/README.md#L219-L236).

**Result:** Codex demonstrates a feasible macOS direction for hard access control without Docker, administrator privileges, or a native extension: generate an immutable, deny-by-default Seatbelt profile for each execution policy. It does **not** license copying the permissive read-anywhere default for a ticket-isolated product. The sources reviewed establish access policy, not a guarantee that a harness can enumerate and terminate every daemonized or re-parented descendant after the shell returns.

### Claude Code and Anthropic Sandbox Runtime — the closest reusable model

Claude Code documents an optional Bash sandbox: Seatbelt on macOS and Bubblewrap on Linux/WSL2. The sandbox's filesystem and network restrictions apply to Bash and its subprocesses. A host-side proxy provides its domain allowlist. [Claude Code sandboxing documentation](https://code.claude.com/docs/en/sandboxing#how-it-works).

Its defaults still matter for a strict product boundary: sandboxing is disabled by default, and if enabled but unavailable Claude Code warns and runs commands unsandboxed unless `sandbox.failIfUnavailable` is true. It also explicitly allows an approved unsandboxed escape hatch unless that is disabled. [Claude Code settings](https://code.claude.com/docs/en/settings#sandbox-settings) [Claude Code sandboxing documentation](https://code.claude.com/docs/en/sandboxing#enable-sandboxing). Its documented default read policy is broad (the whole computer except denied paths); writes default to the current directory. Thus strict ticket isolation requires a deny-read policy with an explicit project read allowlist, not merely turning sandboxing on. [Claude Code sandboxing documentation](https://code.claude.com/docs/en/sandboxing#filesystem-isolation).

Anthropic's open-source [Sandbox Runtime](https://github.com/anthropic-experimental/sandbox-runtime) is particularly relevant: it is an arbitrary-process CLI/library that uses Seatbelt on macOS and Bubblewrap on Linux, has allow-only writes and configurable read denies/allow exceptions, and uses a host proxy for network policy. The repository calls it a beta research preview. Pi's own current extension examples include an OS-level sandbox extension built on this runtime. [Pi extension examples, pinned `53fa77c`](https://github.com/earendil-works/pi/blob/53fa77ccd8a279eb87e92294ef3687b03ff80112/packages/coding-agent/examples/extensions/README.md#L13-L28).

**Result:** this is the Session 3 dependency for policy shape (separate read/write allowlists, network proxy, mandatory protected paths, and fail-closed startup). Claude Code documents that its OS sandbox covers Bash only; native file tools are governed separately by permission rules. [Claude Code sandboxing documentation](https://code.claude.com/docs/en/sandboxing#what-sandboxing-does-not-cover). Volli matches that scope: its native file tools retain a component name-check and direct-symlink guard, which rejects direct symlink paths but is not equivalent containment. A worktree writer can still swap a checked component before the host operation opens it; direct-symlink tests compensate for the accepted TOCTOU residual until descriptor-relative no-follow operations harden the boundary.

### Cursor background agents — host separation, not local sandboxing

Cursor documents background agents as running in isolated Ubuntu-based machines in its AWS infrastructure; they clone a repository through the GitHub app and auto-run terminal commands. It also documents that those agents have internet access and explicitly flags exfiltration risk. [Cursor background-agent documentation](https://docs.cursor.com/background-agent).

**Result:** a remote VM removes the agent from a developer's local home directory and gives a real process/environment boundary. It is a different product architecture with repository credential, egress, retention, and provisioning trade-offs; it does not supply a network-disabled local ticket runner.

### Pi — intentionally delegates the boundary

Pi states that it has no built-in restriction for filesystem, process, network, or credentials: it receives the authority of its launching process. Its own recommended stronger patterns are a Gondolin local Linux micro-VM, Docker, or OpenShell. [Pi README, pinned `53fa77c`](https://github.com/earendil-works/pi/blob/53fa77ccd8a279eb87e92294ef3687b03ff80112/README.md#permissions--containerization). The installed Session 3 dependency (`@earendil-works/pi-agent-core` 0.84.1) follows that split: its Bash tool delegates to the supplied `ExecutionEnv`; the default Node environment starts a host shell with a `cwd`, inherited environment, and detached POSIX process, rather than enforcing a sandbox. [Pi 0.84.1 Bash tool source, pinned `53fa77c`](https://github.com/earendil-works/pi/blob/53fa77ccd8a279eb87e92294ef3687b03ff80112/packages/agent/src/harness/tools/bash.ts) [Pi 0.84.1 Node execution environment, pinned `53fa77c`](https://github.com/earendil-works/pi/blob/53fa77ccd8a279eb87e92294ef3687b03ff80112/packages/agent/src/harness/env/nodejs.ts).

**Result:** Session 3 must own the `ExecutionEnv` containment contract. It cannot safely enable Pi's Bash tool by supplying only a ticket `cwd`.

## What is applicable to Volli Session 3

1. **Attach the OS boundary before advertising `execute`.** Build a product-owned process boundary and prepare it once per ticket worktree. If the backend is missing, the profile cannot be built, or capability verification fails, attachment must fail closed; do not let the model discover an unsandboxed fallback through a tool result. This adopts Codex's OS-policy approach and Claude's explicit `failIfUnavailable` option, while avoiding Claude's unsafe default fallback.

2. **Use an immutable, host-built policy outside every writable root.** On macOS, launch the command through Seatbelt with default deny; allow exactly the canonical ticket worktree (read/write), deliberately selected toolchain/runtime paths (read), and a separate scratch/output location (write). Deny network for the first slice. Do not place a profile file, policy cache, or executable helper inside the worktree: an earlier command must not be able to alter the policy used by the next one.

3. **Do not mistake worktree pathname checks for file confinement.** Shell containment does not protect host-side file tools from a race in which a contained process swaps a checked path for a symlink. Session 3 accepts this residual for the native tools' component name-check and direct-symlink guard: direct-symlink rejection tests provide compensating coverage, but do not make that guard equivalent to SRT. Descriptor-relative no-follow operations are the deferred hardening. Claude's Bash-only caveat makes this separation explicit; it is relevant because Volli's file operations are product-owned.

4. **Treat access confinement and lifecycle supervision as separate gates.** Seatbelt makes descendant access inherit the policy, but an unprivileged macOS wrapper alone is not a demonstrated way to reliably find and kill descendants that daemonize, re-parent, or start a new session after the launcher succeeds. OpenCode's source acknowledges this gap. Require concrete abort, timeout, normal-return-background-child, and detached-child tests. If Session 3 requires guaranteed cleanup of arbitrary descendants, use an OS supervision primitive proven for that purpose or move execution into a container/micro-VM. A process group is insufficient evidence.

5. **Keep consent separate from the security property.** Session UI approval and per-command policy can be valuable later, but they are not substitutes for the enforced boundary. This session's strict execute/test slice should first prove a no-egress, worktree-only backend; Auto/Manage policy UX can layer over it later.

## Verdict

No examined local harness solves strict arbitrary-command containment merely with `cwd` or permission prompts. **OpenCode does not attempt it; Pi delegates it; Codex and Claude demonstrate the necessary OS-level pattern on macOS.** A fail-closed Seatbelt process boundary can enforce the filesystem/network half of Session 3's Bash execution without Docker, admin rights, or a native extension. It does not, by itself, prove full descendant cleanup or make guarded host-native file tools race-safe. If those are non-negotiable acceptance criteria for arbitrary local commands, the defensible boundary is a container/micro-VM (or another verified OS-level supervisor), not a `cwd`-scoped Node child process.
