# Hosted Volli Cloud first

**Proposal, not a ruling. VC-767 under VC-539; 2026-10-14.** Amendments below
require owner approval; existing plans and tickets are unchanged. M1/M2's
merged foundations are reused, not equated with hosted readiness. Code evidence
is this worktree's `c0cfd4577`; the parity report is the same snapshot, not a
fresh acceptance run. Public prices were read **2026-10-14**, including by the
parallel researchers. USD unless marked EUR; tax excluded. No accounts,
purchases, deployments or workload benchmarks were performed.

## Decisions for the owner

| Decision | Recommendation and numbers |
|---|---|
| **1. Hosted before full BYO mobility?** | **Yes: an invite-only, tenant-dedicated combined `hostd` first.** At 100 paid users, infrastructure budgets are **$14.80 / $19.93 / $32.43 per light / typical / heavy user-month** on cheap retained VMs. But Hetzner CX capacity currently shows unavailable: these are conditional economics, not a launch promise. Managed Northflank execution instead budgets **$9.36 / $43.01 / $197.25**, with successful scale-to-zero and retained SSD. Approve the direction, gate commercial launch on capacity and measured performance. |
| **2. Compute and price?** | Dogfood always-on VMs if suitable capacity exists; otherwise a bounded managed pilot, not a bare-metal fleet. Hypotheses for ≥70% infrastructure contribution margin: **$59 / $79 / $129** on the cheap VM route; **$39 / $169 / $749** on managed usage profiles. Do not promise an unlimited $20–$40 plan. Compare these prices against customer willingness before shipping; fixed fleet cost is material below 100 users. |
| **3. Inference included?** | **BYO API key first; optional separately metered Volli inference later.** Representative Sol inference is **$10.05 / $100.50 / $402.00** per profile, independent of infrastructure. A 25% inference uplift produces only ~17% inference margin after a 3% payment allowance; blended VM margins fall to **62% / 38% / 28%**. “Healthy infrastructure margin” is not 70% total margin with inference bundled. |
| **4. What does “Run in cloud” mean initially?** | A new cloud-authoritative board, with all its Sessions colocated, visible on a new signed-in laptop. One tenant host can hold multiple Workspaces. **Not** arbitrary placement of an existing Mac ticket; selective local/cloud execution follows in H2. Keep one writer and no board sync. Defer per-Workspace databases until independent placement/restore justifies the migration. |
| **5. Credential custody and exposure?** | Approve a **hosted-only** KMS/envelope-custody amendment: the cloud ruling permits KMS, but the sealed-store plan currently prohibits provider KMS/network custody. Do not silently override that policy. BYO credentials need tenant-scoped consent and deletion; fleet inference keys stay outside tenant code. Account verifier, TLS trust, revocation and execution isolation are launch gates, not optional polish. |
| **6. BYO, VC-579, VC-733?** | Maintain open-source local/self-hosted installation, protocol and security fixes; stop making friction-free SSH onboarding the commercial critical path. Preserve VC-579's BYO feedback and acceptance history, create a hosted acceptance successor. Rebrief VC-733's six moments around account → repository → credential consent → Run in cloud, including price/limits and away/back; keep it owner-driven, not an implementation prerequisite for every backend task. |

Open owner choices: acceptable first region/data residency; acceptable cold-start
wait; whether 70% is an infrastructure or blended revenue target; willingness
to pay the managed fallback prices; hosted KMS custody. These are proposed
choices, not approvals obtained by this study.

## Per-user model

Recompute with `python3 docs/research/cloud-hosted/cost_model.py`.
Assumptions are adjustable; there is no measured workload trace yet.

