# Hosted Cloud research appendix

Supporting evidence for [VC-767’s proposal](../../plans/volli-cloud-hosted.md).

The model is a planning estimate, not a benchmark or a provider quote.
Recompute with `python3 docs/research/cloud-hosted/cost_model.py`; stdlib only,
no network/credential/product access. Edit assumptions to test other profiles.
Totals exclude taxes, engineering and support salaries.

## Compute options

Hourly compute below excludes storage, model fees and tax unless stated.
A CPU label is not equivalent performance: Fly shared baseline is 6.25% per
vCPU plus bursting; Modal's physical core equals two vCPUs [C2,C5].

| Option | 2 vCPU / 4 GB active hour | 4 vCPU / 8 GB active hour | Idle economics / minimum |
|---|---:|---:|---|
| Hetzner EU CX [C1] | $0.0104; $6.49/mo cap (€5.49) | $0.0160; $9.99 cap (€8.49) | Same charge retained/off; capacity unavailable on fetched product page. CAX ARM $6.99/$12.49 caps; also validate availability/toolchains. |
| Own AX42-1 + Firecracker/Kata [C1,S4] | Fleet allocation, not per-sandbox tariff | Fleet allocation | $117.10/mo + $59 setup (€97.30 + €49), excluding IPv4. 8 physical cores, 64 GB, 2×512 GB NVMe. Entire idle host remains paid. |
| Fly Machines [C2] | Shared $0.0352764; performance $0.0916704 | Shared $0.0705528; performance $0.1833408 | US baseline, seconds. Stopped rootfs/volumes $0.15/GB-mo; snapshot $0.08/GB-mo (10 GB fleet free). |
| E2B [C3] | $0.1656 | $0.3312 | Paused compute free, disk included (10 GiB Hobby / 20 Pro). Pro **$150/mo + usage**, allocated across users; configurable sizes require appropriate tier. |
| Daytona Linux VM [C4] | $0.1656 + disk | $0.3312 + disk | Paused CPU/RAM free; disk $0.000108/GiB-h after first 5 free; snapshots billed. Top-up/quota tiers, not unlimited free capacity. |
| Modal [C5] | $0.23796 | $0.47592 | Running idle billed max(request, actual); Starter $0, Team $250/mo + usage. Region pinning 1.15–1.75×; retained snapshot/volume tariff not verified. |
| Cloudflare Containers [C6] | Exact shape unavailable; 2/8/16 disk at full CPU $0.220032 | Exact shape unavailable; 4/12/20 disk at full CPU $0.40104 | CPU actual $0.072/vCPU-h; awake RAM $0.009/GiB-h and disk $0.000252/GB-h. Sleep stops container cost; Workers minimum $5/fleet-month + DO and snapshot costs. |
| Morph [C7] | $0.10 with ≤32 GiB disk; $0.15 at 40 | $0.20 with ≤64 GiB disk; $0.25 at 80 | Standard $0.05/MCU; MCU=max(vCPU, ceil(RAM/4), ceil(disk/16)). Paused snapshots use storage credits; $40/1,000 MCU and $250/7,500 MCU plans. Region/meter increment unverified. |
| Northflank [C9] | $0.0667 | $0.1333 | PAYG $0 base; seconds. Scale-to-zero compute free, SSD $0.15/GB-mo, Internet egress $0.06/GB; verify snapshot extras. |
| DigitalOcean bundled [C10] | $24/mo cap | $48/mo cap | Off still billed; destroy to stop. Seconds, ≥60s or $0.01. 672-hour cap on bundled plans; v5 is a different uncapped tariff. |

