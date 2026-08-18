/**
 * The composer-picker rig, glassified — a duplicate of the composer-picker
 * scratch (retired in the lab cleanup; this copy is its surviving carrier)
 * with Apple's Liquid Glass material language applied to the control layer,
 * so the two can be judged side by side (the Off setting IS the original).
 *
 * The question this scratch answers: does an Apple-style glass control layer
 * suit Volli's canvas, and what does it cost us? The recipe follows the HIG's
 * Materials chapter (https://developer.apple.com/design/human-interface-guidelines/materials):
 *
 *   • Glass belongs to the FLOATING CONTROLS LAYER, never the content. Here
 *     that is the bottom mount: composer, picker card, interaction cards. The
 *     feed stays opaque and scrolls edge-to-edge beneath the glass — which is
 *     why the mount's own `bg-background` band is gone in glass mode.
 *   • Two materials, mirroring the HIG's variants: REGULAR (adaptive-ish tint,
 *     works over anything) and CLEAR (barely-there, needs a dimming layer —
 *     provided by the scroll-edge effect, which doubles as the HIG's
 *     legibility gradient under bottom bars).
 *   • Refraction, not just frost: a `backdrop-filter: url(#…)` SVG
 *     displacement map bends the backdrop near the shell's edges, which is
 *     the "liquid" half of the material. Chromium-only syntax — fine, we ship
 *     Chromium — with a plain blur+saturate declaration as the parse-time
 *     fallback.
 *
 * How the override works: everything in the composer stack shares
 * `COMPOSER_STACK_SHELL` (`…bg-card shadow-raised`), so a scoped
 * `.lab-glass .bg-card` rule re-skins the whole stack — composer, `/` and `@`
 * picker card, question/permission cards — without touching any component.
 * That is also the honest finding so far: adopting glass for real would mean
 * giving surfaces like the stack shell a MATERIAL axis in the token pipeline,
 * not editing components one by one.
 *
 * What this cannot show: real Liquid Glass refracts the desktop behind the
 * window and answers pointer pressure with a gel flex. This refracts only our
 * own feed. Scroll the feed to see the material work; try both appearances
 * and a few canvases from the lab toolbar — adaptivity is where glass lives
 * or dies.
 */
import * as React from "react";
import {
  promptId,
  type IndexedFile,
  type PromptTemplate,
  type RendererSessionInteraction,
} from "@volli/shared";

import {
  SessionComposer,
  type ComposerModelSelection,
} from "@renderer/components/chat/composer-ui";
import { ComposerInteractionStack } from "@renderer/components/chat/interaction-ui";
import { ContentColumn } from "@renderer/components/layout/content-column";
import { Button } from "@renderer/components/ui/button";
import { useMeasuredHeight } from "@renderer/hooks/use-measured-height";
import { cn } from "@renderer/lib/utils";

export const title = "Liquid glass · composer";
export const note =
  "The composer-picker rig with HIG glass on the control layer — Off is the shipped look; scroll the feed under it";

type GlassMaterial = "off" | "regular" | "clear";

const MATERIALS: readonly { id: GlassMaterial; label: string }[] = [
  { id: "off", label: "Off" },
  { id: "regular", label: "Regular" },
  { id: "clear", label: "Clear" },
];

/**
 * The displacement map: R encodes x-shift, G encodes y-shift, #808080 is
 * "don't move". Two full-bleed channel ramps under a blurred neutral rounded
 * rect leave displacement only in a soft band around the edges — which is
 * where Liquid Glass lenses. Stretched (`preserveAspectRatio: none`) to
 * whatever size the shell happens to be, so the band thickness breathes a
 * little with the composer; acceptable for a lab answer.
 */
const LENS_MAP = `<svg xmlns='http://www.w3.org/2000/svg' width='640' height='160'>
  <defs>
    <linearGradient id='x' x1='0' y1='0' x2='1' y2='0'>
      <stop offset='0' stop-color='#000'/><stop offset='1' stop-color='#f00'/>
    </linearGradient>
    <linearGradient id='y' x1='0' y1='0' x2='0' y2='1'>
      <stop offset='0' stop-color='#000'/><stop offset='1' stop-color='#0f0'/>
    </linearGradient>
    <filter id='b'><feGaussianBlur stdDeviation='7'/></filter>
  </defs>
  <rect width='640' height='160' fill='url(#x)'/>
  <rect width='640' height='160' fill='url(#y)' style='mix-blend-mode:screen'/>
  <rect x='14' y='14' width='612' height='132' rx='18' fill='#808080' filter='url(#b)'/>
</svg>`;

