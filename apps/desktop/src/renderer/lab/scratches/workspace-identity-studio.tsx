/** VC-489, atelier pass. An ambitious, deliberately lab-only identity editor.
 * Suggestions are a deterministic LOCAL Jev stand-in, labeled as such. No
 * provider request, project creation, settings write, or durable receipt occurs.
 * Selection-time identity survives name edits; only explicit choices change it.
 */
import * as React from "react";
import { SparkleIcon } from "@phosphor-icons/react/dist/csr/Sparkle";
import { ArrowUpRightIcon } from "@phosphor-icons/react/dist/csr/ArrowUpRight";
import { CheckIcon } from "@phosphor-icons/react/dist/csr/Check";
import { SealCheckIcon } from "@phosphor-icons/react/dist/csr/SealCheck";
import { ShuffleIcon } from "@phosphor-icons/react/dist/csr/Shuffle";
import { ImageIcon } from "@phosphor-icons/react/dist/csr/Image";
import { DEFAULT_CANVAS, canvasBackground, type Canvas } from "@volli/shared";

import { Button } from "@renderer/components/ui/button";
import { Input } from "@renderer/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from "@renderer/components/ui/dialog";
import { StatusDot } from "@renderer/components/ui/status-dot";
import { sessionAttentionRank } from "@renderer/components/ui/session-activity-status";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@renderer/components/ui/tooltip";
import { useThemeStore, effectiveAppearance } from "@renderer/stores/theme";

import { GLYPH_CATALOG, suggestGlyphs, type GlyphName } from "../workspace-identity/model";
import {
  GLYPH_COMPONENTS,
  HeroMark,
  IdentityMark,
  SURFACES,
  type StudioChoice,
  type StudioSurface,
  type MonogramStyle,
} from "../workspace-identity/marks";
import {
  readWorkspaceSession,
  visibleWorkspaceSessions,
  workspaceFixtures,
  workspaceSummary,
  workspaceSummaryLabel,
  type WorkspaceFixture,
} from "./workspace-icons-model";
import "../workspace-identity/studio.css";

export const title = "Workspace atelier · a little character";
export const note =
  "Engraved glyphs, Jev-style suggestions, monograms, tiny stamps, and a rail rehearsal";
export const viewport = "window" as const;

const INITIAL_GLYPHS: Record<string, GlyphName> = {
  volli: "code",
  canopy: "tree",
  paper: "scroll",
  cinder: "flame",
  archive: "archive",
  long: "git-branch",
};
const MODES = { glyph: "Icon", initials: "Initials", stamp: "Stamp", custom: "Your mark" } as const;
const MONOGRAMS: Record<MonogramStyle, string> = {
  editorial: "Editorial",
  architect: "Architect",
  woven: "Woven",
};
const DRAFT_ID = "studio-draft";
const PALETTES: { name: string; canvas: Canvas | null }[] = [
  { name: "Inherited", canvas: null },
  {
    name: "Tidal",
    canvas: {
      ...DEFAULT_CANVAS,
      stops: [
        { hex: "#427d98", x: 0.2, y: 0.2 },
        { hex: "#7d7ab5", x: 0.85, y: 0.8 },
      ],
    },
  },
  {
    name: "Orchard",
    canvas: {
      ...DEFAULT_CANVAS,
      stops: [
        { hex: "#59876b", x: 0.2, y: 0.2 },
        { hex: "#b49757", x: 0.85, y: 0.8 },
      ],
    },
  },
  {
    name: "Afterglow",
    canvas: {
      ...DEFAULT_CANVAS,
      stops: [
        { hex: "#ba765c", x: 0.2, y: 0.2 },
        { hex: "#9272a6", x: 0.85, y: 0.8 },
      ],
    },
  },
];
const STATE_LABEL = {
  working: "Working",
  setup: "Setup",
  waiting: "Needs input",
  interrupted: "Needs recovery",
  idle: "Idle",
  stopped: "Stopped",
};

interface SavedMark {
  choice: StudioChoice;
  surface: StudioSurface;
  monogramStyle: MonogramStyle;
}

function glyphLabel(name: GlyphName): string {
  return GLYPH_CATALOG.find((glyph) => glyph.name === name)?.label ?? name;
}