| Monthly profile | Light | Typical | Heavy |
|---|---:|---:|---:|
| Active **machine** hours, including model/network waits | 20 (few hours/week) | 176 (8h × 22 days) | 500 (parallel tickets, overnight) |
| Max simultaneous Sessions per one machine | 1 | 2 | 4 |
| Provisioned vCPU / RAM | 2 / 4 GB | 4 / 8 GB | 8 / 16 GB |
| RAM budget: host/OS + execution + Chromium | 0.5 + 2.5 + 1 GB | 1 + 5 + 2 GB | 1 + 11 + 4 GB |
| Persistent repo / dependency / transcript+blob GB | 3 / 6.5 / 0.5 | 8 / 20 / 2 | 20 / 50 / 10 |
| Retained incremental backups, GB-month | 20 | 60 | 160 |
| Internet egress, including previews/screencasts, GB | 5 | 25 | 100 |

Hours are **not summed Session-hours**: four Sessions for eight hours consume
eight hours of the larger machine, not 32. Chromium is reserved in the RAM price,
not charged twice; its actual RSS and browser concurrency are H0 measurements.
Workloads exceeding RAM/CPU/disk caps must queue or explicitly buy more capacity.
Do not swap silently. Heavy here is not 24/7 × unlimited parallel machines.

Model routes:

- **VM:** Hetzner EU CX23/CX33/CX43 monthly USD caps $6.49/$9.99/$18.49
  [C1]. Included root disks 40/80/160 GB must fit OS, images and stated data.
  Shared vCPU is not a sustained dedicated core. Powered-off servers still cost
  money. Allocate the cap across 730 active/idle hours for explanation only.
  Add a **$1/user networking/IP allowance**, not a quoted IP tariff.
- **Managed:** Northflank 2/4, 4/8 and 8/16 at $0.0667/$0.1333/$0.2667
  per hour; persistent SSD $0.15/GB-month [C9]. Stop when no turn, shell,
  browser, preview or other required process is live. “Pause” kills processes;
  this is restart from durable state, not memory-preserving suspension.
- **Both:** R2 Standard backups $0.015/GB-month plus $0.05/user operations
  allowance (~10k Class A + 10k Class B operations, fleet pooled) [S1]. Retention
  caps incremental bytes at 2× live data: **not 30 daily full disk copies**.
  Back up git/dirty files, transcripts and blobs; omit reproducible dependency
  caches. The egress budgets include these backup uploads and must be measured.
  No fleet-wide free allowances credited. Control-plane allowance is
  **$200/fleet-month ÷ N paid users + $2/user variable**, covering account,
  registry, gateway, billing webhooks, KMS, logs/metrics and push. At N=100 this
  is $4/user; an allowance, not a vendor quote or salary budget. Convex stays
  the registry/control plane, never board authority [S2].
- Hetzner EU includes 20 TB/server; modeled VM egress adds $0 [C1].
  Northflank Internet egress is **$0.06/GB**: $0.30/$1.50/$6 per profile;
  ingress is free, cross-zone transfer additionally $0.02/GB [C9]. No cross-zone
  replication assumed. Cap previews/artifacts; backup uploads count in egress.
  R2 egress is free, but VM-to-R2 traffic still leaves the VM [S1].

| USD/user-month, before inference | VM light | VM typical | VM heavy | Managed light | Managed typical | Managed heavy |
|---|---:|---:|---:|---:|---:|---:|
| Active compute allocation | 0.18 | 2.41 | 12.66 | 1.33 | 23.46 | 133.35 |
| Idle compute allocation | 6.31 | 7.58 | 5.83 | 0 | 0 | 0 |
| Persistent disk incremental | 0 | 0 | 0 | 1.50 | 4.50 | 12.00 |
| Backup storage + operations | 0.35 | 0.95 | 2.45 | 0.35 | 0.95 | 2.45 |
| VM IP allowance / managed Internet egress | 1 | 1 | 1 | 0.30 | 1.50 | 6.00 |
| Control-plane allowance (N=100) | 4 | 4 | 4 | 4 | 4 | 4 |
| **Raw infrastructure** | **11.84** | **15.94** | **25.94** | **7.48** | **34.41** | **157.80** |
| **Budget with 25% capacity/incident reserve** | **14.80** | **19.93** | **32.43** | **9.36** | **43.01** | **197.25** |
| Price floor: 70% margin + 3% payment allowance | 54.81 | 73.80 | 120.09 | 34.65 | 159.31 | 730.56 |
| **Price hypothesis** | **59** | **79** | **129** | **39** | **169** | **749** |