const LENS_MAP_URI = `data:image/svg+xml,${encodeURIComponent(LENS_MAP)}`;

/**
 * The material itself, scoped so only the bottom mount is re-skinned. Written
 * against tokens (`--card`, `--border`, `--background`) so it tracks the lab
 * toolbar's canvas and appearance switches — the closest we can get to the
 * HIG's "adapts to what is behind it" without sampling the backdrop.
 *
 * The `backdrop-filter` triple is deliberate: `-webkit-` first, the plain
 * blur+saturate as the fallback that survives if `url()` filters ever stop
 * parsing, and the lensed declaration last so it wins where supported.
 */
const GLASS_CSS = `
.lab-glass .bg-card {
  border-color: color-mix(in srgb, var(--border) 35%, transparent);
  box-shadow:
    inset 0 1px 0 0 rgb(255 255 255 / 0.22),
    inset 0 0 0 1px rgb(255 255 255 / 0.08),
    0 16px 40px -16px rgb(0 0 0 / 0.5);
}
/* REGULAR "blurs and adjusts the luminosity of background content to
   maintain legibility" (HIG). Luminosity moves TOWARD contrast with the
   foreground: dark appearance darkens the backdrop under light text, light
   appearance brightens it under dark text. */
.lab-glass-regular .bg-card {
  background: linear-gradient(
    color-mix(in oklab, var(--card) 55%, transparent),
    color-mix(in oklab, var(--card) 38%, transparent)
  );
  -webkit-backdrop-filter: blur(5px) saturate(1.5) brightness(0.85);
  backdrop-filter: blur(5px) saturate(1.5) brightness(0.85);
  backdrop-filter: blur(5px) saturate(1.5) brightness(0.85) url(#lab-glass-lens);
}
:root.light .lab-glass-regular .bg-card {
  -webkit-backdrop-filter: blur(5px) saturate(1.5) brightness(1.08);
  backdrop-filter: blur(5px) saturate(1.5) brightness(1.08);
  backdrop-filter: blur(5px) saturate(1.5) brightness(1.08) url(#lab-glass-lens);
}
.lab-glass-clear .bg-card {
  background: linear-gradient(
    color-mix(in oklab, var(--card) 20%, transparent),
    color-mix(in oklab, var(--card) 10%, transparent)
  );
  -webkit-backdrop-filter: blur(2px) saturate(1.8);
  backdrop-filter: blur(2px) saturate(1.8);
  backdrop-filter: blur(2px) saturate(1.8) url(#lab-glass-lens);
}
/* The HIG's scroll-edge effect: a soft fade-out blur under a bottom bar, so
   content dims and softens as it slides beneath the glass. For CLEAR this is
   load-bearing rather than nice — it is the dimming layer the HIG requires
   before clear glass is allowed at all. */
.lab-glass-edge {
  -webkit-backdrop-filter: blur(10px);
  backdrop-filter: blur(10px);
  -webkit-mask-image: linear-gradient(to top, black 45%, transparent);
  mask-image: linear-gradient(to top, black 45%, transparent);
  background: linear-gradient(
    to top,
    color-mix(in srgb, var(--background) 45%, transparent) 35%,
    transparent
  );
}
/* CLEAR is only allowed over content that stays legible through it. The HIG:
   bright underlying content wants a DARK dimming layer at ~35%; sufficiently
   dark content wants none. Our dark appearance is the "sufficiently dark"
   case, so only the light appearance gets the scrim. */
:root.light .lab-glass-clear .lab-glass-edge {
  background: linear-gradient(to top, rgb(0 0 0 / 0.35) 35%, transparent);
}
:root:not(.light) .lab-glass-clear .lab-glass-edge {
  background: linear-gradient(
    to top,
    color-mix(in srgb, var(--background) 40%, transparent) 35%,
    transparent
  );
}
`;