function PaletteSwatches({
  selected,
  onSelect,
}: {
  selected: number;
  onSelect(index: number): void;
}) {
  const inherited = useThemeStore((state) => state.preview ?? state.globalCanvas);
  const resolved = useThemeStore(effectiveAppearance);
  return (
    <div className="studio-palette" role="group" aria-label="Workspace canvas">
      {PALETTES.map((palette, index) => (
        <button
          key={palette.name}
          type="button"
          className="studio-swatch"
          aria-label={palette.name}
          title={palette.name}
          aria-pressed={selected === index}
          onClick={() => onSelect(index)}
          style={{ background: canvasBackground(palette.canvas ?? inherited, resolved) }}
        />
      ))}
    </div>
  );
}

function GlyphPicker({
  selected,
  onChoose,
}: {
  selected: GlyphName | null;
  onChoose(name: GlyphName, pointer: boolean): void;
}) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const glyphs = GLYPH_CATALOG.filter((glyph) =>
    `${glyph.label} ${glyph.name} ${glyph.keywords.join(" ")}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm">
          Browse marks <ArrowUpRightIcon className="size-3" />
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogTitle>Find your mark</DialogTitle>
        <Input
          aria-label="Find a glyph"
          placeholder="Tree, orbit, book…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <div className="studio-glyph-grid" role="group" aria-label="Phosphor glyph library">
          {glyphs.map((glyph) => {
            const Glyph = GLYPH_COMPONENTS[glyph.name];
            return (
              <button
                key={glyph.name}
                type="button"
                title={glyph.label}
                aria-label={`Choose ${glyph.label}`}
                aria-pressed={selected === glyph.name}
                onClick={(event) => {
                  onChoose(glyph.name, event.detail !== 0);
                  setOpen(false);
                }}
              >
                <Glyph />
              </button>
            );
          })}
        </div>
        {glyphs.length === 0 && <p className="text-ui text-muted-foreground">No matching marks</p>}
        <DialogDescription className="text-ui text-muted-foreground">
          24 Phosphor marks. A small library with a lot of personality.
        </DialogDescription>
      </DialogContent>
    </Dialog>
  );
}

function RailRehearsal({
  workspaces,
  marks,
  selectedId,
  onSelect,
  onRead,
}: {
  workspaces: readonly WorkspaceFixture[];
  marks: Record<string, SavedMark>;
  selectedId: string;
  onSelect(id: string): void;
  onRead(workspaceId: string, sessionId: string): void;
}) {
  const selected = workspaces.find((workspace) => workspace.id === selectedId) ?? workspaces[0]!;
  const sessions = visibleWorkspaceSessions(selected).toSorted(
    (a, b) => sessionAttentionRank(a.state) - sessionAttentionRank(b.state),
  );
  return (
    <div className="studio-rail-window">
      <nav className="studio-workspace-nav" aria-label="Identity studio workspaces">
        {workspaces.map((workspace) => {
          const summary = workspaceSummary(workspace);
          const saved = marks[workspace.id];
          return (
            <Tooltip key={workspace.id}>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  className="studio-rail-tile"
                  data-studio-workspace={workspace.id}
                  aria-current={selected.id === workspace.id ? "true" : undefined}
                  aria-label={`${workspace.name} · ${workspaceSummaryLabel(workspace)}`}
                  onClick={() => onSelect(workspace.id)}
                >
                  <IdentityMark
                    choice={saved?.choice ?? { kind: "initials" }}
                    name={workspace.name}
                    surface={saved?.surface}
                    monogramStyle={saved?.monogramStyle}
                    canvas={workspace.canvas}
                    appearance={workspace.appearance}
                    size="rail"
                  />
                  {summary.unread > 0 && (
                    <span className="studio-unread" data-studio-unread aria-hidden />
                  )}
                  {summary.signal !== null && (
                    <span className="studio-state" data-studio-signal={summary.signal} aria-hidden>
                      <StatusDot state={summary.signal} size="md" />
                    </span>
                  )}
                </button>
              </TooltipTrigger>
              <TooltipContent side="right">
                <div>{workspace.name}</div>
                <div>{workspaceSummaryLabel(workspace)}</div>
              </TooltipContent>
            </Tooltip>
          );
        })}
      </nav>
      <div className="studio-rail-page">
        <div className="studio-kicker">In the wild / 1:1 scale</div>
        <h3 className="studio-rail-heading">{selected.name}</h3>
        <p className="studio-caption">{workspaceSummaryLabel(selected)}</p>
        <div className="studio-session-list">
          {sessions.map((session) => (
            <button
              key={session.id}
              type="button"
              data-studio-session={session.id}
              className="studio-session-row"
              aria-label={`Open ${session.title} · ${STATE_LABEL[session.state]} · ${session.scope}${session.unread ? " · unread" : ""}`}
              onClick={() => onRead(selected.id, session.id)}
            >
              <span className="flex min-w-0 flex-col gap-1">
                <span className="truncate">{session.title}</span>
                <span className="flex items-center gap-2 text-label text-muted-foreground">
                  <StatusDot state={session.state} />
                  {STATE_LABEL[session.state]} · {session.scope}
                </span>
              </span>
              {session.unread && <span className="studio-unread" aria-hidden />}
            </button>
          ))}
          {sessions.length === 0 && (
            <p className="studio-note">A fresh little corner of the world. No sessions yet.</p>
          )}
        </div>
      </div>
    </div>
  );
}

export default function WorkspaceIdentityStudio() {
  const [name, setName] = React.useState("Moonshot");
  const [choice, setChoice] = React.useState<StudioChoice>({ kind: "glyph", name: "rocket" });
  const [candidates, setCandidates] = React.useState<GlyphName[]>(["rocket", "moon", "planet"]);
  const [surface, setSurface] = React.useState<StudioSurface>("etched");
  const [monogramStyle, setMonogramStyle] = React.useState<MonogramStyle>("editorial");
  const [palette, setPalette] = React.useState(1);
  const [motionEnabled, setMotionEnabled] = React.useState(true);
  const [pointerChange, setPointerChange] = React.useState(false);
  const [revision, setRevision] = React.useState(0);
  const [minted, setMinted] = React.useState(false);
  const [imageError, setImageError] = React.useState<string | null>(null);
  const [suggestionNotice, setSuggestionNotice] = React.useState("");
  const [selectedId, setSelectedId] = React.useState("canopy");
  const [workspaces, setWorkspaces] = React.useState(() => workspaceFixtures("mixed"));
  const [marks, setMarks] = React.useState<Record<string, SavedMark>>(() =>
    Object.fromEntries(
      Object.entries(INITIAL_GLYPHS).map(([id, glyph]) => [
        id,
        { choice: { kind: "glyph", name: glyph }, surface: "etched", monogramStyle: "editorial" },
      ]),
    ),
  );
  const remembered = React.useRef<Partial<Record<StudioChoice["kind"], StudioChoice>>>({});
  const fileRead = React.useRef(0);
  React.useEffect(
    () => () => {
      fileRead.current += 1;
    },
    [],
  );
  const canvas = PALETTES[palette]!.canvas;

  function change(next: StudioChoice, pointer: boolean) {
    fileRead.current += 1;
    remembered.current[next.kind] = next;
    setChoice(next);
    setPointerChange(pointer);
    setRevision((value) => value + 1);
    setMinted(false);
    setImageError(null);
  }
  function chooseMode(kind: StudioChoice["kind"], pointer: boolean) {
    remembered.current[choice.kind] = choice;
    change(
      remembered.current[kind] ??
        (kind === "glyph"
          ? { kind, name: candidates[0] ?? "sparkle" }
          : kind === "stamp"
            ? { kind, seed: DRAFT_ID, variant: 0 }
            : kind === "custom"
              ? { kind: "initials" }
              : { kind }),
      pointer,
    );
    // The upload tab may precede choosing a file; it should not claim an image exists.
    setMode(kind);
  }
  const [mode, setMode] = React.useState<StudioChoice["kind"]>("glyph");

  function chooseGlyph(glyph: GlyphName, pointer: boolean) {
    change({ kind: "glyph", name: glyph }, pointer);
    setMode("glyph");
  }
  function suggest() {
    const used = Object.values(marks).flatMap((mark) =>
      mark.choice.kind === "glyph" ? [mark.choice.name] : [],
    );
    const suggestions = suggestGlyphs(name, used);
    setCandidates(suggestions);
    setSuggestionNotice(
      "Three local suggestions. Your current mark stays yours until you choose another.",
    );
  }
  function mint(pointer: boolean) {
    const cleanName = name.trim();
    if (!cleanName) return;
    const workspace: WorkspaceFixture = {
      id: DRAFT_ID,
      name: cleanName,
      colorIndex: 0,
      canvas,
      appearance: null,
      sessions: [],
    };
    setWorkspaces((current) => [...current.filter((item) => item.id !== DRAFT_ID), workspace]);
    setMarks((current) => ({ ...current, [DRAFT_ID]: { choice, surface, monogramStyle } }));
    setSelectedId(DRAFT_ID);
    setMinted(true);
    setPointerChange(pointer);
    setRevision((value) => value + 1);
  }
  function importImage(file: File | undefined) {
    const request = ++fileRead.current;
    if (!file) return;
    if (
      !["image/png", "image/jpeg", "image/webp"].includes(file.type) ||
      file.size > 2 * 1024 * 1024
    ) {
      setImageError("Choose a PNG, JPEG, or WebP under 2 MB.");
      return;
    }
    const reader = new FileReader();
    reader.addEventListener(
      "error",
      () => {
        if (request === fileRead.current)
          setImageError("Could not read this image. Try another file.");
      },
      { once: true },
    );
    reader.addEventListener(
      "load",
      () => {
        if (request !== fileRead.current) return;
        if (
          typeof reader.result !== "string" ||
          !/^data:image\/(png|jpeg|webp);base64,/.test(reader.result)
        ) {
          setImageError("Could not read this image. Try another file.");
          return;
        }
        const dataUrl = reader.result;
        const image = new Image();
        image.addEventListener(
          "error",
          () => {
            if (request === fileRead.current)
              setImageError("This image could not be displayed. Try another file.");
          },
          { once: true },
        );
        image.addEventListener(
          "load",
          () => {
            if (request !== fileRead.current) return;
            // The native file dialog can be driven by keyboard; never infer a
            // pointer reveal from an asynchronous image-load event.
            change({ kind: "custom", dataUrl }, false);
            setMode("custom");
          },
          { once: true },
        );
        image.src = dataUrl;
      },
      { once: true },
    );
    reader.readAsDataURL(file);
  }

  return (
    <TooltipProvider>
      <main className="identity-studio" data-motion={motionEnabled}>
        <div className="studio-content">
          <header className="studio-masthead">
            <div>
              <div className="studio-kicker">
                <SparkleIcon className="size-4" />
                Volli / Workspace atelier
              </div>
              <h1 className="studio-title">
                A little place.
                <br />A little <em>character.</em>
              </h1>
              <p className="studio-subtitle">
                Make a mark that feels like your project. A carved glyph, a woven initial, a tiny
                constellation. Then see how it lives beside the work.
              </p>
            </div>
            <div className="studio-edition">
              Study No. 02
              <br />
              Small marks / big personalities
              <br />
              Made for the canvas
            </div>
          </header>
          <div className="studio-workbench">
            <section className="studio-panel studio-editor" aria-label="Workspace identity editor">
              <div className="studio-editor-heading">
                <h2>Meet your workspace</h2>
                <span className="studio-fixture-chip">
                  <SparkleIcon className="size-3" />
                  Jev study · local fixture
                </span>
              </div>
              <label className="studio-field">
                Project name
                <Input
                  className="studio-name-input"
                  aria-label="Project name"
                  value={name}
                  onChange={(event) => {
                    setName(event.target.value);
                    setMinted(false);
                  }}
                  maxLength={100}
                />
              </label>
              <div className="studio-options" role="group" aria-label="Identity kind">
                {Object.entries(MODES).map(([kind, label]) => (
                  <button
                    key={kind}
                    type="button"
                    aria-pressed={mode === kind}
                    onClick={(event) =>
                      chooseMode(kind as StudioChoice["kind"], event.detail !== 0)
                    }
                  >
                    {label}
                  </button>
                ))}
              </div>
              {mode === "glyph" && (
                <div className="flex flex-col gap-4">
                  <div className="studio-section-header">
                    <h3 className="studio-section-title">Three ways to say hello</h3>
                    <Button variant="ghost" size="sm" onClick={suggest}>
                      <SparkleIcon className="size-3" />
                      Suggest marks
                    </Button>
                  </div>
                  <div className="studio-candidates" role="group" aria-label="Suggested glyphs">
                    {candidates.map((glyph) => {
                      const Glyph = GLYPH_COMPONENTS[glyph];
                      const chosen = choice.kind === "glyph" && choice.name === glyph;
                      return (
                        <button
                          key={glyph}
                          type="button"
                          className="studio-candidate"
                          aria-label={`Choose suggested ${glyphLabel(glyph)}`}
                          aria-pressed={chosen}
                          onClick={(event) => chooseGlyph(glyph, event.detail !== 0)}
                        >
                          <Glyph className="studio-candidate-glyph" />
                          <span className="studio-candidate-label">
                            {glyphLabel(glyph)}
                            {chosen && <CheckIcon className="size-3" />}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                  <div className="studio-section-header">
                    <p className="studio-caption">Name-based, collision-aware. No model request.</p>
                    <GlyphPicker
                      selected={choice.kind === "glyph" ? choice.name : null}
                      onChoose={chooseGlyph}
                    />
                  </div>
                  <p className="sr-only" role="status">
                    {suggestionNotice}
                  </p>
                </div>
              )}
              {mode === "initials" && (
                <div className="flex flex-col gap-4">
                  <h3 className="studio-section-title">Not a fallback. A signature.</h3>
                  <div className="studio-candidates">
                    {Object.entries(MONOGRAMS).map(([style, label]) => (
                      <button
                        key={style}
                        type="button"
                        className="studio-candidate"
                        aria-label={`Choose ${label} initials`}
                        aria-pressed={monogramStyle === style}
                        onClick={(event) => {
                          setMonogramStyle(style as MonogramStyle);
                          setPointerChange(event.detail !== 0);
                          setRevision((value) => value + 1);
                          setMinted(false);
                        }}
                      >
                        <IdentityMark
                          choice={{ kind: "initials" }}
                          name={name}
                          canvas={canvas}
                          monogramStyle={style as MonogramStyle}
                          surface={surface}
                        />
                        <span>{label}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {mode === "stamp" && (
                <div className="flex flex-col gap-4">
                  <div className="studio-section-header">
                    <h3 className="studio-section-title">A tiny, one-of-a-kind stamp</h3>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={(event) =>
                        change(
                          {
                            kind: "stamp",
                            seed: DRAFT_ID,
                            variant: choice.kind === "stamp" ? choice.variant + 1 : 1,
                          },
                          event.detail !== 0,
                        )
                      }
                    >
                      <ShuffleIcon className="size-3" />
                      Another stamp
                    </Button>
                  </div>
                  <div className="studio-stamp-variants">
                    {[0, 1, choice.kind === "stamp" ? Math.max(2, choice.variant) : 2].map(
                      (variant) => (
                        <button
                          key={variant}
                          type="button"
                          aria-label={`Choose stamp ${variant + 1}`}
                          aria-pressed={choice.kind === "stamp" && choice.variant === variant}
                          onClick={(event) =>
                            change({ kind: "stamp", seed: DRAFT_ID, variant }, event.detail !== 0)
                          }
                        >
                          <IdentityMark
                            choice={{ kind: "stamp", seed: DRAFT_ID, variant }}
                            name={name}
                            canvas={canvas}
                            surface="letterpress"
                          />
                        </button>
                      ),
                    )}
                  </div>
                  <p className="studio-caption">
                    Seeded by workspace identity, not its name. Rename it; the stamp stays.
                  </p>
                </div>
              )}
              {mode === "custom" && (
                <div
                  className="studio-upload"
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={(event) => {
                    event.preventDefault();
                    importImage(event.dataTransfer.files[0]);
                  }}
                >
                  <ImageIcon className="size-6 text-muted-foreground" />
                  <label className="studio-field">
                    Bring your own mark
                    <input
                      type="file"
                      accept="image/png,image/jpeg,image/webp"
                      aria-label="Upload your mark"
                      onChange={(event) => {
                        const file = event.target.files?.[0];
                        event.target.value = ""; // Allow retrying the same file after a failure.
                        importImage(file);
                      }}
                    />
                  </label>
                  <p className="studio-caption">
                    Drop a PNG, JPEG, or WebP · under 2 MB · stays local
                  </p>
                </div>
              )}
              {imageError && (
                <p role="alert" className="text-ui text-destructive">
                  {imageError}
                </p>
              )}
              <div className="studio-editor-footer">
                <div className="flex flex-col gap-2">
                  <span className="studio-caption">A canvas to call home</span>
                  <PaletteSwatches
                    selected={palette}
                    onSelect={(index) => {
                      setPalette(index);
                      setMinted(false);
                    }}
                  />
                </div>
                <Button
                  size="lg"
                  disabled={!name.trim() || (mode === "custom" && choice.kind !== "custom")}
                  onClick={(event) => mint(event.detail !== 0)}
                >
                  <SealCheckIcon className="size-4" />
                  Make it mine
                </Button>
              </div>
            </section>
            <section className="studio-panel studio-preview" aria-label="Identity preview">
              <div className="studio-preview-header">
                <span className="studio-live-tag">Ink & light / the object</span>
                <button
                  type="button"
                  className="studio-fixture-chip"
                  aria-pressed={motionEnabled}
                  onClick={() => setMotionEnabled((value) => !value)}
                >
                  Motion {motionEnabled ? "on" : "off"}
                </button>
              </div>
              <HeroMark
                choice={choice}
                name={name}
                surface={surface}
                monogramStyle={monogramStyle}
                canvas={canvas}
                motionEnabled={motionEnabled}
                animateReveal={pointerChange}
                revision={revision}
                onImageError={() => {
                  delete remembered.current.custom;
                  change({ kind: "initials" }, false);
                  setImageError("This image could not be displayed. Try another file.");
                }}
              />
              <h2 className="studio-hero-name">{name.trim() || "Your next great thing"}</h2>
              <p className="studio-hero-caption">
                {SURFACES[surface]} /{" "}
                {mode === "glyph" && choice.kind === "glyph"
                  ? glyphLabel(choice.name)
                  : MODES[mode]}
              </p>
              <div className="studio-materials" role="group" aria-label="Mark materials">
                {Object.entries(SURFACES).map(([key, label]) => (
                  <button
                    type="button"
                    key={key}
                    className="studio-material-button"
                    aria-label={`Use ${label} material`}
                    aria-pressed={surface === key}
                    onClick={(event) => {
                      setSurface(key as StudioSurface);
                      setPointerChange(event.detail !== 0);
                      setRevision((value) => value + 1);
                      setMinted(false);
                    }}
                  >
                    <IdentityMark
                      choice={choice}
                      name={name}
                      surface={key as StudioSurface}
                      canvas={canvas}
                      monogramStyle={monogramStyle}
                    />
                    <span>{label}</span>
                  </button>
                ))}
              </div>
              <div className="studio-preview-foot">
                <span className="studio-caption">Pick it up with your pointer.</span>
                <span className="studio-mint-receipt" role="status">
                  {minted && (
                    <>
                      <CheckIcon className="size-4" />
                      It’s yours. Look in the rail.
                    </>
                  )}
                </span>
              </div>
            </section>
          </div>
          <section className="studio-rehearsal" aria-label="Workspace rail rehearsal">
            <RailRehearsal
              workspaces={workspaces}
              marks={marks}
              selectedId={selectedId}
              onSelect={setSelectedId}
              onRead={(workspaceId, sessionId) =>
                setWorkspaces((current) => readWorkspaceSession(current, workspaceId, sessionId))
              }
            />
            <aside className="studio-notes">
              <div>
                <h2 className="studio-note-title">Character, not chatter.</h2>
                <p className="studio-note">
                  The mark says who. The canvas says where. The corners tell you what arrived, and
                  what needs you.
                </p>
              </div>
              <div className="studio-legend">
                <span>
                  <span className="size-1.5 rounded-full bg-info" aria-hidden />
                  Unread · upper corner
                </span>
                <span>
                  <StatusDot state="waiting" size="md" />
                  Needs input · lower corner
                </span>
                <span>
                  <StatusDot state="interrupted" size="md" />
                  Needs recovery
                </span>
                <span>
                  <StatusDot state="working" size="md" />
                  Work is happening
                </span>
              </div>
              <p className="studio-note">
                Pick a workspace without reading it. Open a Session to clear only that conversation.
                The beautiful part doesn’t get to bend the honest part.
              </p>
              <Button
                variant="outline"
                size="sm"
                className="self-start"
                onClick={() =>
                  setWorkspaces((current) => [
                    ...workspaceFixtures("mixed"),
                    ...current.filter((workspace) => workspace.id === DRAFT_ID),
                  ])
                }
              >
                Reset unread fixtures
              </Button>
            </aside>
          </section>
          <footer className="studio-links">
            <span>Lab only · no project or settings writes · Jev suggestions are simulated</span>
            <a href="#workspace-icons" className="flex items-center gap-1">
              First study: identity & attention <ArrowUpRightIcon className="size-3" />
            </a>
          </footer>
        </div>
      </main>
    </TooltipProvider>
  );
}
