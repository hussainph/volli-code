# Agentic product-launch video: research memo

**Research memo — 2026-08-22**

**Scope:** Current primary-source guidance and recent research on using agents to make a product-launch video, applied to Volli Code. This is a production recommendation, not a claim that a fully autonomous pipeline is ready to publish without review.

## Bottom line

Build Volli's first launch video as a **truth-first, programmatic product demo**:

1. Use real, reproducible Volli captures, the real icon, and exact programmatic text for every product claim and UI surface.
2. Use **Remotion** as the deterministic editor, renderer, and motion layer; give the coding agent Remotion's current Agent Skills rather than its deprecated MCP.
3. Use a video model only for optional, non-product B-roll or abstract transition shots. Do not ask a generative model to invent the app UI, wordmark, tiny UI text, or product behavior.
4. Let agents plan, assemble, and critique, but place a human approval gate before a scene is accepted and before the final render is published.

This is the practical convergence of the newest research: preserve a global creative brief, keep an explicit brand/claim specification, use structured intermediate artifacts, and run a separate visual-QA loop. It is substantially safer and more controllable than a single prompt that asks a model to make an entire launch film.

No video tool, API, skill, or dependency was installed for this memo, and no video was rendered.

## Recommended stack for Volli

| Job | Recommended choice | Why |
|---|---|---|
| Product truth | Actual Electron capture plus checked-in Volli assets | The repository already has a board screenshot, an SVG icon, and a local onboarding capture script that launches the built app against an isolated profile. [V1–V3] |
| Timeline, titles, callouts, captions, and final MP4 | **Remotion** | React/code-based composition gives exact text, exact assets, repeatable motion, and local or server-side rendering. Remotion maintains current Agent Skills specifically for coding agents. [S1–S4] |
| Agent guidance | `/remotion-best-practices`, then focused Remotion skills | The official skill bundle covers creation, markup, Studio preview, rendering, captions, documentation lookup, and upgrades. [S1] |
| Optional atmospheric shots | Sora, Veo, or Runway—not the product demo itself | These APIs can create short, controllable clips from prompts and/or reference images. Use them for an opening metaphor, texture, or bridge—not an alleged Volli screen. [S6–S9] |
| Rough-cut QA | Gemini video understanding plus human review | Gemini can inspect an MP4, answer timestamped questions, and process audio and video. Its default 1 FPS sampling means it should not be the only checker for fast cuts or small text. [S10] |

## What is current and operational

### Remotion is the strongest agent-native compositor here

**Fact.** Remotion now publishes Agent Skills for Claude Code, Codex, Kimi Code, and Cursor. The official bundle includes `/remotion-best-practices`, `/remotion-create`, `/remotion-markup`, `/remotion-studio`, `/remotion-render`, `/remotion-captions`, `/remotion-docs`, and more. It can be installed with:

```bash
# Before or outside a Remotion project
npx skills add remotion-dev/skills

# From inside a Remotion project
npx remotion skills add
```

[S1][S2]

**Fact.** Remotion's hosted documentation MCP is deprecated. Its own migration guidance says to install the skills and use `/remotion-docs`; the hosted MCP shutdown is no earlier than 2026-08-31. [S3]

**Fact.** Remotion can render through Studio, `npx remotion render`, server-side APIs, Lambda, or other deployment paths. Its `@remotion/renderer` package exposes server-side APIs and recommends `renderMedia()` where possible. [S4]

**Inference.** A coding agent can be responsible for the editable source of the video, while Remotion is responsible for deterministic pixels. That is a better division of labor than asking a video generator to render logo typography, screen recordings, captions, and animated UI all at once.

### Current generative-video APIs are useful as bounded ingredients

| Tool | Confirmed current capability | Best bounded use in this project |
|---|---|---|
| OpenAI Sora | The current prompting guide supports 4/8/12/16/20-second jobs, image references, editing, extensions, reusable non-human/animal characters, and 1080p landscape or portrait exports on `sora-2-pro`. It explicitly says shorter shots usually follow instructions more reliably. [S6][S7] | A 4–8 second abstract “idea becomes momentum” opening, background texture, or environmental bridge. |
| Google Veo 3.1 | Google documents 8-second 720p/1080p/4K video with native audio, landscape or portrait variants, extension, first/last-frame direction, and up to three image references. [S8] | A short, quiet transition with tightly controlled source images and a single action. |
| Runway Gen-4.5 | Runway documents an API/SDK workflow for image-to-video using a source image, a text prompt, ratio, and duration; it also supports text-only generation. [S9] | Animate a deliberately non-product keyframe when image-led art direction is preferred. |