Formula: `raw = compute + disk + backups + operations + network + control`;
`budget = raw × 1.25`; `price floor = budget / (1 − 0.70 − 0.03)`.
Prices yield 70–73% infrastructure contribution margins, **excluding salaries,
customer support, taxes and acquisition**. Rounded rows may not sum exactly.
Managed idle is $0 only after actual termination; a parked-but-running machine
still accrues its full hourly cost. **An always-on managed H1 pilot budgets
$68.55/$135.32/$273.93**, at N=100, not the sleeping-route totals. Sleeping
infrastructure and wake/parking are future implementation, not M1/M2 features. Provider snapshot/extra network charges not
verified below must fit the reserve or be repriced before commitment.

**Sensitivity:** at 10 users the control allowance is $22/user instead of $4,
adding $22.50 to each reserved budget and ~$83.33 to its 70% price floor; at
1,000 it is $2.20. Another eight typical overnight hours cost **$0 extra within
the VM cap**, or **$1.07 managed compute**, plus inference. At 730 active heavy
hours, managed compute alone is $194.69 rather than $133.35. Typical managed
compute overtakes a $9.99 retained VM at ~75h/month **before** managed disk;
CPU performance is not equivalent. Shared CPU slowdowns increase task time.
If cheap VM capacity fails, DigitalOcean bundled 2/4, 4/8, 8/16 costs
**$24/$48/$96 monthly** [C10], raising reserved VM budgets by approximately
**$21.89/$47.51/$96.89**: do not sell the cheap-VM tiers on that fallback.

**Free tier:** no permanent free hosted machine. Hypothesis: one verified-user,
one-time **2h 2/4 managed trial, no billed inference**, max 5 GB retained for
7 days, then export/delete with notice. Compute ~$0.13, SSD ~$0.18,
2× R2 backups ~$0.04: **<$0.50 marginal provider cost** only if egress stays
≤1 GB and request usage is small, **not** fully loaded cost. Account/fleet overhead, signup abuse and
inference can dwarf it; require invitation/payment verification and a fleet
trial-spend cap. Free local/open-source use remains unchanged.

### Inference, separately

Volli-billed inference is a pricing hypothesis contingent on provider commercial
integration/resale terms; it is not permission to intermediate subscriptions.
Volli currently registers Pi's built-in provider registry (42 providers at the
pinned Pi AI 1.0.0 source), not a three-provider allowlist. API/OAuth availability
in `packages/agent-runtime/src/pi/{models,sign-in}.ts` is not contractual
permission to host a consumer subscription [I0].

| Standard USD / 1M tokens | Uncached input | Cache read | Cache write | Output |
|---|---:|---:|---:|---:|
| GPT-6.1 Sol, ≤272k input/request [I1] | 2.00 | 0.10 | 2.50 | 10.00 |
| Claude Sonnet 5.5, 5m cache [I2] | 2.00 | 0.10 | 2.50 | 10.00 |
| Claude Opus 5.5, 5m cache [I2] | 4.00 | 0.20 | 5.00 | 20.00 |
| GPT-6 Luna / Claude Haiku 5.5 short-context [I1,I2] | 0.10 | 0.01 | 0.125 | 0.50 |
| Gemini 4 Argon introductory [I3] | 2.00 | 0.10 | Implicit caching only | 10.00 |

