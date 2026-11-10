/**
 * Real chat markdown and reasoning, with invented public-safe fixtures only.
 * Simulated wiring: replay advances a string; there is no Session or provider.
 * Theme presets use the production store's memory-only preview path, hence the
 * real canvas generator, and paint <html> so fullscreen portals inherit too.
 */
import * as React from "react";
import { DEFAULT_CANVAS, type Canvas } from "@volli/shared";

import { ContentColumn } from "@renderer/components/layout/content-column";
import {
  Message,
  MessageContent,
  MessageResponse,
} from "@renderer/components/ui/ai-elements/message";
import { ReasoningBody } from "@renderer/components/ui/ai-elements/reasoning";
import { Button } from "@renderer/components/ui/button";
import { effectiveAppearance, effectiveCanvas, useThemeStore } from "@renderer/stores/theme";

export const title = "Chat · Pele diagrams";
export const note = "Real response and reasoning · invented diagrams · simulated streaming";
export const viewport = "stage" as const;

const CANVASES: { label: string; value: Canvas }[] = [
  { label: "Default", value: DEFAULT_CANVAS },
  {
    label: "Saturated",
    value: {
      ...DEFAULT_CANVAS,
      stops: [
        { hex: "#6138ed", x: 0.2, y: 0.25 },
        { hex: "#ed2874", x: 0.8, y: 0.7 },
      ],
      vibrancy: 1,
    },
  },
  {
    label: "Pale",
    value: {
      ...DEFAULT_CANVAS,
      stops: [{ hex: "#dbeade", x: 0.68, y: 0.3 }],
      vibrancy: 0.08,
      grain: 0,
    },
  },
];

function fence(source: string): string {
  return `\`\`\`mermaid\n${source}\n\`\`\``;
}

const FLOWCHART = fence(`flowchart LR
  subgraph Garden[Community garden]
    Seeds[Seed library] --> Beds[Planting beds]
    Beds --> Harvest[Harvest basket]
  end
  subgraph Kitchen[Neighbourhood kitchen]
    Wash[Wash vegetables] --> Cook[Cook soup]
    Cook --> Share[Share a meal]
  end
  Harvest --> Wash
  Share --> Compost[Compost scraps]
  Compost --> Beds`);

const SEQUENCE = fence(`sequenceDiagram
  participant Reader
  participant Library
  participant Shelf
  Reader->>Library: Request a book
  Library->>Shelf: Check availability
  alt Book available
    Shelf-->>Library: Copy ready
    Library-->>Reader: Reserve for collection
  else All copies borrowed
    Shelf-->>Library: No copy available
    Library-->>Reader: Offer a waiting list
  end`);

const STATE = fence(`stateDiagram-v2
  [*] --> Draft
  Draft --> Ready: Proofread
  Ready --> Printing: Approve
  Printing --> Ready: Revise
  Printing --> Published: Bind
  Published --> [*]`);

// Eight slices deliberately exercise all eight mapped series, not just the
// first two. Labels and quantities are invented, not harvested from history.
const PIE = fence(`pie title Garden planting plan
  "Tomatoes" : 20
  "Peas" : 16
  "Carrots" : 14
  "Beans" : 12
  "Squash" : 11
  "Herbs" : 10
  "Lettuce" : 9
  "Flowers" : 8`);

const XYCHART = fence(`xychart-beta
  title "Library visitors"
  x-axis [Mon, Tue, Wed, Thu, Fri]
  y-axis "Visitors" 0 --> 100
  bar [30, 45, 38, 62, 80]
  line [28, 40, 44, 58, 72]`);

const GALLERY = [
  { title: "Flowchart · subgraphs and a return edge", source: FLOWCHART },
  { title: "Sequence · alternative paths", source: SEQUENCE },
  { title: "State · start, transitions and finish", source: STATE },
  { title: "Pie · eight series", source: PIE },
  { title: "XY chart · bars and line", source: XYCHART },
];

const REPLAY_SOURCE = `Here is a small garden-to-kitchen workflow.\n\n${FLOWCHART}\n\nThe library has two possible outcomes.\n\n${SEQUENCE}\n\nThe booklet moves through these states.\n\n${STATE}\n\nAll three diagrams are complete.`;
const REPLAY_CHUNK = 13;
const REPLAY_INTERVAL_MS = 40;