**Decision.** For a Volli launch video, use no generated footage at all in version one unless it clearly improves the emotional hook. The product is an interface; credibility comes from the interface being real.

### A machine critic can inspect a rough cut, but not replace review

**Fact.** Gemini's video-understanding API can describe, segment, and answer questions about videos at timestamps, and it accepts files, inline data, Cloud Storage registrations, and public YouTube URLs. The guide says its default visual sampling is 1 FPS and that quick transitions may lose detail. It was last updated 2026-08-17. [S10]

**Inference.** Use an agentic video critic to return a timestamped defect list, such as:

- Does every on-screen claim appear in the approved claim list?
- Is the icon unmodified and legible at `00:47`?
- Does the sequence actually show ticket creation before parallel worktrees?
- Is any subtitle clipped, too fast, or mismatched with narration?

Use a deterministic still-frame/contact-sheet check for small text and quick moments, then have a person approve the output. A multimodal model's score is diagnostic evidence, not publishing authority.

## Research signals worth adopting—not copying blindly

All studies below are author-reported research results. They do **not** establish that an autonomous launch-video pipeline will improve Volli's launch conversion, nor were their results independently replicated for this memo.

| Work | What the authors built | Transferable lesson for Volli | Important limit |
|---|---|---|---|
| **Genflow Ad Studio** (CAIS 2026) [R1] | A typed “Brand DNA” extraction step plus a generator and two vision-language quality agents. The authors report that their self-correcting loop increased brand-compliant yield in their evaluation. | Keep a versioned `brand-and-claims` artifact separate from prompts; have a critic reject a scene rather than silently accepting it. | The result is from the authors' own 100-permutation evaluation and is not a substitute for exact programmatic brand assets. |
| **Co-Director** (arXiv, 2026-04-27) [R2] | Hierarchical agents: one globally explores creative directions, while local multimodal refinement checks story and keyframe consistency. Its GenAD-Bench contains fictional product-ad scenarios. | Lock one creative direction and make every scene inherit it; correct a failed intermediate scene before it cascades into the edit. | It is a preprint and benchmark work, not evidence of real-world launch performance. |
| **BrandFusion** (arXiv, 2026) [R3] | Five roles—brand selection, strategy, prompt refinement, critic, and experience learning—balance semantic fidelity, brand visibility, and natural integration. | Separate director/planner, producer, and critic duties. Persist accepted/rejected scene reasons so the next iteration does not repeat a failure. | Its system includes model probing/fine-tuning strategies that are unnecessary for a single product launch video. |
| **AutoCut** (arXiv, 2026) [R4] | A unified advertisement-editing system for clip selection, ordering, script generation, and music selection from video/audio/text inputs. | Treat captures as a searchable material library; model the edit as selected scene assets plus an ordered storyboard, not a freeform prompt. | The research uses purpose-built training/data pipelines; it is a design reference, not an off-the-shelf production tool. |
| **VC-LLM** (2025) [R5] | An MLLM framework that takes product information and raw clips, then selects/arranges clips and produces aligned scripts/subtitles. | Ground narration and scene selection in existing material. Do not write claims that cannot be pointed back to a capture or approved source. | This is research work; its public manuscript metadata is incomplete, so treat it as a directional result rather than a procurement recommendation. |

### The common pattern

**Inference.** The useful pattern is not “more agents.” It is a small, inspectable pipeline:

```text
Approved facts + assets
          ↓
Creative brief / story spine
          ↓
Structured storyboard and asset manifest
          ↓
Real captures + optional generated B-roll
          ↓
Remotion composition and preview render
          ↓
Automated timestamped critique + deterministic checks
          ↓
Human accept / revise decision
          ↓
Final render and platform cutdowns
```

Each arrow should have an inspectable file or render. Do not allow a later agent to rewrite approved claims or replace accepted product footage without an explicit review.

## Product-specific application to Volli

### What the video can truthfully say now

The root README describes Volli Code as a local-first macOS workspace for parallel coding agents. It says users can turn rough ideas into focused tasks, run them in parallel, and review changes in one place. It also labels the app early alpha and Apple-silicon-only. [V1]

Those are useful launch-video pillars because they can be demonstrated visually:

1. **Idea → focused task**
2. **Parallel agents → isolated ticket worktrees**
3. **Return to the task → review the changes**
4. **Local-first workspace → a calm, durable place to manage the work**

Do not add performance, security, model-quality, or productivity claims unless they enter the approved claim set with a source and owner sign-off.

### Existing material already in the workspace