| Sol example, millions of tokens/month | Light | Typical | Heavy |
|---|---:|---:|---:|
| Uncached input / cache read / cache write / output | 2 / 8 / 0.5 / 0.4 | 20 / 80 / 5 / 4 | 80 / 320 / 20 / 16 |
| **Provider inference cost** | **10.05** | **100.50** | **402.00** |
| BYO API key: Volli inference COGS / user pays provider | 0 / 10.05 | 0 / 100.50 | 0 / 402.00 |
| Volli bills: inference COGS / charge at 25% uplift | 10.05 / 12.56 | 100.50 / 125.63 | 402.00 / 502.50 |
| Total VM bill, infrastructure + Volli inference | 71.56 | 204.63 | 631.50 |
| Total managed bill, infrastructure + Volli inference | 51.56 | 294.63 | 1,251.50 |

These are explicit token hypotheses, not measured cost per task. New-model
availability/protocol support in the pinned runtime must be verified in H0.
Reasoning,
subagents, retries, compaction, summaries and cache writes all count. Cache
misses and long contexts change the bill: Sol >272k doubles input/cache/write
and multiplies output by 1.5; Haiku >100k multiplies rates by 5. Argon's
introductory price doubles December 1, 2026 [I1–I3]. Sonnet's tokenizer can
produce different token counts for the same text: identical rate cards do not
imply identical task costs. Vendor web-search/tool fees and separate Volli web
search are additional metered services, not included token costs. Start with
prepaid caps; reconcile usage before allowing further turns, without duplicate
accepted work. Consumer subscriptions are quota-based, not this API arithmetic.

| Subscription/key path | Hosted Pi policy |
|---|---|
| Anthropic Pro/Max OAuth | **Do not offer.** Official rules prohibit applications routing/collecting Claude.ai subscription credentials. Hosting the unmodified Claude Code binary has a distinct exception; Pi is not that exception [P1]. |
| OpenAI ChatGPT/Codex OAuth | Open-source/local and self-hosted VM support is not blanket approval for paid remote Volli. Hosted applications must request access; use API keys until an approved integration exists [P2]. |
| Google | Volli's Google provider uses Gemini API keys. Gemini CLI OAuth piggybacking is prohibited; use Gemini API/Vertex, not consumer/CLI tokens [P3]. |
| Copilot, OpenCode, OpenRouter, Bedrock, Azure and other built-ins | Hosted allowlist only after provider-by-provider entitlement/terms review. OpenCode explicitly supports Pi/other coding agents with identity/session requirements [K6]. Do not transfer every local sign-in automatically. |

## Compute shortlist

The [provider comparison and dated source index](../research/cloud-hosted/README.md)
contains the full rates, idle charges, isolation, disk/snapshot behavior, startup
claims, regions, operational burden and lock-in for each option. Source IDs in
this proposal resolve there. No latency claim was benchmarked.

| Option | 2/4 → 4/8 active USD/hour, excluding extras | Verdict |
|---|---|---|
| Hetzner EU CX [C1] | 0.0104 → 0.0160; monthly caps 6.49 → 9.99 | Best conditional retained-VM economics; capacity unavailable on fetched page; shared CPU. |
| Own AX42-1 + microVMs [C1,S4] | Whole host $117.10/mo + $59 setup | Own scheduler/isolation/patching/backups; not the first milestone. |
| Fly [C2] | Shared 0.0353 → 0.0706; performance 0.0917 → 0.1833 | Flexible Machines/volumes; shared baseline only 6.25% per vCPU, not dedicated-core parity. |
| E2B [C3] | 0.1656 → 0.3312; Pro $150/mo + usage | Memory-preserving pause, ~1s claimed resume; ~32s claimed pause at 8 GiB. |
| Daytona Linux VM [C4] | 0.1656 → 0.3312 + disk | Hot snapshots; explicitly select own-kernel VM, not container class. |
| Modal [C5] | 0.2380 → 0.4759 | Managed gVisor/VM choice; memory snapshots experimental; pinning surcharge. |
| Cloudflare [C6] | Exact shapes unavailable; 2/8/16 disk 0.2200 → 4/12/20 disk 0.4010 at full CPU | Sleepable microVMs; disk snapshot ≤20 GB, 30-day TTL, no RAM capture; add Workers/DO. |
| Morph [C7] | 0.10 → 0.20 within disk limits | Promising snapshot challenger; region/metering/production details unresolved. |
| Northflank [C9] | 0.0667 → 0.1333 | Managed CPU microVMs, paid SSD/egress; pause restarts, not process checkpoint. |
| DigitalOcean bundled [C10] | $24 → $48 monthly caps | Widely available VM alternative, but not cheap-CX price parity. |

