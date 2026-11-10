# Volli

Domain glossary; linked code and tests establish current behavior. **Planned** marks a concept or extension without a complete implementation. Each term has a stable anchor.

## Language

- <a id="volli-local"></a> **Volli Local** — Permanent free signed-out operation without a network requirement; SQLite today, embedded Convex planned ([launch deployment](packages/shared/src/account.ts#L124)).
- <a id="workspace"></a> **Workspace** — Team container for projects, Members and policy; not a checkout or Ticket view ([Workspace API](convex/functions/workspaces.ts)).
- <a id="member"></a> **Member** — A person's membership and role in one Workspace, independently suspendable ([membership rules](packages/shared/src/cloud/members.ts)).
- <a id="runner"></a> **Runner** — Owner-linked machine running Session tools and Pi, connected outbound to the backend ([runner vocabulary](packages/shared/src/cloud/runners.ts), [headless entry](apps/runner/src/commands/run.ts)).
- <a id="volli-cloud-runner"></a> **Volli Cloud runner** — Planned disposable Volli-managed Runner; `cloud` is already a reserved Runner kind ([Runner kinds](packages/shared/src/cloud/runners.ts#L29)).
- <a id="place"></a> **Place** — The Runner a Session runs on, presented with its availability ([RunnerPlace](packages/shared/src/cloud/place.ts)).
- <a id="working-copy"></a> **Working copy** — Checkout a Session works in: ticket worktree or main checkout, distinct from its Runner ([working-copy vocabulary](packages/shared/src/working-copy.ts)).
- <a id="retry-buffer"></a> **Retry buffer** — Runner-local Session ledger facts above the backend-accepted cursor, drained in order without blocking the agent ([fact drain](packages/host-core/src/cloud-runner/drain.ts)).
- <a id="client"></a> **Client** — A projection reader and command sender, not the authority over durable Session facts ([Session client](packages/session-presentation/src/client.ts)).
- <a id="model-gateway"></a> **Model gateway** — Backend-key inference relay using short-lived per-Session grants; machine-local subscriptions bypass it ([gateway contract](packages/shared/src/cloud/gateway.ts)).
- <a id="runner-token"></a> **Runner token** — Short-lived scoped Runner credential, distinct from its long-lived refresh credential ([token contract](packages/shared/src/cloud/runners.ts)).
- <a id="refresh-credential"></a> **Refresh credential** — Linked Runner's long-lived secret, rotated whenever exchanged for a Runner token ([link](packages/host-core/src/cloud-runner/link.ts), [exchange](packages/host-core/src/cloud-runner/token-source.ts)).
- <a id="environment-recipe"></a> **Environment recipe** — Repository `.agents/setup` and `.agents/resume` scripts preparing a Runner's Working copy ([recipe vocabulary](packages/shared/src/environment-recipe.ts)).
- <a id="config-level"></a> **Config level** — Personal, Workspace, project or repo configuration, with policy above them; each surface declares supported levels and precedence ([resolution](packages/shared/src/config-resolution.ts)).
- <a id="needs-you-inbox"></a> **Needs-you inbox** — Planned cross-Workspace list of one person's unresolved Attention items; item storage and rules exist ([attention vocabulary](packages/shared/src/cloud/attention.ts)).
- <a id="retired-terms"></a> **Retired terms** — Host/Worker, Host link/protocol, Execution venue, checkout lease/epoch, Workspace epoch and checkpoint ref name the superseded host model, not Runner architecture ([legacy links](packages/shared/src/remote-hosts.ts), [legacy fences](packages/host-core/src/db/cloud-identity-migration.ts)).

## Board and files

- <a id="project"></a> **Project** — A tracked codebase with a name, path and ticket prefix; the user-facing name for a project rail entry ([Project](packages/shared/src/project-identity.ts#L24)).
- <a id="ticket"></a> **Ticket** — Board card carrying scope, status and Working-copy identity; moving it is distinct from starting a Session ([Ticket](packages/shared/src/ticket.ts#L147)).
- <a id="ticket-body"></a> **Ticket Body** — Ticket's canonical Markdown scope, stored on the Ticket rather than as an Artifact ([Ticket.body](packages/shared/src/ticket.ts#L160)).
- <a id="runtime-brief"></a> **Runtime Brief** — Agent-ready Ticket/context projection delivered at Session launch, not canonical Ticket content ([RuntimeBrief](packages/shared/src/agent-runtime.ts#L310)).
- <a id="dangling-reference"></a> **Dangling Reference** — File reference that no longer resolves; preserved as plain text rather than silently rewritten ([renderFileRefChips](apps/desktop/src/renderer/src/editor/file-refs.ts)).
- <a id="ticket-id"></a> **Ticket ID** — Opaque permanent UUID, never the human-facing handle ([Ticket.id](packages/shared/src/ticket.ts#L147)).
- <a id="display-id"></a> **Display ID** — Project-unique `<PREFIX>-<number>` handle used in copy, branches and CLI, not record identity ([displayTicketId](packages/shared/src/ticket.ts#L228)).
- <a id="label"></a> **Label** — Project-scoped named Ticket label, optionally carrying a stored color ([Label](packages/shared/src/label.ts)).
- <a id="ticket-event"></a> **Ticket event** — Append-only planner fact, distinct from a Session's conversation ledger ([TicketEvent](packages/shared/src/ticket-events.ts)).
- <a id="ticket-signal"></a> **Ticket Signal** — Typed verdict recorded as a `signaled` Ticket event; signals do not move cards ([signal vocabulary](packages/shared/src/ticket-events.ts)).
- <a id="actor"></a> **Actor** — Attribution derived at the mutation door: `user`, `session`, `automation` or `unauthenticated` ([TicketEventActor](packages/shared/src/ticket-events.ts)).
- <a id="deliberate-move"></a> **Deliberate move** — Explicit board move, whether human drag or CLI command, distinct from lifecycle automation ([move commands](packages/host-core/src/board/commands.ts#L307)).
- <a id="ticket-worktree"></a> **Ticket worktree** — Isolated ticket checkout whose recorded branch and path survive title changes ([branch identity](packages/shared/src/ticket-branch.ts), [location resolution](packages/host-core/src/session-runtime/location.ts)).
- <a id="main-checkout"></a> **Main checkout** — Project's original working tree; Board Sessions and worktree-opt-out tickets run here ([WorkingCopyKind](packages/shared/src/working-copy.ts#L34)).
- <a id="artifact"></a> **Artifact** — Reusable project file under `.volli/artifacts/`, resolved from the main checkout ([artifact paths](packages/shared/src/file-ref.ts#L35)).
- <a id="attachment"></a> **Attachment** — User-supplied file linked to a Ticket or Session; URL-reference attachments are planned, not implemented ([BlobLink](packages/shared/src/blob.ts#L52)).
- <a id="change-set"></a> **Change Set** — Ticket's committed and uncommitted source changes against its base branch ([ChangeSetSnapshot](packages/shared/src/change-set.ts)).

## Surfaces

- <a id="ticket-view"></a> **Ticket view** — Expanded Ticket surface containing Body, Sessions, files, diffs and rail; formerly “Ticket workspace” ([TicketDetail](apps/desktop/src/renderer/src/components/ticket/ticket-detail.tsx)).
- <a id="home"></a> **Home** — Project surface with a permanent Board tab beside project Sessions, files and Browser Tabs ([Home tabs](apps/desktop/src/renderer/src/components/home/home-tabs.ts)).
- <a id="project-files"></a> **Project Files** — Main-checkout files browsed in Home's rail and opened as tabs ([file workspace](packages/shared/src/file-workspace.ts), [Home navigator](apps/desktop/src/renderer/src/components/home/home-files-panel.tsx)).
- <a id="ticket-files"></a> **Ticket Files** — Files browsed within one Ticket's checkout, alongside references and attachments ([Ticket navigator](apps/desktop/src/renderer/src/components/ticket/ticket-files-panel.tsx)).
- <a id="tab-group"></a> **Tab group** — Surface-local split tree of at least two Panes, represented by one top-strip chip ([SplitViewGroup](packages/shared/src/split-view.ts#L84)).
- <a id="split-view"></a> **Split view** — Side-by-side or stacked arrangement displayed by a Tab group ([SplitViewState](packages/shared/src/split-view.ts#L86)).
- <a id="pane"></a> **Pane** — Tab-stack cell of a Split view, with one front tab; not a terminal shell pane ([SplitViewPane](packages/shared/src/split-view.ts#L62)).
- <a id="drop-zone"></a> **Drop zone** — Pane center for joining its stack, or edge for splitting; cross-surface payloads are rejected ([SplitDropZone](apps/desktop/src/renderer/src/components/split/split-drop.ts)).
- <a id="split-tab"></a> **Split Tab** — One terminal tab containing several independently owned shell panes; distinct from surface-level Split view ([SessionSplit](apps/desktop/src/renderer/src/stores/sessions.ts)).
- <a id="chat-draft"></a> **Chat Draft** — Unsent chat with a reserved Session identity but no durable Session yet ([ProvisionalChatDraft](apps/desktop/src/renderer/src/stores/chat-drafts.ts#L114)).
- <a id="promotion"></a> **Promotion** — Idempotent first-send handoff from Chat Draft to durable Session, retaining its identity and staged attachments ([promoteChatSession](apps/desktop/src/renderer/src/stores/chat-sessions.ts#L676)).
- <a id="unread"></a> **Unread** — Whether a Session has unseen work, independent of activity or Attention ([read-state rules](packages/shared/src/session-read.ts)).
- <a id="read-receipt"></a> **Read receipt** — Durable per-Session unread stamp stored beside, never inside, Session history ([SessionReadState](packages/shared/src/session-read.ts#L20)).
- <a id="held-order"></a> **Held order** — Stable listing order that floats new questions and turns, not every activity update ([order rules](packages/shared/src/session-order.ts)).
- <a id="session-peek"></a> **Session peek** — On-demand read of recent conversation and its open question, without adopting a live stream ([peek content](packages/shared/src/session-peek.ts)).

## Sessions

- <a id="session"></a> **Session** — Durable conversation identity and ordered history, independent of executors, processes and views ([Session](packages/shared/src/session-ledger.ts#L46)).
- <a id="session-role"></a> **Session Role** — Stored `project`, `ticket` or `subagent` scope determining identity, context and tool bundle ([roles](packages/shared/src/agent-runtime.ts#L56), [bundles](packages/shared/src/agent-tool-surface.ts)).
- <a id="board-session"></a> **Board Session** — Role `project`: ticketless Session working from the main checkout ([ProjectRuntimeIdentity](packages/shared/src/agent-runtime.ts#L207)).
- <a id="ticket-session"></a> **Ticket Session** — Role `ticket`: Session with explicit Ticket and Working-copy context ([TicketRuntimeIdentity](packages/shared/src/agent-runtime.ts#L201)).
- <a id="subagent-session"></a> **Subagent Session** — Role `subagent`: durable bounded helper carrying its parent and inherited Ticket, not a hidden Thread ([SubagentRuntimeIdentity](packages/shared/src/agent-runtime.ts#L222)).
- <a id="authority-policy"></a> **Authority Policy** — App-owned per-project actor access, transcript disclosure, watch kinds and delegation budget policy ([AuthorityPolicy](packages/shared/src/authority-config.ts)).
- <a id="session-event"></a> **Session Event** — Immutable ledger fact ordered by per-Session sequence, not timestamps ([SessionEvent](packages/shared/src/session-ledger.ts#L972)).
- <a id="session-semantic-fact"></a> **Session Semantic Fact** — Product-owned identity, lifecycle, content or control meaning; not presentation labels or raw provider data ([observation translation](packages/session-engine/src/observation-translation.ts)).
- <a id="agent-thread"></a> **Agent Thread** — Conversation lane inside a Session; currently one derived root Thread ([sessionRootThreadId](packages/session-engine/src/observation-translation.ts#L61)).
- <a id="conversation-branch"></a> **Conversation Branch** — Transcript lineage inside a Thread; currently one main Branch, with edit-created branches planned ([sessionMainBranchId](packages/session-engine/src/observation-translation.ts#L65)).
- <a id="generation-attempt"></a> **Generation Attempt** — Transcript attempt identity; sibling attempts for regeneration are planned ([attemptId](packages/session-engine/src/transcript-artifacts.ts#L6)).
- <a id="thread-binding"></a> **Thread Binding** — Planned durable Thread-to-attachment association; current live bindings are Session-scoped ([OpenNativeBinding](packages/session-engine/src/session-runtime.ts#L687)).
- <a id="session-attachment"></a> **Session Attachment** — Historical Session/executor association carrying runtime identity, recovery reference and Runner provenance ([SessionAttachment](packages/shared/src/session-ledger.ts#L335)).
- <a id="command"></a> **Command** — Durable explicit intent recorded before delivery; not proof that an executor accepted work ([SessionCommand](packages/shared/src/session-ledger.ts#L1344)).
- <a id="receipt"></a> **Receipt** — Durable Command outcome: accepted, rejected, completed or unreconciled ([CommandReceipt](packages/shared/src/session-ledger.ts#L1406)).
- <a id="unreconciled"></a> **unreconciled** — Receipt status meaning delivery is unconfirmed, neither accepted nor rejected; never latch it as delivered ([receipt status](packages/shared/src/session-ledger.ts#L1388), [delivery interpretation](packages/session-presentation/src/client.ts)).
- <a id="session-engine"></a> **Session Engine** — Runtime/UI-independent owner of Session commands, events, projections and storage contract ([SessionEngine](packages/session-engine/src/session-engine.ts#L121)).
- <a id="attention"></a> **Attention** — Reconstructible committed-fact projection identifying needed input or recovery, never inferred from silence ([SessionAttentionProjection](packages/shared/src/session-ledger.ts#L1550)).
- <a id="session-presentation-contract"></a> **Session Presentation Contract** — Framework-neutral projection of Session facts into client-facing meaning, without parsing native provider protocols ([presentation boundary](packages/session-presentation/src/index.ts)).
- <a id="session-surface-model"></a> **Session Surface Model** — Portable transcript, attention, controls and live state a client renders ([ChatSessionSlice](packages/session-presentation/src/client.ts#L83), [presentation projection](packages/shared/src/session-event-codec.ts#L869)).
- <a id="scheduled-resume"></a> **Scheduled Resume** — Person-chosen retry after a provider allowance resets, recorded through schedule/cancel/settle commands ([resume rules](packages/shared/src/scheduled-resume.ts)).
- <a id="restart-resume"></a> **Restart Resume** — One guarded continuation of a process-lost turn through ordinary retry, without resending the person's message ([recovery verdict](packages/session-engine/src/restart-resume.ts)).
- <a id="interrupted"></a> **`interrupted`** — Listing state for an interrupted latest turn explained by active failure Attention, until work resumes ([listing activity](packages/shared/src/session-listing-activity.ts)).

## Interactions and wakes

- <a id="sessioninteraction"></a> **SessionInteraction** — Durable question or permission awaiting an answer or cancellation ([SessionInteraction](packages/shared/src/session-ledger.ts#L201)).
- <a id="sessioninteractionprompt"></a> **SessionInteractionPrompt** — One question with options, selection rules and optional free-text input ([SessionInteractionPrompt](packages/shared/src/session-ledger.ts#L182)).
- <a id="sessioninteractionoption"></a> **SessionInteractionOption** — One declared choice with runtime-correlated id and label ([SessionInteractionOption](packages/shared/src/session-ledger.ts#L110)).
- <a id="sessioninteractionanswer"></a> **SessionInteractionAnswer** — One prompt's chosen option ids and permitted free text ([SessionInteractionAnswer](packages/shared/src/session-ledger.ts#L193)).
- <a id="sessioninteractionresolution"></a> **SessionInteractionResolution** — Whole decision on an interaction, carrying its per-prompt answers ([SessionInteractionResolution](packages/shared/src/session-ledger.ts#L220)).
- <a id="sessioninteractioncancelreason"></a> **SessionInteractionCancelReason** — `abandoned`, `superseded` or `withdrawn`; cancellation is not a refusal or answer ([cancel reasons](packages/shared/src/session-ledger.ts#L227)).
- <a id="sessioninteractionprojection"></a> **SessionInteractionProjection** — Rebuilt waiting/resolved interaction state and its recorded resolutions ([projection](packages/shared/src/session-ledger.ts#L1555)).
- <a id="ticket-wake"></a> **Ticket Wake** — Post-commit in-process delivery of a durable Ticket event and cursor ([TicketWake](packages/host-core/src/ticket-wake.ts)).
- <a id="session-wake"></a> **Session Wake** — Post-commit in-process delivery of a durable Session event, without coalescing ([wake bus](packages/host-core/src/session-control/session-wake.ts)).
- <a id="watch"></a> **Watch** — Non-blocking subscription whose later Ticket/Session facts arrive as Volli notices ([watch doors](packages/host-core/src/agent-watch.ts)).
- <a id="await"></a> **Await** — Retired `ticket_await`/`session_await`; frozen Sessions retain their names, but calls now arm Watches and return immediately; cursors follow ledger order ([compatibility doors](packages/host-core/src/agent-watch.ts), [ordered cursor](packages/host-core/src/db/session-events-cursor-repo.ts)).
- <a id="awaitablesessions"></a> **`awaitableSessions`** — Actor-policy list of Session facts allowed to wake a Watch, separate from Ticket `awaitable` kinds ([AuthorityActorPolicy](packages/shared/src/authority-config.ts)).

## Runtime and access

- <a id="agent-runtime"></a> **Agent Runtime** — Pi-backed executor boundary emitting observations without owning durable Session or Ticket state ([runtime contract](packages/shared/src/agent-runtime.ts), [implementation](packages/agent-runtime/src/pi/runtime.ts)).
- <a id="executor-slot"></a> **Executor Slot** — Runtime-id registry and attachment-based selection seam; Pi is the only shipped runtime, never a caller choice ([slot](packages/session-engine/src/executor-slot.ts)).
- <a id="model-access"></a> **Model Access** — Sanitized provider/model availability and billing view, with credentials kept behind the runtime boundary ([ModelAccessSnapshot](packages/shared/src/agent-runtime.ts#L172)).
- <a id="decision-model"></a> **Decision Model** — Configured classifier returning typed choice/score/bool answers with probabilities, not prose ([decision vocabulary](packages/shared/src/decision-model.ts)).
- <a id="decision-service"></a> **Decision Service** — Bounded classifier orchestration returning a caller's deterministic fallback on any miss ([service](packages/agent-runtime/src/decision/service.ts)).
- <a id="decision-purpose"></a> **Decision Purpose** — Named opt-in and policy boundary for classifier use: `agent.classify` or `model.select` ([purposes](packages/shared/src/decision-model.ts#L43)).
- <a id="automatic-model-choice"></a> **Automatic model choice** — Opt-in birth-time selection from approved model/reasoning pairs, falling back to the configured default ([selection rules](packages/shared/src/model-auto-select.ts)).
- <a id="web-access"></a> **Web Access** — App-wide web/search configuration; off provides no web tools, and model-supplied URLs face public-web admission ([settings](packages/shared/src/host-settings.ts), [target policy](packages/shared/src/web-target-policy.ts)).
- <a id="context-compaction"></a> **Context Compaction** — Summary replacing older model context without deleting durable history; automatic threshold policy does not disable overflow/manual recovery ([policy](packages/shared/src/compaction-policy.ts), [mechanism](packages/agent-runtime/src/pi/compaction.ts)).
- <a id="background-shell"></a> **Background shell** — Session-owned process running beside a turn, with bounded output and exit notices; not a durable Session or terminal ([shell host](packages/host-core/src/shell/background-shell-host.ts)).
- <a id="agent-cli"></a> **Agent CLI** — Bash-composable `volli` socket surface; Session authentication is per attachment, not a claimed id ([wire](packages/shared/src/agent-surface.ts), [admission](packages/host-core/src/agent-dispatch/admission.ts)).
- <a id="agent-tool-surface"></a> **Agent Tool Surface** — Session's Role bundle plus scoped grants and available capabilities, frozen at birth and refreshed only additively ([surface resolution](packages/shared/src/agent-tool-surface.ts), [refresh](packages/shared/src/tool-refresh-delta.ts)).
- <a id="client-surface"></a> **Client Surface** — Person-facing command/projection API; the local desktop bridge exposes it without database access ([preload API](apps/desktop/src/preload/index.ts)).
- <a id="external-agent-surface"></a> **External Agent Surface** — Planned admission boundary for agents Volli does not host; current code only provides a policy-store seam ([admission seam](packages/host-core/src/agent-dispatch/admission.ts#L105)).
- <a id="verb-registry"></a> **Verb Registry** — Single declaration of agent-facing verbs, projected onto each surface with one handler binding ([registry](packages/shared/src/verb-registry.ts)).
- <a id="verb-tier"></a> **Verb Tier** — Derived read/coordination/control governance class, never a stored field ([tier rules](packages/shared/src/verb-registry.ts)).
- <a id="door"></a> **Door** — Caller-resolving transport entrance to shared behavior: IPC, socket, tool or Automation Run ([admission](packages/host-core/src/agent-dispatch/admission.ts), [Run door](packages/host-core/src/automations/run.ts)).
- <a id="cache-prefix"></a> **Cache Prefix** — Byte-stable leading request content reusable by the provider within a warm epoch ([prompt assembly](packages/agent-runtime/src/prompt.ts), [cache placement](packages/agent-runtime/src/prompt-baseline.ts#L83)).
- <a id="context-assembly"></a> **Context Assembly** — Deterministic stable-first composition of system prompt, tools and message content ([prompt composition](packages/agent-runtime/src/prompt.ts)).
- <a id="turn-reminder"></a> **Turn Reminder** — Volatile turn facts delivered as message content rather than changing system-prompt bytes ([composeTurnReminderBlock](packages/agent-runtime/src/prompt.ts#L694)).
- <a id="cache-class"></a> **Cache class** — Declared section stability: `role-static`, `project-static`, `session-static` or `per-turn`, not measured cache performance ([PromptCacheClass](packages/agent-runtime/src/prompt-baseline.ts#L59)).

## Browser

- <a id="browser-tab"></a> **Browser Tab** — Product-identified page with navigation generation, separate from the app renderer and accessible through Browser tools ([tab state](packages/shared/src/browser-tab.ts)).
- <a id="headless-tab"></a> **Headless tab** — Session-created Browser Tab on no person-visible surface, still rendered and capturable ([presentation states](packages/shared/src/browser-tab.ts#L18)).
- <a id="tab-owner"></a> **Tab owner** — Session that opened a Browser Tab, or nobody for a person's tab; distinct from its current hold ([ownerSessionId](packages/shared/src/browser-tab.ts#L43)).
- <a id="presentation"></a> **Presentation** — Person-controlled Browser Tab placement: `headless`, `tab` or compatible legacy `preview` ([BrowserTabPresentation](packages/shared/src/browser-tab.ts#L18)).
- <a id="tab-hold"></a> **Tab hold** — One party's turn to drive a Browser Tab: a Session or the person, never both ([BrowserTabHolder](packages/shared/src/browser-tab-hold.ts)).
- <a id="session-cursor"></a> **Session cursor** — Identity-colored arrow showing where a Session holding a Browser Tab acts ([cursor](apps/desktop/src/renderer/src/components/browser/session-cursor.tsx), [motion](packages/shared/src/session-cursor-motion.ts)).
- <a id="browser-trace"></a> **Browser Trace** — Host-written replay evidence of settled browser calls on a Session-owned tab, never model input or typed page text ([trace contract](packages/shared/src/browser-trace.ts)).
- <a id="browser-replay"></a> **Browser replay** — Person-facing playback of Browser Trace steps and retained frames ([replay dialog](apps/desktop/src/renderer/src/components/browser/browser-trace-dialog.tsx)).
- <a id="tab-card"></a> **Tab card** — Transcript affordance for a Browser Tab's live state and replay ([BrowserTabCard](apps/desktop/src/renderer/src/components/browser/browser-tab-card.tsx)).
- <a id="session-colour"></a> **Session colour** — Stable identity hue, collision-resolved among concurrent holders; never a state color ([identity colors](packages/shared/src/session-color.ts)).

## Usage

- <a id="metered-operation"></a> **Metered operation** — One provider call's reported consumption, recorded as `usage.recorded` with its cause; missing measurements are not zero ([SessionUsage](packages/shared/src/session-usage.ts)).
- <a id="cost-basis"></a> **Cost basis** — `provider-reported`, `catalog-estimate` or `unavailable`; a mixed rollup says `mixed`, never implies an invoice ([cost vocabulary](packages/shared/src/session-usage.ts#L25)).
- <a id="usage-projection"></a> **Usage projection** — Rebuildable per-operation ledger index with query-time rollups, not stored running totals ([session_usage](packages/host-core/src/db/migrations.ts#L923)).
- <a id="usage-window"></a> **Usage Window** — Live provider-subscription allowance measurement: used share, reset time and optional duration; not Session cost accounting ([UsageWindow](packages/shared/src/usage-limits.ts)).
- <a id="cached-input-share"></a> **Cached input share** — Cache-read tokens divided by uncached input plus cache-read plus cache-write tokens; not a request hit rate ([usage summary](packages/shared/src/session-usage.ts#L192)).

## Automations and skills

- <a id="automation"></a> **Automation** — Saved named way to start work, composed of Trigger, Instructions and Runtime ([Automation](packages/shared/src/automation.ts#L137)).
- <a id="trigger"></a> **Trigger** — What starts an Automation besides a person: none, column arrival or schedule ([AutomationTrigger](packages/shared/src/automation.ts#L126)).
- <a id="armed-automation"></a> **Armed automation** — Column's single selected Automation for deliberate arrivals; distinct from offered membership and enablement ([ColumnArming](packages/shared/src/automation.ts#L638)).
- <a id="offered-list"></a> **Offered list** — Column's ranked Trigger-matching Automations, with enabled armed choice first and bounded digit targets ([offered ordering](packages/shared/src/automation.ts#L694)).
- <a id="option-drag-picker"></a> **Option-drag picker** — Expanded Offered list under ⌥ during a card drag, including an explicit Move only target ([column panel](apps/desktop/src/renderer/src/components/board/column-offered-panel.tsx)).
- <a id="instructions"></a> **Instructions** — Automation's opening prompt, resolving the composer's `/` and `@` grammar without appending Ticket context ([Automation.instructions](packages/shared/src/automation.ts#L142)).
- <a id="runtime"></a> **Runtime** — Automation's model/reasoning selection: inherited, pinned or tier-resolved; not an Agent Runtime choice ([AutomationRuntime](packages/shared/src/automation.ts#L94)).
- <a id="run"></a> **Run** — Durable invocation of an Automation, owning one fresh Session and its resolved execution choices ([AutomationRun](packages/shared/src/automation.ts#L207)).
- <a id="unbound-run"></a> **Unbound Run** — One-time Run carrying Instructions without naming or saving an Automation ([AutomationRunTarget](packages/shared/src/automation.ts#L326)).
- <a id="enabled-automation"></a> **Enabled automation** — Locally, one permitted to fire automatically on this machine; manual Runs remain available ([enablement](packages/host-core/src/automations/enablement.ts)).
- <a id="skipped-occurrence"></a> **Skipped occurrence** — Scheduled due time recorded without a Run and with its actual reason, never replayed as backlog ([AutomationSkippedOccurrence](packages/shared/src/automation.ts#L589)).
- <a id="skill"></a> **Skill** — Instruction directory containing `SKILL.md`, identified by its slug and supplied from repo or personal `.agents/skills` ([skill vocabulary](packages/shared/src/skill.ts)).
- <a id="invocation-policy"></a> **Invocation policy** — Independent model-discoverable and user-invokable axes resolved consistently for every Skill consumer ([SkillInvocationPolicy](packages/shared/src/skill.ts#L81)).
- <a id="skill-mode"></a> **Skill mode** — Project override: Auto opens both invocation axes, Manual only user invocation, Off neither ([SkillMode](packages/shared/src/skill.ts#L274)).
- <a id="author-invocation-default"></a> **Author invocation default** — Skill file's invocation declaration before Project overrides, with portable keys and a legacy alias ([author policy reader](packages/shared/src/skill.ts#L529)).
- <a id="skill-activation-lifecycle"></a> **Skill activation lifecycle** — Explicit per-message Skill delivery retains exact resource bytes; attach-time selection is separate ([delivery receipts](packages/shared/src/skill.ts#L756), [resource format](packages/shared/src/prompt-resource.ts)).