/** The refraction lens, referenced by the `backdrop-filter: url()` above. */
function LensFilter() {
  return (
    <svg aria-hidden className="pointer-events-none absolute h-0 w-0">
      <filter
        id="lab-glass-lens"
        x="0"
        y="0"
        width="100%"
        height="100%"
        colorInterpolationFilters="sRGB"
      >
        <feImage
          href={LENS_MAP_URI}
          x="0"
          y="0"
          width="100%"
          height="100%"
          preserveAspectRatio="none"
          result="map"
        />
        <feDisplacementMap
          in="SourceGraphic"
          in2="map"
          scale="48"
          xChannelSelector="R"
          yChannelSelector="G"
        />
      </filter>
    </svg>
  );
}

/* ——— Everything below is the composer-picker rig, unchanged except where
       marked GLASS. The original scratch is retired; its full rationale lives
       in git history (lab/scratches/composer-picker.tsx). ——— */

const TEMPLATES: readonly PromptTemplate[] = [
  {
    name: "review",
    description: "Review a file for bugs and style",
    content: "Review $1 for bugs and style. Be specific about line numbers.",
  },
  {
    name: "refactor",
    description: "Refactor with a named goal",
    content: "Refactor $1 so that $ARGUMENTS. Keep the public interface unchanged.",
  },
  {
    name: "ship",
    description: "Open a pull request for the work so far",
    content: "Summarise the work so far, then open a pull request for it.",
  },
  {
    name: "explain",
    description: "Walk me through what this does",
    content: "Walk me through $1 line by line. Assume I have not seen it before.",
  },
  { name: "tidy", description: "", content: "Tidy the working tree and drop dead code." },
];

const FILES: readonly IndexedFile[] = [
  { relPath: "src/main/index.ts", kind: "other", artifact: false },
  { relPath: "src/renderer/src/app.tsx", kind: "other", artifact: false },
  { relPath: "src/renderer/src/components/chat/composer-ui.tsx", kind: "other", artifact: false },
  { relPath: "src/main/db/index.ts", kind: "other", artifact: false },
  { relPath: "src/renderer/src/stores/index.ts", kind: "other", artifact: false },
  { relPath: "packages/shared/src/index.ts", kind: "other", artifact: false },
  { relPath: "docs/DESIGN.md", kind: "markdown", artifact: false },
  { relPath: "README.md", kind: "markdown", artifact: false },
  { relPath: ".volli/artifacts/composer-notes.md", kind: "markdown", artifact: true },
  { relPath: ".volli/artifacts/index.md", kind: "markdown", artifact: true },
];

const SELECTION: ComposerModelSelection = {
  providerId: "anthropic",
  modelId: "sonnet-4.5",
  reasoningLevel: "high",
};

const QUESTION: RendererSessionInteraction = {
  id: "q1",
  attachmentId: "a1",
  kind: "question",
  title: "Which branch should this land on?",
  detail: null,
  options: [
    { id: "main", label: "main", description: null },
    { id: "release", label: "release/2.1", description: null },
  ],
  multiple: false,
  native: { id: null, detail: null },
};

const PERMISSION: RendererSessionInteraction = {
  id: "q2",
  attachmentId: "a2",
  kind: "permission",
  title: "Run `pnpm build` in the worktree?",
  detail: "Writes to apps/desktop/out and packages/*/dist.",
  options: [
    { id: "once", label: "Allow once", description: null },
    { id: "always", label: "Always allow pnpm build", description: "For this project" },
    { id: "deny", label: "Deny", description: null },
  ],
  multiple: false,
  prompts: [
    {
      id: promptId(0),
      label: "Run `pnpm build` in the worktree?",
      detail: "Writes to apps/desktop/out and packages/*/dist.",
      options: [
        { id: "once", label: "Allow once", description: null },
        { id: "always", label: "Always allow pnpm build", description: "For this project" },
        { id: "deny", label: "Deny", description: null },
      ],
      multiple: false,
      custom: false,
    },
    {
      id: promptId(1),
      label: "And push the branch when it succeeds?",
      detail: null,
      options: [
        { id: "push", label: "Push to origin", description: "volli/VC-12-composer-stack" },
        { id: "pr", label: "Push and open a pull request", description: null },
        { id: "hold", label: "Hold", description: "Leave the commits local" },
        { id: "deny", label: "Deny", description: null },
      ],
      multiple: false,
      custom: true,
    },
  ],
  native: { id: null, detail: null },
};

/**
 * GLASS: longer than the original's feed on purpose. The original only needed
 * enough transcript to scroll a line's width; a glass demo needs enough that
 * mid-scroll puts real content BENEATH the shell — at bottom rest the
 * clearance contract keeps everything above the composer, which is exactly
 * why the first cut of this scratch showed no glass at all.
 */