Own-metal illustration: two AX42-1 hosts, setup amortized over 12 months,
four hypothesized safe 4-vCPU/8-GB slots each: **$30.50 occupied slot-month at
100% occupancy, $43.58 at 70%, $122.02 at 25%**, before storage/control/labor.
Two hosts do not provide N+1 at full occupancy. Prove safe concurrency, not
just RAM packing. Hetzner Cloud does not support nested virtualization. gVisor
is a userspace kernel, not a microVM; compatibility is a separate gate [C1,S4].

## Architecture shapes and wake-up

| Shape | Host / Worker / Client mapping | What wakes it; lid-closed consequence |
|---|---|---|
| **A. Combined hostd per tenant (recommended first); sleeping variant** | Present Node authority + colocated execution; desktop/phone only clients. Current DB holds multiple Workspaces, so isolate the whole tenant host, HOME, disk and network. A literal host per Workspace would duplicate host-wide settings/credentials or require a split. | Always-on version accepts turns/phone answers and runs schedules while laptop sleeps. Sleeping version needs an always-reachable authenticated gateway/control-plane wake service for commands/answers and a schedule wake index. Reads also wake, or show unreachable/read-only—no shadow board. Running turns/shells/previews inhibit sleep. |
| **B. Small always-on host + workers on demand** | Node host remains sole board/ledger/scheduler authority; authenticated outbound workers own checkout leases, agent loops and Chromium. Clients never execute remote tools. | Host wakes worker for a turn, answer resumption or schedule. Board reads need no worker. Still pay authority baseline plus worker active time/storage. Worker transport, grants, locations, artifacts and lease/fencing services are missing; not deployment-only. |
| **C. Embeddable authority + environment drivers (VC-765)** | One logical authority per Workspace in DO/other durable runtime, execution in Linux sandboxes; same client protocol. Not a second board store or client-side loop. | Requests/alarms wake authority and then execution; hibernating authority can be cheap. DO prices: $5 Workers account minimum, then $0.15/M requests and $12.50/M GB-s beyond allowances [S3]. A non-hibernating 128 MB object for 730h consumes ~336k GB-s (~$4.20/user-mo amortized at fleet scale). Alone it fits the 400k fleet allowance; excess fleet duration rounds up to million-GB-s units ($12.50 increments), **not necessarily $4.20 billed**. |

For a sleeping A, store accepted intent/receipts **in the authoritative host**
after wake. Gateway may reject/retry while waking, not acknowledge a queued
board command as accepted. Coalesce wake requests; acquire an ownership lease
and epoch before mounting writable storage. Schedule index contains only wake
metadata; host keeps canonical Automation definitions and deduplicates execution.
An unanswered question can permit sleep only after durable parking and a tested
answer-resume path. Do not snapshot an active model request and promise its TCP
stream survives. No live in-flight ticket moves in the first hosted milestone.

VC-765's evidence is real: OpenCode's workerd profile replaces unavailable
filesystem/process services, persists events and survives eviction [S5]. Volli
already embeds `createHostCore`, but it directly opens native synchronous
SQLite/WAL and depends on filesystem transcripts, git/processes, Unix sockets,
credential locks and Node-native packages. A WorkspaceDriver alone cannot run
it in workerd. Spike storage/transaction, environment/execution and lifecycle
ports; reuse pure shared/session-engine and protocol contracts. **Do not block
H1 on a board-engine rewrite.** Convex remains control plane, not a competing
Workspace authority.