- `apps/docs/src/assets/screenshots/board.png` is a checked-in board screenshot.
- `apps/desktop/build/icon-source.svg` is a source icon suitable for a programmatic title/outro.
- `apps/desktop/e2e/onboarding-shots.mjs` is a local, currently untracked capture script. It launches the built desktop app against an isolated scratch profile and captures a numbered first-hour sequence from first boot through a first agent turn. It can provide authentic stills for a first cut. [V2][V3]

**Recommendation.** Start with those capture assets and animate them in Remotion. If a true moving product recording is needed later, derive it from the same isolated-profile scenario rather than manually staging a non-reproducible demo.

## A focused agent workflow

### 1. Freeze a small truth pack

Create a human-reviewed input such as `video/brand-and-claims.json` before allowing agents to write a scene:

```json
{
  "product": "Volli Code",
  "approvedClaims": [
    "Turn rough ideas into focused tasks.",
    "Run coding agents in parallel.",
    "Review every change in one place.",
    "Local-first macOS workspace."
  ],
  "requiredDisclosures": ["Early alpha", "Apple silicon Macs"],
  "approvedAssets": [
    "apps/desktop/build/icon-source.svg",
    "apps/docs/src/assets/screenshots/board.png"
  ],
  "forbidden": [
    "Invented product UI",
    "Unapproved metrics",
    "Provider/model guarantees",
    "Modified wordmark or logo"
  ]
}
```

This is the lightweight, single-video equivalent of the research papers' brand knowledge or Brand DNA. It also lets a critic identify a factual issue without guessing what the product is allowed to claim.

### 2. Give each agent a narrow, non-overlapping role

| Role | Input | Output | Cannot do |
|---|---|---|---|
| Creative director | Truth pack, target audience, target channel | Two short story-spine options and a selected storyboard after review | Invent claims or approve its own copy |
| Capture curator | Storyboard, local app/capture scripts | Manifest of real screenshots or recordings with provenance | Replace a requested app surface with generated imagery |
| Remotion producer | Approved storyboard and asset manifest | Composition code, preview render, and frame contact sheet | Change approved claims or assets |
| Visual critic | Preview MP4, truth pack, rubric | Timestamped defects and pass/fail per criterion | Render the final publishable artifact |
| Human reviewer | Preview plus critique | Accept/revise decision | Delegate final truthfulness to the critic |

The director and critic should not be the same unreviewed agent. This mirrors the separation of generation and evaluation that appears in Genflow, BrandFusion, and Co-Director while keeping the actual workflow small.

### 3. Use a structured scene contract

A scene is easier to repair when it declares what it is allowed to show:

```ts
type LaunchScene = {
  id: string;
  frames: number;
  purpose: "hook" | "problem" | "workflow" | "proof" | "cta";
  approvedText: string[];
  visualSource: "capture" | "programmatic" | "generated-broll";
  assetPaths: string[];
  narration: string;
  qa: {
    mustShow: string[];
    mustNotShow: string[];
  };
};
```

For generated B-roll, keep `approvedText` empty and put every meaningful word, caption, logo, and UI element in Remotion instead.

### 4. Make the first creative test small

Without a declared channel, the pragmatic default is a **45–60 second 16:9 master**, then a separate **15–25 second 9:16 cutdown** after the master is accepted. A provisional Volli spine:

| Time | Beat | Evidence/visual |
|---:|---|---|
| 0–4s | Hook: a rough idea deserves a real path to done | Programmatic title over a restrained motion treatment; optional abstract B-roll only here |
| 4–13s | Turn the idea into a focused task | Real board/onboarding capture |
| 13–27s | Let focused agents work in parallel | Board and ticket-workspace captures; animated, programmatic task flow |
| 27–42s | Each task keeps its own context and worktree | Actual ticket/workspace scenes; use exact product terminology |
| 42–53s | Review the changes in one place | Real diff/review footage or a capture prepared from the app |
| 53–60s | Volli Code / early-alpha CTA | Exact SVG icon and programmatic disclosure/CTA |

This is a story architecture, not approved final copy. The target audience, channel, voice, call to action, and available moving footage should be decided before writing narration.

## Quality bar and acceptance checklist

### Deterministic checks

- Every displayed product string comes from the truth pack or real capture.
- Every logo/icon comes from an approved local source, not a generated frame.
- Every app interaction shown occurred in a reproducible capture flow.
- No source screenshot is stretched, cropped into illegibility, or presented as a live feature it does not demonstrate.
- Required alpha/platform disclosure is visible where the launch owner decides it belongs.