const FEED = [
  "Walk me through how the composer decides what to complete.",
  "It reads the caret, not the keystroke. `/` counts at a word boundary; `@` counts at any ref boundary.",
  "And when the list is open, who owns Enter?",
  "The list does, but only while it is open — the textarea keeps focus throughout and forwards the key.",
  "Where does the file index come from?",
  "The worktree walker, filtered by the ignore rules — artifacts are indexed separately and get their own column.",
  "Does the picker ever take focus from the textarea?",
  "Never. It is a rendering of the caret's state, not a control of its own — arrows steer it, the caret stays put.",
  "What happens to a message that starts with a command the project does not define?",
  "It goes out as written. An unknown command is a sentence that starts with a slash, not an error.",
  "Last one: does the transcript show the command or the prompt it expanded to?",
  "The prompt, because that is what was sent. THIS LINE MUST STAY VISIBLE WHEN THE PICKER OPENS.",
];

interface FeedItem {
  id: string;
  kind: "line" | "strip";
  text?: string;
  seed?: number;
  /** Answers render boxed, questions plain — the original's even/odd rhythm. */
  boxed?: boolean;
  last?: boolean;
}

/**
 * Two passes over the transcript with a colour strip every four lines. The
 * repetition is not laziness: at 44rem the frame needs roughly two screens of
 * overflow before mid-scroll can hold a strip UNDER the shell, and the first
 * two cuts of this scratch proved a short feed clamps every scroll attempt
 * back to "nothing behind the glass".
 */
const FEED_ITEMS: readonly FeedItem[] = (() => {
  const items: FeedItem[] = [0, 1].flatMap((pass) => {
    const passItems: FeedItem[] = [];
    FEED.forEach((text, index) => {
      passItems.push({ id: `p${pass}-l${index}`, kind: "line", text, boxed: index % 2 === 1 });
      if (index % 4 === 3)
        passItems.push({ id: `p${pass}-s${index}`, kind: "strip", seed: pass + index });
    });
    return passItems;
  });
  // `data-last-message` belongs to the last LINE — the feed deliberately ends
  // on a strip (rich content nearest the glass), which must not steal it.
  const lastLine = items.findLast((item) => item.kind === "line");
  if (lastLine !== undefined) lastLine.last = true;
  return items;
})();

/**
 * GLASS: saturated content for the backdrop to act on. Plain prose barely
 * exercises a refractive material — Apple's own demos lean on photos. These
 * swatch cards are the feed's stand-in for rich content: scroll them under
 * the shell and the lens, blur and saturation boost all become visible.
 */
function ColorStrip({ seed }: { seed: number }) {
  const gradients = [
    "linear-gradient(135deg, #f97316, #db2777)",
    "linear-gradient(135deg, #22d3ee, #6366f1)",
    "linear-gradient(135deg, #a3e635, #059669)",
    "linear-gradient(135deg, #fbbf24, #dc2626)",
    "linear-gradient(135deg, #e879f9, #7c3aed)",
  ];
  return (
    <div className="flex gap-2" aria-hidden data-color-strip>
      {gradients.map((background, index) => (
        <div
          key={background}
          className="h-24 flex-1 rounded-lg"
          style={{ background, opacity: (seed + index) % 2 === 0 ? 1 : 0.85 }}
        />
      ))}
    </div>
  );
}