## M1/M2 reuse and hosted gaps

| Reuse as foundations | Concrete evidence / remaining hosted work |
|---|---|
| Headless runtime and authoritative state | `apps/hostd/src/{hostd,session-runtime}.ts`: Pi, CLI socket, worktrees, recovered Sessions, delegation, Automation scheduler. Reuse behavior; add tenant resource admission and safe process isolation. |
| Shared protocol and handler map | `apps/hostd/src/host-protocol.ts`, `packages/host-protocol/src/client-link/link.ts`: board/chat/history/queue/sign-ins/project clone/default models, reconnect/stale views. Host/Workspace scopes already differ. Missing remote parity is not cured by managed provisioning. |
| Enrollment-neutral verifier | `packages/host-protocol/src/credentials.ts`: async verify/current/revocation watch seam. Production uses SSH-enrolled devices; **loopback-only** listener, welcome `proof:null`, and dogfood revocation exception remain. Add account/tenant grants, authenticated WSS gateway and host trust, commit-boundary authorization, durable epoch pins and account revocation before public hosting. |
| Provider-neutral provisioning | `packages/host-install/src/provision.ts`: resumable `HostProvider` steps; SSH is the sole adapter. Add image/provider reconciler, idempotent account provisioning and readiness; clients use hosted routes, not SSH installation. |
| Credential ports | `ports/{secret-key,credential-keyring}.ts`: seams exist, but synchronous seal/open needs pre-unwrapped tenant keys or lifecycle adaptation, not synchronous network KMS calls. Current Pi auth, git/MCP stores and web credential cutover are not uniformly sealed. Resolve custody ruling, finish all stores, rotation/revocation, consent and audit. |
| Maintenance/logging | host recovery/drain/retention/checkpoint/restore and structured logs exist. Add fleet desired-state reconciliation, canary upgrades/drain, metering/billing caps, off-host encrypted backups and restore drills. Backup bundles **do not include uncommitted git/checkouts or host identity/devices**; build checkpoint + artifact manifests and fenced new-host restore, not raw disk cloning as failover. |

Security boundary: separate data dirs and RPC authorization are **not** arbitrary
code isolation. Dedicated tenant VMs prevent cross-tenant sharing but same-UID
shells can read host credentials/data. Before opening access, isolate tool
process mounts/UIDs/network from host DB and private keys; expose only scoped
CLI capabilities. Keep fleet billing/model credentials in a separate broker,
with tenant-scoped short-lived grants, spend caps and egress/metadata-service
blocks. Test malicious repo instructions, filesystem escapes, token theft,
crypto-mining, fork bombs, cancellation and quota recovery. Scope any eventual
preview URL to a tenant/workspace, require explicit first exposure confirmation,
use a random persistent address and rotate it on disable/re-enable (VC-764).
Randomness is **not authentication**; previews and agent browser streams are
separate from the host's command endpoint.

H0 must measure idle/active RSS (the listener's 544 MiB worst-case queue bound
is not idle usage), browser peaks, clone/build time, dependency churn, egress,
p95 start/wake and useful throughput. Prove kill/restart/retry does not duplicate
accepted work; restore private repo, transcript, blobs **and dirty checkout**;
record RPO/RTO. Initial targets: p95 ready <60s, reconnect <10s, no accepted
command duplication, ≤24h backup RPO and ≤30m manual restore RTO. These are
proposed acceptance targets, not current guarantees. Shorten RPO before paid
customers entrust valuable dirty work.

## Competitors: included compute is not unlimited inference

