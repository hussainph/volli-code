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

/**
 * The edit, in chapters. Each chapter wears its own app theme (kit/world.tsx).
 * Supers are what the viewer reads; `source` is what backs the claim — it
 * lives in the cut sheet, never on screen.
 */
const ORDER = [
  {
    key: "hook",
    chapter: "Open · aurora",
    beat: "Tight on dozens of live sessions in the sidebar → pull back: the app floating in the world",
    supers: ["Volli 0.2 — Dozens of agents. Nothing missed."],
    source: "Sidebar sessions with working/waiting rings (VC-241); Active band (VC-30)",
  },
  {
    key: "picker",
    chapter: "Automations · lagoon",
    beat: "Three cards dragged onto Doing; the Offered automations list opens; drop",
    supers: ["New · Automations — Hand off work in one drag."],
    source: "VC-127 Automations; VC-132 Offered list + ⌥ picker; VC-184 multi-select",
  },
  {
    key: "armed",
    chapter: "Automations · lagoon",
    beat: "Countdown windows with Cancel drain; rings go working, one waiting",
    supers: ["Agents start on their own. — On a board move or a schedule."],
    source:
      "VC-128 column Trigger + arming; schedules per docs/releases/whats-new-0-2; VC-241 rings",
  },
  {
    key: "mcp",
    chapter: "Agents · cobalt",
    beat: "Settings → MCP: servers listed, one connects",
    supers: ["Plug in any MCP server."],
    source: "MCP servers in Settings → Configure → MCP (main)",
  },
  {
    key: "island",
    chapter: "Agents · cobalt",
    beat: "The activity bar explodes into plan / subagents / shells / tabs, then settles",
    supers: ["Smarter agents — See everything your agent does. Subagents, shells, browser tabs."],
    source: "VC-246 activity bar; VC-268 Browser Tabs; VC-269 subagents; VC-270 background shells",
  },
  {
    key: "cursor",
    chapter: "Agents · cobalt",
    beat: "The agent's cursor glides, clicks, hands the tab back",
    supers: ["Share a browser with your agent. — Watch every click it makes."],
    source: "VC-238 agent Browser Tabs; VC-239 Tab ownership + Session cursor",
  },
  {
    key: "split",
    chapter: "Multitasking · rose",
    beat: "One tab splits into panes side by side; dividers slide",
    supers: ["Multitasking — side by side (see shot for the exact panes)"],
    source: "VC-202, VC-333 split view tabs",
  },
  {
    key: "peek",
    chapter: "Context switching · paper (light)",
    beat: "Hover sessions in the sidebar: peek cards; open one in the overlay, reply, back",
    supers: ["Context switching — Hover to peek.", "Reply without losing your place."],
    source: "VC-30 session hover peek + shared conversation overlay (main)",
  },
  {
    key: "limits",
    chapter: "Quality of life · gold",
    beat: "The usage-limits icon beside ⌘K → the popover's bars",
    supers: ["Your limits, always in view."],
    source: "VC-263, VC-350 usage limits; VC-376 icon",
  },
  {
    key: "models",
    chapter: "Quality of life · lime",
    beat: "Refresh models → newest models; a subagent tier's default changes",
    supers: ["Newest models, one click.", "A model for every subagent."],
    source: "Model Access: Refresh models; VC-259 default model tiers (Fast/Deep/Visual)",
  },
  {
    key: "sessions",
    chapter: "Quality of life · aurora",
    beat: "The sidebar scrolls through dozens of live sessions",
    supers: ["Dozens of sessions. Still fast."],
    source: "Sidebar/board rendering work (VC-316 and the 0.2 perf passes)",
  },
  {
    key: "end",
    chapter: "End · ember (the shipped default theme)",
    beat: "The mark builds; Volli 0.2; category line; Download for Mac · volli.app; fly-through",
    supers: ["Volli 0.2 — The workspace for parallel coding agents. Download for Mac · volli.app"],
    source: "—",
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
const rows = edit.map(({ key, chapter, beat, supers, source }, index) => {
  const duration = shots.get(key).durationMs;
  const row = {
    index: index + 1,
    key,
    start: at,
    end: at + duration,
    duration,
    chapter,
    beat,
    supers,
    source,
  };
  at += duration;
  return row;
});
const total = at;
const sheet = [
  "# Volli 0.2 — product film cut sheet (VC-464)",
  "",
  `Total ${timecode(total)} (${(total / 1000).toFixed(1)}s) · ${FPS}fps · both formats share this timing · hard cuts · loops end → start.`,
  "",
  "| # | In | Out | Len | Chapter · theme | Shot | Beat | Supers | Backed by (never on screen) |",
  "|---|----|-----|-----|-----------------|------|------|--------|------------------------------|",
  ...rows.map(
    (row) =>
      `| ${row.index} | ${timecode(row.start)} | ${timecode(row.end)} | ${(row.duration / 1000).toFixed(1)}s | ${row.chapter} | \`${row.key}\` | ${row.beat} | ${row.supers.join(" / ")} | ${row.source} |`,
  ),
  "",
  "Music notes: the hook's pull-back is the first lift; each chapter change is a theme change —",
  "cut the music's phrases there. The QoL montage (limits → models → sessions) is three quick hits;",
  "the end card's fly-through is the riser into the loop.",
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