export default function LiquidGlassComposerScratch() {
  const [material, setMaterial] = React.useState<GlassMaterial>("regular");
  const [value, setValue] = React.useState("");
  const [sent, setSent] = React.useState<string | null>(null);
  const [interaction, setInteraction] = React.useState<RendererSessionInteraction | null>(null);
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);
  const composerHeight = useMeasuredHeight<HTMLDivElement>();
  const feedRef = React.useRef<HTMLDivElement>(null);

  React.useLayoutEffect(() => {
    const node = feedRef.current;
    if (node !== null) node.scrollTop = node.scrollHeight;
    // The original pins on every render; here only on mount, so scrolling the
    // feed to look through the glass is not snapped back by a re-render.
  }, []);

  const [pendingSeed, setPendingSeed] = React.useState<string | null>(null);
  React.useLayoutEffect(() => {
    if (pendingSeed === null) return;
    setPendingSeed(null);
    const node = textareaRef.current;
    if (node === null) return;
    node.focus();
    node.setSelectionRange(pendingSeed.length, pendingSeed.length);
    document.dispatchEvent(new Event("selectionchange"));
  }, [pendingSeed]);
  const seed = (text: string): void => {
    setValue(text);
    setPendingSeed(text);
  };

  return (
    <div className="flex flex-col gap-4">
      <style>{GLASS_CSS}</style>
      <LensFilter />

      <div className="flex flex-wrap items-center gap-2">
        {[QUESTION, PERMISSION].map((request) => (
          <Button
            key={request.id}
            type="button"
            size="sm"
            variant={interaction?.id === request.id ? "default" : "outline"}
            onClick={() =>
              setInteraction((current) => (current?.id === request.id ? null : request))
            }
          >
            {request.kind === "permission" ? "Permission" : "Question"}
          </Button>
        ))}
        <Button type="button" size="sm" variant="outline" onClick={() => seed("/")}>
          Seed /
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={() => seed("look at @src/")}>
          Seed @
        </Button>

        {/* GLASS: the A/B control. Off is the shipped shell, untouched. */}
        <div className="ml-auto flex items-center gap-1 rounded-full border border-border p-0.5">
          {MATERIALS.map((option) => (
            <button
              key={option.id}
              type="button"
              onClick={() => setMaterial(option.id)}
              aria-pressed={option.id === material}
              className="rounded-full px-2.5 py-0.5 text-label text-muted-foreground transition-colors hover:text-foreground aria-pressed:bg-accent aria-pressed:text-foreground"
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      <div
        className="relative flex h-[44rem] min-h-0 flex-col overflow-hidden rounded-xl border border-border bg-background"
        style={{ "--composer-height": `${composerHeight.height}px` } as React.CSSProperties}
      >
        <div ref={feedRef} className="min-h-0 flex-1 overflow-y-auto">
          <ContentColumn>
            <div className="flex flex-col gap-4 pt-6 pb-[calc(var(--composer-height)+2rem)]">
              {FEED_ITEMS.map((item) =>
                item.kind === "strip" ? (
                  <ColorStrip key={item.id} seed={item.seed ?? 0} />
                ) : (
                  <p
                    key={item.id}
                    data-last-message={item.last ? "" : undefined}
                    className={
                      item.boxed
                        ? "rounded-lg bg-muted/50 p-3 text-sm text-muted-foreground"
                        : "text-sm text-foreground"
                    }
                  >
                    {item.text}
                  </p>
                ),
              )}
              {sent === null ? null : (
                <pre className="rounded-lg border border-border bg-muted/40 p-3 text-xs whitespace-pre-wrap text-muted-foreground">
                  {sent}
                </pre>
              )}
            </div>
          </ContentColumn>
        </div>

        {/* GLASS: in glass mode the mount's opaque band goes away — the HIG's
            content layer runs edge-to-edge beneath the bar — and the
            scroll-edge effect takes over the legibility job. */}
        <div
          ref={composerHeight.ref}
          className={cn(
            "pointer-events-none absolute inset-x-0 bottom-0 pb-4",
            material === "off" && "bg-background",
            material !== "off" && "lab-glass",
            material === "regular" && "lab-glass-regular",
            material === "clear" && "lab-glass-clear",
          )}
        >
          {material === "off" ? null : (
            <div aria-hidden className="lab-glass-edge absolute inset-x-0 -top-6 bottom-0" />
          )}
          <div className="relative">
            <ContentColumn>
              <ComposerInteractionStack
                interaction={interaction}
                onResolve={() => setInteraction(null)}
                onWithdraw={() => setInteraction(null)}
              >
                <SessionComposer
                  value={value}
                  onValueChange={setValue}
                  textareaRef={textareaRef}
                  onComposerFocusRequest={() => textareaRef.current?.focus()}
                  promptTemplates={TEMPLATES}
                  files={FILES}
                  interactionOpen={interaction !== null}
                  models={[]}
                  selection={SELECTION}
                  onSelectionChange={() => undefined}
                  working={false}
                  ready
                  queued={[]}
                  onQueuedChange={() => undefined}
                  onSteerQueued={() => undefined}
                  onSubmit={(text) => {
                    setSent(text);
                    setValue("");
                  }}
                  onStop={() => undefined}
                />
              </ComposerInteractionStack>
            </ContentColumn>
          </div>
        </div>
      </div>
    </div>
  );
}