| Product | Published pricing and hosted shape |
|---|---|
| **Amp** [K1] | Individual **$20/mo**, 45,000 advertised orb minutes; larger sizes consume allowance faster. Separate API-price model/tool credits or BYOK. Persistent isolated orbs, own runners too. Compute 1/2 **$0.08/h**, 2/4 **$0.17**, 4/8 **$0.33**, 8/16 **$0.66**, all 60 GB disk; paused free. This is the clearest compute/inference split. |
| **Cursor** [K2] | New unified Premium **$30**, Super **$100**, Ultra **$200/mo**; $8 Plus lacks cloud agents. Existing non-unified Pro **$20**, Pro+ **$60**, Ultra **$200**; do not conflate cohorts. Isolated cloud VMs/prebuilt environments; third-party models at API list pricing under unified plans. No reproducible public VM-hour tariff found. |
| **Codex cloud** [K3] | ChatGPT Plus **$20/mo**, Pro **$100/$200/$500** tiers; shared local/cloud quotas and extra credits. Cloud VMs: Plus 2 vCPU/8 GiB RAM/8 GiB disk; paid higher tiers 4/16/32. Published environments; state recoverable seven days by default. API-key Codex does not include cloud features. Included task quotas are not API dollars. |
| **Devin** [K4] | Free; Pro **$20**, Max **$200/mo**. Teams **$80 minimum**, full seats **$40 each**, remainder below two seats becomes credits. Quotas/meter combine actions, VM time and networking; sleeping free. No reproducible self-serve token/VM tariff found; legacy ACU plan prices are not today's self-serve plans. |
| **Factory** [K5] | Pro **$20**, Plus **$100**, Max **$200/mo**; Teams **$60 + $40/seat**. 5h/7d/30d rolling limits; Extra Usage ≥$10 prepaid. Model usage and persistent auto-pausing Droid Computer compute share usage. Environments/prebuilt fresh sandboxes announced Oct 12. No public VM-hour tariff established. |
| **OpenCode** [K6] | Open-source engine; Console/Zen optional inference, not included development VMs. Go **$10**, Go Plus **$40/mo**, weighted rolling quotas; Console usage prepaid, processing **4.6% + $0.31**. Supports Pi subject to client/session requirements. Example GLM-5.3-Flash input/output/cache **$0.15/$0.50/$0.03 per M**, not a hosted workspace cost. |

Competitor low seat prices bundle quotas, incentives and/or separate model
charges. Their public tariffs do not reveal utilization or COGS; do not infer
that Volli can fund 500 machine-hours plus $402 inference for $20.

## Proposed hosted-first sequence

Retain M0–M2 foundations and architecture guardrails. Propose replacing “M3 →
M4 → M5 → hosted M6” as the commercial critical path with:

| Stage | Smallest scope and exit demo |
|---|---|
| **H0: feasibility, custody and unit economics** | Provider/capacity choice, representative workloads, tenant execution boundary, verifier/TLS and custody decisions, suspend/backup physics. Pass the targets above; meter actual compute/inference separately. No production signups in this study. |
| **H1: hosted owner dogfood (pull forward M6 essentials)** | Private control plane: account, registry, hosted credentials, provider provisioning, persistent tenant host, GitHub repo authorization/clone, supported BYOK consent/default model, spend dashboard/caps, backups, upgrades and limited push. **Sign in on a new laptop → see cloud board → Run in cloud → close lid → answer durable question → inspect result/PR.** Always-on first; sleeping combined host only after proven wake/parking. Explicitly name absent files/diffs/browser/attachments; do not call a chat-only prototype full parity. |
| **H2: placement and experience parity (select M3)** | Reopen/recreate folded VC-580/581/582/583/584/586 scopes under VC-543: worker identity/grants, checkout leases/epochs, checkpoint refs, environment/secret recipes and cross-process locks. VC-583 is Done because folded, **not shipped**. Deliver per-ticket “Run on” for a cloud-authoritative board with Mac/cloud workers; owner runs 50% locally and rest remotely. Mac-only authoritative boards cannot keep orchestrating with the lid closed. Files/diffs/PRs, model picker and read/attention parity precede broad commercial acceptance; browser/preview need their own capability/security proof. |
| **H3: economical paid beta** | Select sleeping combined hosts or persistent authority/on-demand workers from measured costs; billing/prepaid inference broker, abuse limits, restore drills and canary fleet upgrades. Gate price hypotheses on retained capacity, measured COGS and willing customers. Run VC-765 only if authority baseline dominates; own metal only when measured density pays for operations. |
| **H4: portability + phone** | Bring back M4 whole-host drain/bundle/fenced restore, import/export to avoid lock-in; per-Workspace split only with a new ruling. Minimal VC-637 phone answer path supports H1 dogfood; full M5 mobile remains 0.4.0 unless explicitly re-ruled. Multiplayer and live ticket migration are not H1 gates. |