function ThemeChoices() {
  const canvas = useThemeStore(effectiveCanvas);
  const appearance = useThemeStore(effectiveAppearance);

  return (
    <div className="flex flex-wrap items-center gap-4">
      <fieldset className="flex flex-wrap items-center gap-2">
        <legend className="mb-2 text-label uppercase text-muted-foreground">Canvas</legend>
        {CANVASES.map((choice) => (
          <Button
            key={choice.label}
            variant={canvas === choice.value ? "secondary" : "ghost"}
            aria-pressed={canvas === choice.value}
            onClick={() => useThemeStore.getState().startPreview(choice.value)}
          >
            {choice.label}
          </Button>
        ))}
      </fieldset>
      <fieldset className="flex items-center gap-2">
        <legend className="mb-2 text-label uppercase text-muted-foreground">Appearance</legend>
        {(["light", "dark"] as const).map((mode) => (
          <Button
            key={mode}
            variant={appearance === mode ? "secondary" : "ghost"}
            aria-pressed={appearance === mode}
            onClick={() => useThemeStore.getState().startAppearancePreview(mode)}
          >
            {mode === "light" ? "Light" : "Dark"}
          </Button>
        ))}
      </fieldset>
    </div>
  );
}

function StreamingReplay() {
  const [position, setPosition] = React.useState(REPLAY_SOURCE.length);
  const [playing, setPlaying] = React.useState(false);
  const isAnimating = position < REPLAY_SOURCE.length;

  React.useEffect(() => {
    if (!playing) return;
    const timer = window.setInterval(() => {
      setPosition((current) => Math.min(REPLAY_SOURCE.length, current + REPLAY_CHUNK));
    }, REPLAY_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [playing]);

  React.useEffect(() => {
    if (!isAnimating) setPlaying(false);
  }, [isAnimating]);

  return (
    <section aria-labelledby="pele-replay-title" className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 id="pele-replay-title" className="mr-auto text-sm font-medium">
          Streaming replay
        </h2>
        <Button
          variant="outline"
          onClick={() => {
            setPosition(0);
            setPlaying(true);
          }}
        >
          Replay
        </Button>
        <Button
          variant="ghost"
          disabled={!isAnimating}
          onClick={() => setPlaying((current) => !current)}
        >
          {playing ? "Pause" : "Resume"}
        </Button>
        <Button
          variant="ghost"
          disabled={!isAnimating}
          onClick={() => {
            setPosition(REPLAY_SOURCE.length);
            setPlaying(false);
          }}
        >
          Settle
        </Button>
        <span role="status" className="text-ui text-muted-foreground">
          {!isAnimating ? "Settled" : playing ? "Streaming" : "Paused · turn still open"}
        </span>
      </div>
      <label className="flex items-center gap-2 text-ui text-muted-foreground">
        Replay position
        <input
          className="min-w-0 flex-1 accent-primary"
          type="range"
          min={0}
          max={REPLAY_SOURCE.length}
          value={position}
          onChange={(event) => {
            setPosition(Number(event.currentTarget.value));
            setPlaying(false);
          }}
        />
      </label>
      <Message from="assistant" className="max-w-full">
        <MessageContent className="w-full">
          {/* A paused replay still represents a live Turn. Only the final
              character (or Settle) clears isAnimating, as production does. */}
          <MessageResponse isAnimating={isAnimating}>
            {REPLAY_SOURCE.slice(0, position)}
          </MessageResponse>
        </MessageContent>
      </Message>
    </section>
  );
}

export default function PeleDiagrams() {
  return (
    <div className="min-h-full bg-card text-foreground">
      <ContentColumn className="space-y-6 pt-8 pb-16">
        <header className="space-y-4">
          <h1 className="text-heading font-medium">Pele diagrams</h1>
          <ThemeChoices />
        </header>
        <StreamingReplay />
        {GALLERY.map((fixture) => (
          <section key={fixture.title} aria-label={fixture.title} className="space-y-2">
            <h2 className="text-sm font-medium">{fixture.title}</h2>
            <Message from="assistant" className="max-w-full">
              <MessageContent className="w-full">
                <MessageResponse>{fixture.source}</MessageResponse>
              </MessageContent>
            </Message>
          </section>
        ))}
        <section aria-label="User bubble surface" className="space-y-2">
          <h2 className="text-sm font-medium">User · muted bubble</h2>
          <Message from="user" className="max-w-full">
            <MessageContent className="w-full">
              <MessageResponse>{STATE}</MessageResponse>
            </MessageContent>
          </Message>
        </section>
        <section aria-label="Reasoning diagram surface" className="space-y-2">
          <h2 className="text-sm font-medium">Reasoning · muted inset</h2>
          <ReasoningBody className="rounded-md border border-border bg-muted/30 p-2">
            {`I will check both possible outcomes before reserving a copy.\n\n${SEQUENCE}`}
          </ReasoningBody>
        </section>
      </ContentColumn>
    </div>
  );
}