### Agentic review questions

Ask a video-understanding model for timestamped evidence, then independently inspect its report:

1. What is the product's one-sentence promise after the first 10 seconds?
2. Which frames demonstrate, rather than merely state, parallel agents and isolated worktrees?
3. List all readable on-screen product claims and flag claims outside the truth pack.
4. Where does the pace or visual transition make the workflow hard to follow?
5. Are captions synchronized with the narration and readable on a phone-size preview?

### Human publication gate

A person accepts the final video only after checking:

- truthfulness of every claim;
- product/UI fidelity;
- legibility at intended platform size;
- rights for music, voice, and any generated footage;
- final CTA, release status, and destination URL.

## Fastest worthwhile next step

1. Create a small, isolated Remotion project for the launch video; do not add video-rendering dependencies to the desktop app itself.
2. Install Remotion's official Agent Skills in that project.
3. Turn `onboarding-shots.mjs` output and the existing board screenshot into an asset manifest.
4. Build only the first 12–15 seconds: hook + “rough idea → focused task.”
5. Render a draft and review it against the truth pack before expanding the rest of the timeline.

That test will settle whether a real-product, Remotion-first style feels sufficiently polished before spending time or API budget on AI-generated footage.

## Sources

### Official product/tool documentation

- **[S1]** Remotion, [Agent Skills](https://www.remotion.dev/docs/ai/skills) — available skills and `npx skills add remotion-dev/skills`.
- **[S2]** Remotion, [Prompting videos with coding agents](https://www.remotion.dev/docs/ai/coding-agents) — project setup and in-project skill installation.
- **[S3]** Remotion, [MCP (deprecated)](https://www.remotion.dev/docs/ai/mcp) — migration to skills and hosted-MCP retirement notice.
- **[S4]** Remotion, [Render your video](https://www.remotion.dev/docs/render) and [`@remotion/renderer`](https://www.remotion.dev/docs/renderer) — render options and server-side APIs.
- **[S5]** Remotion, [AI plugins](https://www.remotion.dev/docs/ai/plugins) and [Codex plugin](https://www.remotion.dev/docs/ai/codex-plugin) — maintained coding-agent integrations.
- **[S6]** OpenAI, [Sora 2 Prompting Guide](https://developers.openai.com/cookbook/examples/sora/sora2_prompting_guide) — updated March 2026.
- **[S7]** OpenAI, [Video generation with Sora](https://developers.openai.com/api/docs/guides/video-generation) — API workflow, references, extensions, and edits.
- **[S8]** Google AI for Developers, [Generate videos with Veo 3.1](https://ai.google.dev/gemini-api/docs/veo).
- **[S9]** Runway, [API Getting Started Guide](https://docs.dev.runwayml.com/guides/using-the-api/).
- **[S10]** Google AI for Developers, [Video understanding](https://ai.google.dev/gemini-api/docs/video-understanding) — last updated 2026-08-17.

### Recent research

- **[R1]** [*Genflow Ad Studio: A Compound AI Architecture for Brand-Aligned, Self-Correcting Video Generation*](https://arxiv.org/html/2605.16748v1), CAIS 2026.
- **[R2]** Y. Song et al., [*Co-Director: Agentic Generative Video Storytelling*](https://arxiv.org/abs/2604.24842), arXiv:2604.24842, v1 submitted 2026-04-27.
- **[R3]** R. Wang et al., [*BrandFusion: A Multi-Agent Framework for Seamless Brand Integration in Text-to-Video Generation*](https://arxiv.org/html/2603.02816v1), arXiv:2603.02816.
- **[R4]** M. Zhou et al., [*AutoCut: End-to-end advertisement video editing based on multimodal discretization and controllable generation*](https://arxiv.org/html/2603.28366v1), arXiv:2603.28366.
- **[R5]** K. Su et al., [*VC-LLM: Automated Advertisement Video Creation from Raw Footage using Multi-modal LLMs*](https://arxiv.org/html/2504.05673v1), arXiv:2504.05673.

### Local evidence

- **[V1]** [`README.md`](../../README.md) — current public product description, early-alpha status, and platform constraint.
- **[V2]** [`apps/desktop/e2e/onboarding-shots.mjs`](../../apps/desktop/e2e/onboarding-shots.mjs) — local onboarding capture flow (currently untracked in this worktree).
- **[V3]** [`apps/docs/src/assets/screenshots/board.png`](../../apps/docs/src/assets/screenshots/board.png) and [`apps/desktop/build/icon-source.svg`](../../apps/desktop/build/icon-source.svg) — current visual assets.
