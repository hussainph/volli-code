/**
 * Cuts the release film (VC-464) from its shots.
 *
 *   node scripts/film/cut.mjs [--formats wide,tall] [--render [key,key]] [--only key,key] [--preview]
 *
 * --preview: a rougher, faster look at the whole edit (DSF 1/2) into
 * .film-out/preview/, never mixed with the masters.
 *
 * 1. Masters: every shot in ORDER, per format, rendered by capture.mjs at
 *    720p30 (DSF 2/3) into .film-out/masters-720p30/<key>-<format>.mp4.
 *    Existing masters are reused unless --render names them (or --render
 *    alone: all). The owner's call: 720p30 is plenty, and 4K clogs the machine.
 * 2. The cut: masters joined on hard cuts at 1280×720 / 720×1280, H.264 High,
 *    yuv420p, 30fps, +faststart:
 *      .film-out/volli-0.2-16x9-720p30.mp4
 *      .film-out/volli-0.2-9x16-720p30.mp4
 * 3. The cut sheet (.film-out/CUT-SHEET.md): every cut and beat, with timecodes
 *    for laying music under it later, and the supers with the tickets behind
 *    them. The contact sheets (.film-out/contact-sheet-{16x9,9x16}.png): the
 *    middle frame of every shot.
 * 4. The loop check: PSNR of the cut's last frame against its first.
 *
 * Shots end one frame short of their duration (capture renders t < duration),
 * so the end card's last frame is the frame BEFORE the hook's first pose, and
 * the loop has no doubled frame.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { SHOTS } from "./shots.mjs";

const desktop = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const preview = process.argv.includes("--preview");
// Masters are only valid for the DSF/FPS they were rendered at: keep them apart.
const outDir = preview ? join(desktop, ".film-out", "preview") : join(desktop, ".film-out");
const masters = join(outDir, preview ? "masters" : "masters-720p30");
// 720p30 by default: light on a shared machine, plenty for social. `--dsf 2`
// with `--fps 60` and FORMAT scales of 1920/1080 is the 4K-master path.
const FPS = 30;

/** The edit. Beats and supers are the cut sheet's; keep them in step with the shots. */
const ORDER = [
  {
    key: "hook",
    beat: "Macro on VC-239 → pull back to the wall of 175",
    supers: ["Volli 0.2", "175 tickets · 31 days — Built on its own board."],
    tickets: "v0.1.2..v0.2.0 commit subjects (175 Done tickets)",
  },
  {
    key: "picker",
    beat: "Three cards dragged over Doing; ⌥ grows the Offered list; drop",
    supers: ["VC-132 · VC-184 — Drop tickets in. Pick what runs."],
    tickets: "VC-132 Offered list + ⌥ picker; VC-184 multi-select",
  },
  {
    key: "armed",
    beat: "Countdown windows with Cancel drain; rings go working, one waiting",
    supers: ["VC-127 · VC-128 · VC-241 — Save how work starts."],
    tickets: "VC-127 Automations; VC-128 column trigger + arming; VC-241 rings working/waiting",
  },
  {
    key: "cursor",
    beat: "The Session cursor glides, clicks, lets go of the Browser Tab",
    supers: ["VC-238 · VC-239 — Agents drive the browser. You see every click."],
    tickets: "VC-238, VC-239 Browser Tab ownership + animated Session cursor",
  },
  {
    key: "island",
    beat: "Activity Island explodes into plan / subagents / shells / tabs, collapses",
    supers: [
      "VC-246 · VC-268 · VC-269 · VC-270 — Everything your agent is doing. Plans, subagents, shells — one island.",
    ],
    tickets:
      "VC-246 island; VC-268 Browser Tabs feed; VC-269 subagent feed; VC-270 background shells",
  },
  {
    key: "models",
    beat: "Down the model tier tree",
    supers: ["VC-259 — A model for every job."],
    tickets: "VC-259 model tiers",
  },
  {
    key: "limits",
    beat: "Usage-limits button → breakdown",
    supers: ["VC-263 · VC-350 · VC-376 — See your limits coming."],
    tickets: "VC-263, VC-350 usage limits; VC-376 button redesign",
  },
  {
    key: "split",
    beat: "Split created, divider resized",
    supers: ["VC-202 · VC-333 — Split view."],
    tickets: "VC-202, VC-333 split view",
  },
  {
    key: "palette",
    beat: "⌘K, @sessions narrows the list",
    supers: ["VC-205 — ⌘K, then @sessions."],
    tickets: "VC-205 command palette",
  },
  {
    key: "rail",
    beat: "Down the Now rail",
    supers: ["VC-406 — The Now rail."],
    tickets: "VC-406 Now rail",
  },
  {
    key: "scale",
    beat: "Column headers → the 10,000-ticket board as a cliff",
    supers: ["VC-316 · p50 board render — 10,000 tickets. 5.8s → 366ms."],
    tickets:
      "docs/research/perf/board-windowing-vc316.md: p50 5,797.6 ms → 365.6 ms at 10,000 tickets",
  },
  {
    key: "end",
    beat: "The mark builds; Volli 0.2 · Out now · volli.app; dive into VC-239 (loops)",
    supers: ["Volli 0.2 — Out now · volli.app"],
    tickets: "—",
  },
];

