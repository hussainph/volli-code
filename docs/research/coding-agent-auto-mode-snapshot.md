# Coding-agent auto modes: quick provider snapshot

**Date:** 2026-08-18  
**Scope:** Lightweight web search and a few first-party docs; this is not a deep audit.

## Short version

“Auto mode” is not one implementation pattern:

1. **Anthropic** uses a model-based safety reviewer to replace many manual approval decisions.
2. **OpenAI Codex** composes a filesystem/network sandbox with an approval policy; `--full-auto` is a bounded preset.
3. **Gemini CLI** uses a deterministic, priority-ordered policy engine with approval modes.
4. **GitHub Copilot CLI** uses “autopilot” primarily as a continuation loop; permissions remain a separate concern.

## Provider snapshot

| Provider | Mechanism | Important guardrail |
| --- | --- | --- |
| Anthropic / Claude Code | `auto` mode delegates action approval to a second classifier model. The engineering write-up describes an input-layer prompt-injection probe and an output-layer transcript classifier; the classifier sees user messages and tool calls, not assistant prose or tool outputs. | It is positioned between manual approval and `bypassPermissions`; protected paths, explicit ask rules, and user-interaction tools can still require intervention. |
| OpenAI / Codex | `--full-auto` is documented as `workspace-write` sandboxing plus `on-request` approvals. The sandbox constrains writes and normally disables network access; a separate approval policy controls escalation. | Capability boundary and consent are separate axes. `--yolo` removes both sandbox and prompts and is explicitly the unsafe option. |
| Google / Gemini CLI | TOML policy rules return `allow`, `deny`, or `ask_user`; highest priority wins. Rules can be scoped to `default`, `autoEdit`, `plan`, or `yolo`. | `deny` can remove a tool from the model’s available options; non-interactive `ask_user` is treated as `deny`. |
| GitHub / Copilot CLI | `autopilot` keeps the agent taking successive model turns until completion, failure, interruption, or a continuation cap. | Full permissions are separate (`--allow-all`/`--yolo`); with limited permissions, requests needing approval are denied. `--max-autopilot-continues` limits runaway loops. |

## Useful entry points

- [Claude Code permission modes](https://code.claude.com/docs/en/permission-modes.md)
- [Anthropic: How we built Claude Code auto mode](https://www.anthropic.com/engineering/claude-code-auto-mode)
- [Codex sandbox and approvals](https://github.com/openai/codex/blob/13c42a077c88a0d04ae7680a9891d2daf4558577/docs/sandbox.md)
- [Gemini CLI policy engine](https://github.com/google-gemini/gemini-cli/blob/main/docs/reference/policy-engine.md)
- [GitHub Copilot CLI autopilot](https://docs.github.com/en/copilot/concepts/agents/copilot-cli/autopilot)

The OpenAI developer-doc URLs found in search redirected with HTTP 308 in this session, so the
Codex entry above is the official repository’s pinned documentation snapshot.

## Design takeaway

For a coding agent, keep these controls explicit rather than naming all of them “auto”:

- **Continuation:** may the model start another turn without the user?
- **Approval:** may a tool call run without a human decision?
- **Capability:** what filesystem, network, and process authority does the tool have?
- **Safety review:** is a separate policy model or deterministic rule set allowed to veto it?

The providers combine these axes differently; conflating them makes an “autonomous” mode harder
to reason about and audit.
