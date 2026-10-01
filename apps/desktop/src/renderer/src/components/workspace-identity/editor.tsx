/** Folder-picked workspace identity. No project exists until onCommit succeeds. */
import * as React from "react";
import { SparkleIcon } from "@phosphor-icons/react/dist/csr/Sparkle";
import { ArrowUpRightIcon } from "@phosphor-icons/react/dist/csr/ArrowUpRight";
import { CheckIcon } from "@phosphor-icons/react/dist/csr/Check";
import { SealCheckIcon } from "@phosphor-icons/react/dist/csr/SealCheck";
import { ShuffleIcon } from "@phosphor-icons/react/dist/csr/Shuffle";
import { ImageIcon } from "@phosphor-icons/react/dist/csr/Image";
import {
  DEFAULT_CANVAS,
  canvasBackground,
  GLYPH_CATALOG,
  suggestGlyphs,
  subsequenceScore,
  type Canvas,
  type GlyphName,
  type WorkspaceIdentity,
} from "@volli/shared";
import { Button } from "@renderer/components/ui/button";
import { Input } from "@renderer/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from "@renderer/components/ui/dialog";
import { useThemeStore, effectiveAppearance } from "@renderer/stores/theme";
import {
  GLYPH_COMPONENTS,
  HeroMark,
  IdentityMark,
  SURFACES,
  type StudioChoice,
  type StudioSurface,
  type MonogramStyle,
} from "./marks";
import "./studio.css";

export interface WorkspaceIdentityDraft {
  name: string;
  workspaceIdentity: WorkspaceIdentity;
  themeCanvas: Canvas | null;
}

const MODES = { glyph: "Icon", initials: "Initials", stamp: "Stamp", custom: "Your mark" } as const;
const MONOGRAMS: Record<MonogramStyle, string> = {
  editorial: "Editorial",
  architect: "Architect",
  woven: "Woven",
};
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

export function GlyphPicker({
  selected,
  onChoose,
}: {
  selected: GlyphName | null;
  onChoose(name: GlyphName, pointer: boolean): void;
}) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const needle = query.trim().toLowerCase();
  const glyphs = GLYPH_CATALOG.map((glyph) => ({
    glyph,
    score: Math.max(
      ...[glyph.name, glyph.label, ...glyph.keywords].map(
        (term) => subsequenceScore(needle, term.toLowerCase()) ?? -1,
      ),
    ),
  }))
    .filter(({ score }) => score >= 0)
    .toSorted((a, b) => b.score - a.score)
    .map(({ glyph }) => glyph);
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