const FORMAT = {
  wide: { scale: "1280:720", label: "16x9", tile: "4x3", tileWidth: 480 },
  tall: { scale: "720:1280", label: "9x16", tile: "6x2", tileWidth: 270 },
};

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const at = args.indexOf(name);
  return at === -1 ? fallback : args[at + 1];
};
// Masters at DSF 2 are true 4K; `--dsf 1` renders them at the cut's own 1080p
// (about 3× faster) when 4K sources are not needed.
const DSF = preview ? 0.5 : Number(option("--dsf", String(2 / 3)));
const formats = option("--formats", "wide,tall").split(",");
const renderValue = args.includes("--render") ? (option("--render", undefined) ?? "") : null;
const renderAll = renderValue !== null && (renderValue === "" || renderValue.startsWith("--"));
const renderOnly = new Set(renderValue === null || renderAll ? [] : renderValue.split(","));
const only = option("--only", null);

const shots = new Map(SHOTS.map((shot) => [shot.key, shot]));
for (const { key } of ORDER)
  if (!shots.has(key)) throw new Error(`cut: no shot module for "${key}"`);
const edit = ORDER.filter(({ key }) => only === null || only.split(",").includes(key));

mkdirSync(masters, { recursive: true });

function timecode(ms) {
  const s = ms / 1000;
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${(s % 60).toFixed(2).padStart(5, "0")}`;
}

// ---- 1. masters ----------------------------------------------------------------
for (const format of formats) {
  for (const { key } of edit) {
    const master = join(masters, `${key}-${format}.mp4`);
    if (existsSync(master) && !renderAll && !renderOnly.has(key)) continue;
    console.log(`master ${key}-${format} …`);
    const started = Date.now();
    execFileSync(
      "node",
      [
        "scripts/film/capture.mjs",
        `${key}-${format}`,
        "--out",
        master,
        "--fps",
        String(FPS),
        "--dsf",
        String(DSF),
      ],
      {
        cwd: desktop,
        stdio: ["ignore", "inherit", "inherit"],
      },
    );
    console.log(`master ${key}-${format}: ${((Date.now() - started) / 1000).toFixed(0)}s`);
  }
}

// ---- 2. the cut ----------------------------------------------------------------
const outputs = {};
for (const format of formats) {
  const { scale, label } = FORMAT[format];
  const inputs = edit.flatMap(({ key }) => ["-i", join(masters, `${key}-${format}.mp4`)]);
  const chains = edit.map(
    (_, i) => `[${i}:v]scale=${scale}:flags=lanczos,fps=${FPS},setsar=1,format=yuv420p[v${i}]`,
  );
  const concat = `${edit.map((_, i) => `[v${i}]`).join("")}concat=n=${edit.length}:v=1:a=0[out]`;
  const output = join(outDir, `volli-0.2-${label}-720p30.mp4`);
  execFileSync(
    "ffmpeg",
    [
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      ...inputs,
      "-filter_complex",
      [...chains, concat].join(";"),
      "-map",
      "[out]",
      "-an",
      "-c:v",
      "libx264",
      "-profile:v",
      "high",
      "-level",
      "4.2",
      "-preset",
      "slow",
      "-crf",
      "16",
      "-pix_fmt",
      "yuv420p",
      "-r",
      String(FPS),
      "-movflags",
      "+faststart",
      output,
    ],
    { stdio: "inherit" },
  );
  outputs[format] = output;
  console.log("wrote", output);
}

// ---- 3. cut sheet + contact sheets ------------------------------------------------
let at = 0;
const rows = edit.map(({ key, beat, supers, tickets }, index) => {
  const duration = shots.get(key).durationMs;
  const row = {
    index: index + 1,
    key,
    start: at,
    end: at + duration,
    duration,
    beat,
    supers,
    tickets,
  };
  at += duration;
  return row;
});
const total = at;
const sheet = [
  "# Volli 0.2 — release film cut sheet (VC-464)",
  "",
  `Total ${timecode(total)} (${(total / 1000).toFixed(1)}s) · 60fps · both formats share this timing · hard cuts · loops end → start.`,
  "",
  "| # | In | Out | Len | Shot | Beat | Supers | Backed by |",
  "|---|----|-----|-----|------|------|--------|-----------|",
  ...rows.map(
    (row) =>
      `| ${row.index} | ${timecode(row.start)} | ${timecode(row.end)} | ${(row.duration / 1000).toFixed(1)}s | \`${row.key}\` | ${row.beat} | ${row.supers.join(" / ")} | ${row.tickets} |`,
  ),
  "",
  "Music notes: the hook's pull-back peaks at ~01.6; the automation beats (picker → armed) are one phrase;",
  "the montage (split → palette → rail) is three 1.2s hits; the end card's dive is a riser into the loop.",
  "",
];
writeFileSync(join(outDir, "CUT-SHEET.md"), sheet.join("\n"));
console.log("wrote", join(outDir, "CUT-SHEET.md"));

