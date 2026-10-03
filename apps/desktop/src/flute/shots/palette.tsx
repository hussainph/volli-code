/**
 * Montage shot: ⌘K, then @sessions (VC-205).
 *
 * Real: the app's `CommandPalette` — the same component `ChromeBar` mounts —
 * open over the real `AppShell` (Home, the demo board), reading the real
 * projects / board / project-sessions stores. The query is typed into its
 * real `Command.Input` from scene time: each frame sets the input's value to
 * the prefix of "@sessions " that time says has been typed and fires the
 * `input` event the palette's own `onValueChange` listens to. So "@" surfaces
 * the Filter rows, "@se…" narrows them to Only sessions, and the sealing
 * space turns the token into the Sessions chip and the list into one section
 * — every step the palette's own parsing, none of it drawn here.
 *
 * The palette is a Radix dialog and portals itself to `document.body`; the
 * shot re-homes its two portal roots (the scrim and the dialog) into a
 * Surface lifted above the window, so the camera sees them in the world. Its
 * `fixed` boxes then resolve against that Surface, exactly as they resolve
 * against the window in the app.
 */
import * as React from "react";
import { Surface } from "@webprodigies/flute";

import { CommandPalette } from "@renderer/components/command-palette";

import { typed } from "../kit/clock";
import {
  FrameLayer,
  Supers,
  useFilm,
  useFixtures,
  Vignette,
  type Cue,
  type Format,
} from "../kit/film";
import { seedShell, shellApi, ShellWindow } from "../kit/split-shell";

/** The window, in lab CSS px. Mirrored by scripts/film/shots/palette.mjs. */
export const WINDOW = { width: 1600, height: 960 };
/** How far above the window the palette layer floats. */
export const LIFT = 90;

const QUERY = "@sessions ";
const T = { typeFrom: 170, perChar: 52 };

const API = shellApi();

const noop = () => undefined;

/** Radix's portal roots for the palette, wherever they currently are. */
const PORTAL_ROOTS = "[cmdk-overlay], [cmdk-dialog]";

/**
 * Moves the palette's portal roots from `<body>` into `host`, now and
 * whenever Radix mounts them. On unmount they go back to `<body>` first, so
 * React removes them from the parent it put them in.
 */
function useRehomePortals(host: React.RefObject<HTMLDivElement | null>): void {
  React.useLayoutEffect(() => {
    const target = host.current;
    if (target === null) return;
    const adopt = () => {
      for (const node of document.body.querySelectorAll<HTMLElement>(`:scope > ${PORTAL_ROOTS}`)) {
        target.append(node);
      }
    };
    adopt();
    const observer = new MutationObserver(adopt);
    observer.observe(document.body, { childList: true });
    return () => {
      observer.disconnect();
      for (const node of target.querySelectorAll<HTMLElement>(`:scope > ${PORTAL_ROOTS}`)) {
        document.body.append(node);
      }
    };
  }, [host]);
}

/** Sets the real input to `text` and fires the event React's onChange reads. */
function typeInto(input: HTMLInputElement, text: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, text);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

/**
 * The open palette with `text` typed so far. Typing only ever moves forward;
 * a seek backwards remounts the palette (see `PaletteShot`), which is the
 * palette's own reset — it clears query and scope when it closes.
 */
function TypedPalette({ text }: { text: string }) {
  const host = React.useRef<HTMLDivElement | null>(null);
  const applied = React.useRef("");
  useRehomePortals(host);
  React.useLayoutEffect(() => {
    if (text === applied.current) return;
    const input = host.current?.querySelector<HTMLInputElement>("[cmdk-input]");
    if (input === null || input === undefined) return;
    applied.current = text;
    typeInto(input, text);
  });
  // The palette focuses its input on open, and a focus scrolls every
  // overflow-hidden ancestor to reveal it — which slides the whole stage (and
  // the supers with it) sideways. Undo that scroll every frame.
  React.useLayoutEffect(() => {
    for (let node = host.current?.parentElement; node; node = node.parentElement) {
      if (node.scrollLeft !== 0) node.scrollLeft = 0;
      if (node.scrollTop !== 0) node.scrollTop = 0;
    }
    if (window.scrollX !== 0 || window.scrollY !== 0) window.scrollTo(0, 0);
  });
  return (
    <div ref={host} className="relative size-full">
      <CommandPalette open onOpenChange={noop} />
    </div>
  );
}

const CUE: Cue = {
  at: 110,
  until: 1150,
  lines: ["⌘K, then @sessions."],
  accent: "@sessions.",
  accentColor: "var(--primary)",
};

const CUES: Record<Format, Cue[]> = {
  landscape: [{ ...CUE, place: "upper" }],
  portrait: [{ ...CUE, lines: ["⌘K, then", "@sessions."], place: "upper" }],
};

export function PaletteShot({ format }: { format: Format }) {
  const t = useFilm();
  useFixtures({ api: API, seed: seedShell });
  const text = typed(QUERY, t, T.typeFrom, T.perChar);
  // A seek backwards past what the palette has already parsed remounts it.
  const generation = React.useRef({ key: 0, text: "" });
  if (!text.startsWith(generation.current.text)) generation.current.key += 1;
  generation.current.text = text;

  return (
    <>
      <Surface
        id="window"
        style={{
          position: "absolute",
          left: `calc(50% - ${WINDOW.width / 2}px)`,
          top: `calc(50% - ${WINDOW.height / 2}px)`,
          width: WINDOW.width,
          height: WINDOW.height,
        }}
        content={<ShellWindow width={WINDOW.width} height={WINDOW.height} />}
      >
        <Surface
          id="palette"
          transform={{ z: LIFT }}
          style={{
            position: "absolute",
            left: 0,
            top: -WINDOW.height,
            width: WINDOW.width,
            height: WINDOW.height,
          }}
          content={<TypedPalette key={generation.current.key} text={text} />}
        />
      </Surface>
      <FrameLayer format={format}>
        <Vignette strength={0.6} />
        <Supers cues={CUES[format]} t={t} format={format} />
      </FrameLayer>
    </>
  );
}
