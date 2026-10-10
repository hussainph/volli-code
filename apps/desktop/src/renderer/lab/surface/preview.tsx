import * as React from "react";
import { ArrowUp, Check, File, GitBranch, Plus, X } from "@phosphor-icons/react";

import { Button } from "@renderer/components/ui/button";
import { Input } from "@renderer/components/ui/input";
import { ListRow } from "@renderer/components/ui/list-row";
import { Popover, PopoverContent, PopoverTrigger } from "@renderer/components/ui/popover";
import { Segmented } from "@renderer/components/ui/segmented";
import { Textarea } from "@renderer/components/ui/textarea";
import type { SurfaceStyle, SurfaceValues } from "./model";
import { SurfaceComponentGallery, COMPONENT_COVERAGE } from "./component-gallery";
import {
  LightHandles,
  SpatialLayers,
  useSpatialLighting,
  type LightPlacement,
} from "./spatial-lighting";

const PLACES = [
  { key: "body", label: "Body" },
  { key: "chat", label: "Chat" },
  { key: "files", label: "Files" },
  { key: "diffs", label: "Diffs" },
] as const;

/** Real primitives, fixture-only interactions. Material changes never key/remount this tree. */
export function SurfacePreview({
  style,
  values,
  onLightPlacement,
}: {
  style: SurfaceStyle;
  values: SurfaceValues;
  onLightPlacement: (placement: LightPlacement) => void;
}) {
  const reference = values.reference.treatment === "macos27";
  const stage = React.useRef<HTMLDivElement>(null);
  const [lens, setLens] = React.useState<HTMLDivElement | null>(null);
  const [railLeft, setRailLeft] = React.useState(false);
  const surfaceRegistry = React.useRef(new Map<string, HTMLElement>());
  const pendingRegistration = React.useRef(false);
  const active = React.useRef(true);
  const [extraSurfaces, setExtraSurfaces] = React.useState<readonly HTMLElement[]>([]);
  React.useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const registerSurface = React.useCallback((id: string, node: HTMLElement | null) => {
    if (node) surfaceRegistry.current.set(id, node);
    else surfaceRegistry.current.delete(id);
    // Composed refs may emit null/node in the same commit. Compare the final
    // membership, not ref-callback churn, before rebuilding measured geometry.
    if (pendingRegistration.current) return;
    pendingRegistration.current = true;
    queueMicrotask(() => {
      pendingRegistration.current = false;
      if (!active.current) return;
      const next = [...surfaceRegistry.current.values()];
      setExtraSurfaces((previous) =>
        previous.length === next.length && next.every((entry) => previous.includes(entry))
          ? previous
          : next,
      );
    });
  }, []);
  const registerGallery = React.useCallback(
    (node: HTMLElement | null) => registerSurface("work-gallery", node),
    [registerSurface],
  );
  useSpatialLighting(
    stage,
    lens,
    {
      angle: values.lighting.angle,
      elevation: values.lens.lift,
      crown: values.controls.crown,
      rim: values.lighting.rim,
      shadow: values.lens.shadow,
      tint: values.lens.tint,
      workElevation: values.workPane.lift,
      workRim: values.workPane.rim,
      workShadow: values.workPane.shadow,
      workTint: values.workPane.tint,
    },
    `${railLeft}:${reference}`,
    values.placement,
    onLightPlacement,
    extraSurfaces,
  );
  const [place, setPlace] = React.useState<(typeof PLACES)[number]["key"]>("chat");
  const [draft, setDraft] = React.useState("");
  const [notes, setNotes] = React.useState<{ id: string; text: string }[]>([]);
  const [selectedFile, setSelectedFile] = React.useState("globals.css");
  const [open, setOpen] = React.useState(true);
  const [query, setQuery] = React.useState("");
  const [model, setModel] = React.useState("Claude Opus");
  const models = ["Claude Opus", "GPT-5"].filter((name) =>
    name.toLowerCase().includes(query.toLowerCase()),
  );

  return (
    <>
      <nav
        className="surface-preview-nav flex flex-wrap items-center gap-2 p-2"
        aria-label="Preview sections"
        data-surface-controls
      >
        <Button
          variant="ghost"
          size="sm"
          aria-controls="surface-workspace"
          onClick={() =>
            document.getElementById("surface-workspace")?.scrollIntoView({ block: "start" })
          }
        >
          Workspace
        </Button>
        <Button
          variant="ghost"
          size="sm"
          aria-controls="surface-components"
          onClick={() =>
            document.getElementById("surface-components")?.scrollIntoView({ block: "start" })
          }
        >
          Components ({COMPONENT_COVERAGE.length})
        </Button>
      </nav>
      <div
        id="surface-workspace"
        className="surface-environment"
        ref={stage}
        data-testid="surface-environment"
      >
        {values.canvas.backdropDetail ? (
          <div className="surface-backdrop-detail" aria-hidden />
        ) : null}
        {reference && (
          <div className="surface-reference-titlebar flex items-center justify-between gap-2 px-4 py-3 text-ui">
            <span className="flex gap-2" aria-hidden>
              <i />
              <i />
              <i />
            </span>
            <span className="font-medium">Surface · VC-617</span>
            <span className="text-label text-muted-foreground">
              {values.reference.active ? "Active" : "Inactive"}
            </span>
          </div>
        )}
        <LightHandles />
        <div
          className={`${reference ? "surface-lens surface-dimensional surface-reference surface-reference-toolbar" : "surface-satin rounded-full"} flex items-center justify-between gap-2 p-2`}
          data-material={reference ? "glass" : undefined}
          data-testid="surface-toolbar"
          data-spatial-body={reference ? values.lens.lift : 6}
        >
          <SpatialLayers materialFace={reference} />
          <Segmented<(typeof PLACES)[number]["key"]>
            ariaLabel="Preview workspace tab"
            value={place}
            options={PLACES}
            onChange={setPlace}
            size="default"
          />
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Add local note"
            onClick={() => document.getElementById("surface-draft")?.focus()}
          >
            <Plus />
          </Button>
        </div>
        <div className="surface-composition" data-rail-side={railLeft ? "left" : "right"}>
          <section
            className="surface-work surface-dimensional flex min-w-0 flex-col gap-4 p-6"
            aria-label="Work pane"
            data-testid="surface-matte"
            data-material={values.workPane.material}
            data-spatial-material="work"
            data-spatial-body={values.workPane.lift}
          >
            <SpatialLayers materialFace />
            <div className="flex flex-col gap-2">
              <span className="text-label text-muted-foreground">VC-617 / SURFACE</span>
              <h2 className="text-title font-medium">A quieter workspace</h2>
            </div>
            <p className="text-sm leading-prose">
              Keep the work readable. Let the controls have presence without making every row an
              object.
            </p>
            <div className="flex flex-col gap-1">
              <h3 className="text-label uppercase text-muted-foreground">
                {place === "diffs" ? "Changes" : "Files"}
              </h3>
              {["globals.css", "surface.tsx"].map((path) => (
                <ListRow
                  key={path}
                  leading={<File className="size-4 text-muted-foreground" />}
                  primary={path}
                  onActivate={() => setSelectedFile(path)}
                  selected={path === selectedFile}
                  trailing={
                    place === "diffs" ? (
                      <span className="text-ui text-muted-foreground">+12 −4</span>
                    ) : undefined
                  }
                />
              ))}
            </div>
            {place === "body" ? (
              <p className="text-sm text-muted-foreground">
                Selective depth. Matte / satin / lens.
              </p>
            ) : null}
            {notes.map((note) => (
              <p key={note.id} className="border-t border-border pt-2 text-sm leading-prose">
                {note.text}
              </p>
            ))}
            <form
              className="flex flex-col gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                if (!draft.trim()) return;
                setNotes((previous) => [
                  ...previous,
                  { id: crypto.randomUUID(), text: draft.trim() },
                ]);
                setDraft("");
              }}
            >
              <Textarea
                id="surface-draft"
                aria-label="Local preview note"
                placeholder="Explore this direction…"
                data-surface-writing
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                className="min-h-20 resize-none"
              />
              <div className="flex items-center justify-between gap-2">
                <span className="text-ui text-muted-foreground">{model} · High</span>
                <Button
                  type="submit"
                  size="icon"
                  aria-label="Post local preview note"
                  data-surface-primary
                  data-spatial-body="4"
                  className="surface-spatial-control"
                  disabled={!draft.trim()}
                >
                  <SpatialLayers />
                  <ArrowUp />
                </Button>
              </div>
            </form>
            <div className="flex items-center gap-2 border-t border-border pt-4 text-ui text-muted-foreground">
              <GitBranch className="size-4" />
              volli / VC-617-surface
            </div>
          </section>
          <aside className="flex min-w-0 flex-col gap-2" aria-label="Integrated rail">
            <h3 className="px-2 text-label uppercase text-muted-foreground">Now</h3>
            <Button
              variant="ghost"
              size="sm"
              data-surface-controls
              onClick={() => setRailLeft((previous) => !previous)}
            >
              {railLeft ? "Move rail right" : "Move rail left"}
            </Button>
            <ListRow
              primary="Surface exploration"
              secondary="Fixture session · working"
              density="two-line"
              onActivate={null}
            />
            <Popover open={open} onOpenChange={setOpen}>
              <PopoverTrigger asChild>
                <Button variant="outline" className="self-start">
                  Inspect material
                </Button>
              </PopoverTrigger>
              <PopoverContent
                aria-label="Surface model inspector"
                className={`surface-lens surface-dimensional w-72 p-4 text-ui animate-none!${reference ? " surface-reference" : ""}`}
                data-material={values.lens.material}
                ref={setLens}
                data-spatial-body={values.lens.lift}
                style={style}
                align={railLeft ? "start" : "end"}
                collisionPadding={24}
                hideWhenDetached
                sideOffset={16}
                onOpenAutoFocus={(event) => event.preventDefault()}
                onInteractOutside={(event) => {
                  // Adjusting the dials must not light-dismiss the object being tuned.
                  const target = event.target;
                  if (
                    target instanceof Element &&
                    target.closest(".dialkit-root, [data-surface-controls]")
                  )
                    event.preventDefault();
                }}
              >
                <SpatialLayers materialFace />
                <div className="flex flex-col gap-4">
                  <div className="flex items-center justify-between gap-2">
                    <h3 className="text-ui font-medium">Model &amp; effort</h3>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      aria-label="Close material inspector"
                      onClick={() => setOpen(false)}
                    >
                      <X />
                    </Button>
                  </div>
                  <Input
                    aria-label="Find preview model"
                    placeholder="Find a model…"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                  />
                  <div className="flex flex-col gap-1">
                    {models.map((name) => (
                      <Button
                        key={name}
                        variant="ghost"
                        aria-pressed={model === name}
                        className={
                          model === name ? "surface-model-choice justify-start" : "justify-start"
                        }
                        onClick={() => setModel(name)}
                      >
                        {model === name ? <Check className="size-4" /> : null}
                        {name}
                      </Button>
                    ))}
                    {models.length === 0 ? (
                      <p className="text-ui text-muted-foreground">No matches</p>
                    ) : null}
                  </div>
                  <div className="flex items-center justify-between text-ui">
                    <span className="text-muted-foreground">Effort</span>
                    <span>High</span>
                  </div>
                </div>
              </PopoverContent>
            </Popover>
          </aside>
        </div>
      </div>
      <section
        id="surface-components"
        ref={registerGallery}
        className="surface-work surface-dimensional p-6"
        data-spatial-material="work"
        data-spatial-body={values.workPane.lift}
        data-material={values.workPane.material}
      >
        <SpatialLayers materialFace />
        <SurfaceComponentGallery
          style={style}
          material={values.lens.material}
          reference={reference}
          onSurface={registerSurface}
        />
      </section>
    </>
  );
}
