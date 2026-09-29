/**
 * Shot 01 — the hook (VC-464). Frame 1 is a macro on one real 0.2 ticket card
 * (VC-239), already moving; "Volli 0.2" lands inside the first half-second;
 * the camera pulls back to reveal the wall of all 175 tickets that shipped in
 * 0.2, and the count lands. The end card (end.tsx) dives back into the same
 * card, so the cut loops.
 */
import { ease, progress } from "../kit/clock";
import { FORMAT_SIZE, FrameLayer, Supers, useFilm, Vignette, type Cue, type Format } from "../kit/film";
import { Wall } from "../kit/wall";

const CUES: Record<Format, Cue[]> = {
  landscape: [
    { at: 90, until: 1750, lines: ["Volli 0.2"], size: "hero", place: "center" },
    {
      at: 2150,
      until: 4050,
      eyebrow: "v0.1.2 → v0.2.0",
      lines: ["175 tickets.", "31 days."],
      size: "large",
    },
  ],
  portrait: [
    { at: 90, until: 1750, lines: ["Volli 0.2"], size: "hero", place: "center" },
    {
      at: 2150,
      until: 4050,
      eyebrow: "v0.1.2 → v0.2.0",
      lines: ["175 tickets.", "31 days."],
      size: "large",
    },
  ],
};

export function HookShot({ format }: { format: Format }) {
  const t = useFilm();
  const size = FORMAT_SIZE[format];
  return (
    <>
      <Wall stageWidth={size.width} stageHeight={size.height} />
      <FrameLayer format={format}>
        <Vignette strength={0.45 + 0.1 * progress(t, 300, 2400, ease.inOutCubic)} />
        <Supers cues={CUES[format]} t={t} format={format} />
      </FrameLayer>
    </>
  );
}