for (const format of formats) {
  const { label, tile, tileWidth } = FORMAT[format];
  const times = rows.map((row) => ((row.start + row.duration / 2) / 1000).toFixed(3));
  const select = times.map((time) => `lt(prev_t\\,${time})*gte(t\\,${time})`).join("+");
  const output = join(outDir, `contact-sheet-${label}.png`);
  execFileSync(
    "ffmpeg",
    [
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      outputs[format] ?? join(outDir, `volli-0.2-${label}-720p30.mp4`),
      "-vf",
      `select='${select}',scale=${tileWidth}:-1,tile=${tile}:padding=6:margin=6:color=0x222222`,
      "-frames:v",
      "1",
      "-fps_mode",
      "vfr",
      output,
    ],
    { stdio: "inherit" },
  );
  console.log("wrote", output);
}

// ---- 4. loop check ----------------------------------------------------------------
if (only === null) {
  for (const format of formats) {
    const { label } = FORMAT[format];
    const file = outputs[format];
    const first = join(outDir, `loop-first-${label}.png`);
    const last = join(outDir, `loop-last-${label}.png`);
    execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", file, "-frames:v", "1", first]);
    execFileSync("ffmpeg", [
      "-y",
      "-loglevel",
      "error",
      "-sseof",
      "-0.05",
      "-i",
      file,
      "-update",
      "1",
      last,
    ]);
    const psnr = spawnSync(
      "ffmpeg",
      ["-hide_banner", "-i", last, "-i", first, "-lavfi", "psnr", "-f", "null", "-"],
      { encoding: "utf8" },
    );
    const average = /average:([0-9.inf]+)/.exec(psnr.stderr)?.[1];
    console.log(
      `loop ${label}: last → first PSNR ${average} dB (a consecutive-frame step, not a seam, reads ~25–35 dB here)`,
    );
  }
}