| Option | Isolation; persistence; lifecycle | Regions / operations / lock-in |
|---|---|---|
| Hetzner VM | Separate VM; local disk + disk snapshots, no RAM suspend. Volumes have no native snapshot/backup. “Seconds” provisioning claim, not app readiness. **No nested virtualization** [C1]. | CX/CAX EU; other series US/Singapore at different rates. OS/security/fleet ours; low API lock-in. |
| Own bare metal | Firecracker/Kata VM boundary preferred for hostile tenants; gVisor is a userspace kernel, not a VM. Disk/RAM snapshots require our scheduler/storage; no measured latency [S4]. | Germany/Finland. Highest operational burden: KVM, images, patches, capacity, backups, host failures, tenant networking. Low vendor lock-in, high custom-runtime commitment. |
| Fly | Firecracker; persist workspace on volumes, not ephemeral root. Existing stopped boot usually <1s claimed; initial image creation can take low-double-digit seconds [C2]. | Many regions; US rates above, Frankfurt ~1.154×. Moderate orchestration/storage work; Machine/volume APIs bind us. |
| E2B | Firecracker; full disk+RAM pause. Resume ~1s claimed; pause ~4s/GiB RAM (~32s at 8 GiB), not instantaneous. 1h Hobby/24h Pro continuous limit [C3]. | US/EU/APAC. Low fleet burden, SDK/template/state lock-in and plan minimum. |
| Daytona | **Select Linux VM class**; container class shares kernel. VM hot snapshots preserve memory; stopped/paused retains paid disk. Sub-90ms creation is marketing, not proven VM readiness [C4]. | US/EU. Managed lifecycle; class/SDK/snapshot lock-in, tier limits. |
| Modal | gVisor or own-kernel VM; select explicitly. Sub-second start claim. Disk snapshots; memory snapshots experimental, 7-day expiry and restrictions; ordinary runtime max 24h [C5]. | Multi-region, pinning surcharge. Low fleet burden, storage/runtime API lock-in. |
| Cloudflare | Firecracker. 1–3s cold-start claim. Disk snapshots now exist: ≤20 GB, image-bound, 30-day TTL, **no RAM/process capture** [C6]. | Cloudflare placement. DO/Worker ingress + lifecycle; strong platform coupling. Not a drop-in SSD/Node authority host. |
| Morph | Full VM; memory snapshot/fork/restore <250ms claim. Snapshot storage pricing example: 8 GB RAM + 8 GB disk ~$0.12/mo [C7]. | Public region/production guarantee details unresolved. Promising challenger, not sole launch dependency. |
| Northflank | CPU microVM; GPU gVisor. <1s boot claim. Pause kills processes and ephemeral disk; retained volumes and disk snapshots survive [C9]. | 6+ managed regions. Low fleet burden, moderate deployment/volume API lock-in. |
| DigitalOcean | VM, retained disks/disk snapshots; no RAM checkpoint assumed [C10]. | Broad regions; OS/fleet ours, low application lock-in. More expensive fallback. |

All latency figures above are **vendor claims**, not Volli measurements.
Own-metal illustration: two AX42-1 hosts, setup amortized over 12 months,
four hypothesized safe 4-vCPU/8-GB slots each. Hardware costs **$30.50 per
occupied slot-month at 100% occupancy, $43.58 at 70%, $122.02 at 25%**, before
storage/control/labor. Two hosts are not N+1 failover capacity at full occupancy.
Do not divide by RAM alone, equate SMT threads with dedicated cores, or call
hardware savings operating profit. Revisit only after real concurrency/load
measurements. Firecracker snapshots require separate disk handling and secure
snapshot custody; network connections can break on resume [S4].

## Sources

**Every public source below was read 2026-10-14.** Prices are the fetched
published offers, not negotiated quotes. Linked companion pages supplied
capability/policy evidence; unknown rates are marked unknown above.