export function WorkspaceIdentityEditor({
  defaultName,
  seed,
  folderPath,
  usedGlyphs,
  busy,
  onCommit,
  onCancel,
}: {
  defaultName: string;
  seed: string;
  folderPath: string;
  usedGlyphs: readonly GlyphName[];
  busy: boolean;
  onCommit(draft: WorkspaceIdentityDraft): Promise<unknown>;
  onCancel(): void;
}) {
  const [name, setName] = React.useState(defaultName);
  const [choice, setChoice] = React.useState<StudioChoice>(() => ({
    kind: "glyph",
    name: suggestGlyphs(defaultName, usedGlyphs)[0]!,
  }));
  const [candidates, setCandidates] = React.useState<GlyphName[]>(() =>
    suggestGlyphs(defaultName, usedGlyphs),
  );
  const [surface, setSurface] = React.useState<StudioSurface>("etched");
  const [monogramStyle, setMonogramStyle] = React.useState<MonogramStyle>("editorial");
  const [palette, setPalette] = React.useState(0);
  const [motionEnabled, setMotionEnabled] = React.useState(true);
  const [pointerChange, setPointerChange] = React.useState(false);
  const [revision, setRevision] = React.useState(0);
  const [readingImage, setReadingImage] = React.useState(false);
  const [imageError, setImageError] = React.useState<string | null>(null);
  const [suggestionNotice, setSuggestionNotice] = React.useState("");
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
    setReadingImage(false);
    setImageError(null);
  }
  function chooseMode(kind: StudioChoice["kind"], pointer: boolean) {
    remembered.current[choice.kind] = choice;
    change(
      remembered.current[kind] ??
        (kind === "glyph"
          ? { kind, name: candidates[0] ?? "sparkle" }
          : kind === "stamp"
            ? { kind, seed: seed, variant: 0 }
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
    const suggestions = suggestGlyphs(name, usedGlyphs);
    setCandidates(suggestions);
    setSuggestionNotice(
      "Three name-based suggestions. Your current mark stays yours until you choose another.",
    );
  }
  function importImage(file: File | undefined) {
    // Disabled fieldsets suppress controls, not drop events on their containers.
    if (busy) return;
    const request = ++fileRead.current;
    setReadingImage(false);
    if (!file) return;
    if (
      !["image/png", "image/jpeg", "image/webp"].includes(file.type) ||
      file.size > 2 * 1024 * 1024
    ) {
      setImageError("Choose a PNG, JPEG, or WebP under 2 MB.");
      return;
    }
    setImageError(null);
    setReadingImage(true);
    const reader = new FileReader();
    reader.addEventListener(
      "error",
      () => {
        if (request === fileRead.current) {
          setReadingImage(false);
          setImageError("Could not read this image. Try another file.");
        }
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
          setReadingImage(false);
          setImageError("Could not read this image. Try another file.");
          return;
        }
        const dataUrl = reader.result;
        const image = new Image();
        image.addEventListener(
          "error",
          () => {
            if (request === fileRead.current) {
              setReadingImage(false);
              setImageError("This image could not be displayed. Try another file.");
            }
          },
          { once: true },
        );
        image.addEventListener(
          "load",
          () => {
            if (request !== fileRead.current) return;
            // The native file dialog can be driven by keyboard; never infer a
            // pointer reveal from an asynchronous image-load event.
            try {
              // Store a small mark, not the source photo, on every project row.
              const thumbnail = document.createElement("canvas");
              const ratio = Math.min(1, 128 / Math.max(image.naturalWidth, image.naturalHeight));
              if (!Number.isFinite(ratio) || image.naturalWidth <= 0 || image.naturalHeight <= 0)
                throw new Error("Invalid image dimensions");
              thumbnail.width = Math.max(1, Math.round(image.naturalWidth * ratio));
              thumbnail.height = Math.max(1, Math.round(image.naturalHeight * ratio));
              const context = thumbnail.getContext("2d");
              if (!context) throw new Error("Image conversion unavailable");
              context.drawImage(image, 0, 0, thumbnail.width, thumbnail.height);
              const mark = thumbnail.toDataURL("image/webp", 0.9);
              if (!/^data:image\/(png|jpeg|webp);base64,/.test(mark) || mark.length > 128 * 1024)
                throw new Error("Image conversion failed");
              change({ kind: "custom", dataUrl: mark }, false);
              setMode("custom");
            } catch {
              setReadingImage(false);
              setImageError("Could not prepare this image. Try another file.");
            }
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
    <div className="identity-studio workspace-onboarding" data-motion={motionEnabled}>
      <div className="studio-content">
        <header className="studio-masthead">
          <div>
            <div className="studio-kicker">
              <SparkleIcon className="size-4" /> A place for your work
            </div>
            <h2 className="studio-title">
              Make it <em>yours.</em>
            </h2>
            <p className="studio-folder-path" title={folderPath}>
              {folderPath}
            </p>
          </div>
          <Button variant="ghost" disabled={busy} onClick={onCancel}>
            Cancel
          </Button>
        </header>
        <fieldset className="studio-workbench" disabled={busy}>
          <section className="studio-panel studio-editor" aria-label="Workspace identity editor">
            <div className="studio-editor-heading">
              <h2>Meet your workspace</h2>
              <span className="studio-fixture-chip">
                <SparkleIcon className="size-3" />
                Your workspace
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
                  onClick={(event) => chooseMode(kind as StudioChoice["kind"], event.detail !== 0)}
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
                  <p className="studio-caption">Suggested from the name · no AI request</p>
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
                          seed: seed,
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
                          change({ kind: "stamp", seed: seed, variant }, event.detail !== 0)
                        }
                      >
                        <IdentityMark
                          choice={{ kind: "stamp", seed: seed, variant }}
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
                  }}
                />
              </div>
              <Button
                size="lg"
                disabled={
                  busy ||
                  readingImage ||
                  !name.trim() ||
                  (mode === "custom" && choice.kind !== "custom")
                }
                onClick={() =>
                  void onCommit({
                    name: name.trim(),
                    workspaceIdentity: { choice, surface, monogramStyle },
                    themeCanvas: canvas,
                  })
                }
              >
                <SealCheckIcon className="size-4" />
                {busy ? "Creating workspace…" : readingImage ? "Reading image…" : "Make it mine"}
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
              motionEnabled={motionEnabled && !busy}
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
              {mode === "glyph" && choice.kind === "glyph" ? glyphLabel(choice.name) : MODES[mode]}
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
            </div>
          </section>
        </fieldset>
      </div>
    </div>
  );
}