**Ticket amendments proposed, not executed:** VC-539 records the new order and
commercial gates; VC-546 supplies H1/H3 control-plane scopes. VC-579 keeps its
BYO result as regression evidence, not a prerequisite to hosted. A hosted
acceptance successor uses fresh-account/new-laptop, consent, private-repo,
lid-closed, question-resume, quota and recovery journeys. VC-733 prototypes the
same six moments—connect, placement, bring work, Session, away/back, cloud as a
place—without asking users for IP/SSH passwords; make local-history import and
selective placement visibly later, not implied by clone. Preserve useful BYO
installer work and security fixes; no new provider wizard campaign. Public
hooks stay in the host protocol; paid registry/billing/provisioning code stays
in the private cloud repo. Each milestone still requires owner demo and the
post-milestone architecture review, not merely closed work tickets.

## Sources

**Read 2026-10-14.** Complete URL/date index, provider capability evidence and
fetch limitations: [research appendix](../research/cloud-hosted/README.md#sources).
Key model/decision sources:

- [Hetzner current USD/EUR rates](https://docs.hetzner.com/general/infrastructure-and-availability/price-adjustment/) and [capacity](https://www.hetzner.com/cloud/cost-optimized/) [C1].
- [Northflank compute/SSD/egress](https://northflank.com/pricing) and [sandbox billing/pause](https://northflank.com/docs/v1/application/sandboxes/sandboxes-on-northflank-cloud) [C9].
- [R2 storage/requests](https://developers.cloudflare.com/r2/pricing/) [S1]; [Convex current unit rates](https://docs.convex.dev/production/state/limits) [S2].
- [OpenAI API](https://developers.openai.com/api/docs/pricing), [Claude API](https://platform.claude.com/docs/en/about-claude/pricing), [Gemini API](https://ai.google.dev/gemini-api/docs/pricing) [I1–I3].
- [Anthropic subscription rules](https://code.claude.com/docs/en/legal-and-compliance), [OpenAI hosted approval](https://developers.openai.com/cookbook/articles/sign-in-with-chatgpt.md), [Gemini CLI restrictions](https://geminicli.com/docs/resources/tos-privacy/) [P1–P3].
- [OpenCode workerd SDK](https://opencode.ai/v2/docs/build/sdk/cloudflare) [S5]; competitors' plan/compute sources [K1–K6] are itemized in the appendix.

Internal inputs read 2026-10-14: [cloud ruling](volli-cloud.md),
[orchestration](volli-cloud-orchestration.md), [protocol](host-protocol.md),
[identity](host-identity.md), [sealed store](sealed-credential-store.md),
[host scope](host-scoped-connection.md); reference checkout's
`.scratch/cloud-hosted/brief.md`, `.scratch/cloud-experience/level-set.md`,
`.scratch/cloud-parity/{vc579-owner-feedback,matrix}.md`,
`.scratch/research/opencode-2.md`; CLI ticket histories VC-539/579/733/543/583/764/765.
Those scratch inputs are not portable public links; consequential findings are
restated here. No existing plan was edited.