- **C1 Hetzner:** [June 2026 price adjustment, including USD/EUR caps and AX42](https://docs.hetzner.com/general/infrastructure-and-availability/price-adjustment/); [CX sizes/capacity/EU traffic](https://www.hetzner.com/cloud/cost-optimized/); [billing](https://docs.hetzner.com/cloud/billing/faq/); [VM limitations](https://docs.hetzner.com/cloud/servers/faq/); [volumes](https://docs.hetzner.com/cloud/volumes/overview/); [AX hardware](https://docs.hetzner.com/robot/dedicated-server/server-lines/ax-server/).
- **C2 Fly:** [rates/storage](https://docs.fly.io/about/pricing); [CPU quotas](https://docs.fly.io/machines/cpu-performance); [lifecycle](https://docs.fly.io/machines/overview); [isolation](https://docs.fly.io/reference/architecture).
- **C3 E2B:** [plans](https://e2b.dev/pricing); [rate formula](https://docs.e2b.dev/faq/calculate-sandbox-price); [persistence and latency](https://docs.e2b.dev/sandbox/persistence); [isolation](https://e2b.dev/).
- **C4 Daytona:** [rates](https://www.daytona.io/pricing); [billing](https://www.daytona.io/docs/en/billing/); [isolation](https://www.daytona.io/docs/en/isolation/); [persistence](https://www.daytona.io/docs/en/persistence/); [tiers](https://www.daytona.io/docs/en/limits/); [regions](https://www.daytona.io/docs/en/regions/).
- **C5 Modal:** [rates](https://modal.com/pricing); [resource billing](https://modal.com/docs/guide/sandbox-resources.md); [runtime](https://modal.com/docs/guide/sandboxes.md); [snapshot limits](https://modal.com/docs/guide/sandbox-snapshots.md); [startup claim](https://modal.com/products/sandboxes).
- **C6 Cloudflare Containers:** [rates](https://developers.cloudflare.com/containers/platform/pricing/); [shapes](https://developers.cloudflare.com/containers/platform/limits/); [isolation/start](https://developers.cloudflare.com/containers/concepts/architecture/); [disk snapshots](https://developers.cloudflare.com/containers/guides/snapshots/).
- **C7 Morph:** [plans/formula/snapshot example](https://cloud.morph.so/web/pricing); [lifecycle](https://cloud.morph.so/docs/faq); [latency](https://cloud.morph.so/docs/developers).
- **C9 Northflank:** [compute/disk/egress](https://northflank.com/pricing); [sandbox isolation/billing](https://northflank.com/docs/v1/application/sandboxes/sandboxes-on-northflank-cloud); [pause semantics](https://northflank.com/docs/v1/application/sandboxes/configure-and-manage-sandboxes); [volume snapshots](https://northflank.com/docs/v1/application/databases-and-persistence/backup-and-clone-volumes.md).
- **C10 DigitalOcean:** [bundled prices](https://www.digitalocean.com/pricing/droplets); [billing/off-state/egress](https://docs.digitalocean.com/products/droplets/details/pricing/).
- **S1 R2:** [storage, requests, rounding, free egress](https://developers.cloudflare.com/r2/pricing/).
- **S2 Convex:** [Starter announcement](https://news.convex.dev/introducing-the-new-convex-starter-plan-pay-for-only-what-you-need/); [current limits/rates](https://docs.convex.dev/production/state/limits): Starter $2.20/M extra calls, $0.22/GB-mo DB storage and $0.22/GB DB I/O, $0.33/GB-h extra action compute, US rates; other regions 1.3×. Main pricing/FAQ pages were refused by fetch policy; no per-seat plan quote used in model.
- **S3 Workers/DO:** [Workers rates](https://developers.cloudflare.com/workers/platform/pricing/); [DO rates/hibernation](https://developers.cloudflare.com/durable-objects/platform/pricing/).
- **S4 Isolation/snapshots:** [Firecracker design](https://github.com/firecracker-microvm/firecracker/blob/main/docs/design.md); [snapshot responsibilities/connection limits](https://github.com/firecracker-microvm/firecracker/blob/main/docs/snapshotting/snapshot-support.md); [gVisor architecture](https://gvisor.dev/docs/architecture_guide/intro/).
- **S5 OpenCode SDK:** [2.0 announcement](https://anoma.ly/notes/opencode-2-0/); [SDK](https://opencode.ai/v2/docs/build/sdk); [workerd/DO implementation profile](https://opencode.ai/v2/docs/build/sdk/cloudflare).
- **I0 Pi registry:** [pinned package](https://registry.npmjs.org/@earendil-works/pi-ai/1.0.0); [exact provider registry](https://github.com/earendil-works/pi/blob/a13d35a742c6ef8462812a28fbe1d8c8b7431c32/packages/ai/src/providers/all.ts).
- **I1 OpenAI:** [API rates, cache and context tiers](https://developers.openai.com/api/docs/pricing).
- **I2 Anthropic:** [API rates/cache/tokenizer caveats](https://platform.claude.com/docs/en/about-claude/pricing).
- **I3 Google:** [API rates/introductory expiry](https://ai.google.dev/gemini-api/docs/pricing); [latest model identity](https://ai.google.dev/gemini-api/docs/latest-model).
- **P1 Anthropic:** [OAuth policy and Claude Code hosting exception](https://code.claude.com/docs/en/legal-and-compliance).
- **P2 OpenAI:** [open-source token sharing](https://developers.openai.com/siwc/token-sharing-open-source); [hosted approval requirement](https://developers.openai.com/cookbook/articles/sign-in-with-chatgpt.md).
- **P3 Google:** [Gemini CLI FAQ](https://geminicli.com/docs/resources/faq/); [third-party OAuth terms notice](https://geminicli.com/docs/resources/tos-privacy/).
- **K1 Amp:** [plans](https://ampcode.com/docs/pricing); [orb size rates](https://ampcode.com/docs/orbs/sizes-and-costs); [orb shape/idle policy](https://ampcode.com/docs/orbs).
- **K2 Cursor:** [new pricing](https://cursor.com/pricing); [existing pricing](https://cursor.com/help/account-and-billing/pricing); [unification eligibility](https://docs.x.ai/x-subscription/eligibility); [cloud shape](https://cursor.com/docs/cloud-agent).
- **K3 Codex:** [Plus](https://help.openai.com/en/articles/6950777-what-is-chatgpt-plus); [Pro tiers](https://help.openai.com/en/articles/9793128-about-chatgpt-pro-tiers); [credits/quotas](https://learn.chatgpt.com/docs/pricing); [cloud VMs](https://learn.chatgpt.com/docs/environments/cloud-environments).
- **K4 Devin:** [self-serve plans](https://docs.devin.ai/admin/billing/self-serve); [usage meter](https://docs.devin.ai/admin/billing/usage).
- **K5 Factory:** [individual plans](https://docs.factory.com/pricing/individuals.md); [teams](https://docs.factory.com/pricing/organizations.md); [computers](https://docs.factory.com/droid-computers/overview.md); [environment launch](https://factory.com/news/droids-now-have-a-fleet-of-sandboxes).
- **K6 OpenCode:** [model rates/client requirements](https://opencode.ai/v2/docs/console/models/); [Go plans/quotas](https://opencode.ai/v2/docs/console/go/); [billing fee](https://opencode.ai/v2/docs/console/billing).
