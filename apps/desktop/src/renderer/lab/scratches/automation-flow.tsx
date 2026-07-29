/**
 * The form builder as a graph — React Flow, authoring ON the canvas.
 *
 * ── WHAT THIS ASKS THAT THE MAP DID NOT ───────────────────────────────────
 * `automation-map` put the whole SET on a canvas and left authoring in a
 * drawer, which got the priority backwards: the set is something you glance
 * at, and the prompt is something you work on. This scratch inverts it. One
 * automation, its trigger and its steps as real nodes, and the full step card
 * — runtime dials, command ribbon, prompt editor, footer — living inside the
 * node rather than behind it.
 *
 * That is the only version of the question worth asking, because it is the one
 * every canvas product answers NO to. n8n, Make, Gumloop, Retool and Zapier all
 * put icon+label on the node face and configuration in a panel or modal. If
 * Volli can put the whole editor on the face, the graph is a real alternative
 * to the form. If it cannot, the graph is a diagram of a form, and we should
 * keep the form.
 *
 * ── THE ANSWER IS: ONE AT A TIME ──────────────────────────────────────────
 * Every step expanded at once is unreadable — two open cards are 1150px of
 * node and the shape they are in is gone, which is the thing the graph was
 * for. Every step collapsed to an icon and a name is the canvas products'
 * answer, and it is too little here: every step is an agent, so "an agent runs"
 * is not news.
 *
 * So the node has two sizes and exactly one is open. Collapsed carries the four
 * facts that actually differ between steps — which harness, which model, what
 * it costs and what it is allowed to touch, and the first line of what it is
 * told. Expanded is the whole editor. Opening one moves the camera to it;
 * closing hands the graph back. The sibling stays small beside it, so you never
 * lose the structure while you work inside a piece of it.
 *
 * That is a third answer, and it is better than either of the two the survey
 * found. It also explains the survey: n8n's node face is thin because an n8n
 * node is a Gmail call, and there is nothing to say about it but "Gmail".
 *
 * ── WHAT THE GRAPH GENUINELY MODELS BETTER ────────────────────────────────
 * One thing, and it is not decoration: the `join`. In the form, "run these two
 * together" versus "run this after that" is a pill on a vertical spine, which
 * is a word doing a diagram's job. Here it is topology — two edges leaving the
 * same handle mean parallel, one edge leaving a step means sequence — and you
 * add each by pressing the "+" on the side it will appear. Nothing is labelled
 * `together` or `then`, because the layout already says it.
 *
 * ── THE COSTS, WHICH ARE ALSO FINDINGS ────────────────────────────────────
 * 1. A node you can type in cannot be dragged by its body, so it needs a grab
 *    bar, and its interior needs `nodrag`/`nowheel` or the canvas eats your
 *    scroll and your text selection. Collapsing bought this back for most
 *    nodes — a collapsed one has nothing to select, so it drags by its body and
 *    the bar only appears on the one node that earns it.
 * 2. Position is now state that can disagree with the program. `Tidy` exists
 *    because of that, and n8n, Make, Gumloop and Zapier all ship the same
 *    button — which is the tell. Every canvas product has a button that means
 *    "undo my layout"; a form never needs one.
 * 3. The camera is now a thing that has to be right. Expanding without moving
 *    the viewport leaves half the card you just opened below the fold; moving
 *    it too eagerly loses your place. Both are bugs a form cannot have.
 * ──────────────────────────────────────────────────────────────────────────
 */
import * as React from "react";
import {
  Background,
  Controls,
  Handle,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import { ArrowsInSimpleIcon } from "@phosphor-icons/react/dist/csr/ArrowsInSimple";
import { DotsSixIcon } from "@phosphor-icons/react/dist/csr/DotsSix";
import { LightningIcon } from "@phosphor-icons/react/dist/csr/Lightning";
import { PlusIcon } from "@phosphor-icons/react/dist/csr/Plus";
import { TrashIcon } from "@phosphor-icons/react/dist/csr/Trash";

import { Button } from "@renderer/components/ui/button";
import { useReducedMotion } from "@renderer/hooks/use-reduced-motion";
import { cn } from "@renderer/lib/utils";

import { HarnessMark, harnessLabelFor } from "../automation/harness-identity";
import { StepCard } from "../automation/step-card";
import { TriggerCard } from "../automation/trigger-card";
import {
  blankStep,
  HARNESS_ADAPTERS,
  SEEDED_AUTOMATIONS,
  type AutomationStep,
  type Trigger,
} from "../automation/model";

import "@xyflow/react/dist/style.css";

export const title = "Automation · flow";
export const note = "React Flow: can the whole step editor live on the node face?";
export const viewport = "window" as const;

/* ----------------------------------------------------------------- layout */

const NODE = {
  triggerWidth: 420,
  triggerHeight: 150,
  stepWidth: 560,
  // Tall enough for the runtime block, a four-line prompt and the footer. A
  // node whose height is a constant means every step card is the same size
  // whatever is in it, which is the price of laying the graph out arithmetically
  // rather than measuring — and it is the price the form does not pay.
  stepHeight: 486,
  collapsedWidth: 300,
  collapsedHeight: 96,
  gapX: 40,
  gapY: 92,
} as const;

function widthOf(expanded: boolean): number {
  return expanded ? NODE.stepWidth : NODE.collapsedWidth;
}

function heightOf(expanded: boolean): number {
  return expanded ? NODE.stepHeight : NODE.collapsedHeight;
}

/**
 * Depth is the join, read as a graph: a `with` step is a sibling of the one
 * before it and shares its depth, an `after` step is a child and takes the next
 * one down.
 *
 * ── WHY THIS SCRATCH DOES NOT USE `join` ──────────────────────────────────
 * That reading works right up until you insert. `with` means "same parent as
 * the step before me", so dropping a step into the middle of the list silently
 * re-parents everything after it: on `Two-opinion review`, adding one step
 * under Codex turned Cursor into ITS sibling rather than Codex's, and the
 * diagram said so in a way the vertical form never would have.
 *
 * The flat list plus a join word can express a chain and it can express one
 * fan-out, but it cannot express a tree, and it fails silently rather than
 * loudly. So this scratch carries an explicit `parentId` instead — which is the
 * most useful thing the canvas has produced, because it is a finding about the
 * MODEL, not about the drawing. Steps stay a list for the form's benefit;
 * `join` becomes derived rather than authoritative.
 * ──────────────────────────────────────────────────────────────────────────
 */
const ROOT = "trigger";

interface FlowStep extends AutomationStep {
  /** {@link ROOT}, or the id of the step this one waits for. */
  parentId: string;
}

function childrenOf(steps: FlowStep[], id: string): FlowStep[] {
  return steps.filter((step) => step.parentId === id);
}

/**
 * A tree layout: each node centred over its own children, siblings packed by
 * subtree width rather than by count, so a branch that itself branches does not
 * sit on top of its neighbour.
 *
 * Sizes are per-node rather than constant, because exactly one step is expanded
 * at a time. A row's height is its tallest member, so expanding a node pushes
 * the rows below it down and leaves its siblings where they were — the graph
 * reflows around the thing you opened rather than rearranging itself.
 */
function layout(
  steps: FlowStep[],
  expandedId: string | null,
): Map<string, { x: number; y: number }> {
  const isOpen = (id: string) => id === expandedId;

  function subtreeWidth(id: string): number {
    const kids = childrenOf(steps, id);
    const own = widthOf(isOpen(id));
    if (kids.length === 0) return own;
    const packed =
      kids.reduce((total, kid) => total + subtreeWidth(kid.id), 0) + NODE.gapX * (kids.length - 1);
    return Math.max(own, packed);
  }

  // Row offsets first: a node's y depends on how tall every row above it is,
  // which is not knowable while walking down.
  const depthOf = new Map<string, number>();
  function measure(id: string, depth: number) {
    if (id !== ROOT) depthOf.set(id, depth);
    for (const kid of childrenOf(steps, id)) measure(kid.id, depth + 1);
  }
  measure(ROOT, -1);

  const rowHeight = new Map<number, number>();
  for (const step of steps) {
    const depth = depthOf.get(step.id) ?? 0;
    rowHeight.set(depth, Math.max(rowHeight.get(depth) ?? 0, heightOf(isOpen(step.id))));
  }
  const rowY = new Map<number, number>();
  let y = NODE.triggerHeight;
  for (let depth = 0; rowHeight.has(depth); depth += 1) {
    rowY.set(depth, y);
    y += (rowHeight.get(depth) ?? 0) + NODE.gapY;
  }

  const positions = new Map<string, { x: number; y: number }>();

  function place(id: string, centreX: number, depth: number) {
    if (id !== ROOT) {
      positions.set(id, {
        x: centreX - widthOf(isOpen(id)) / 2,
        y: rowY.get(depth) ?? NODE.triggerHeight,
      });
    }
    const kids = childrenOf(steps, id);
    const packed =
      kids.reduce((total, kid) => total + subtreeWidth(kid.id), 0) +
      NODE.gapX * Math.max(0, kids.length - 1);
    let cursor = centreX - packed / 2;
    for (const kid of kids) {
      const width = subtreeWidth(kid.id);
      place(kid.id, cursor + width / 2, depth + 1);
      cursor += width + NODE.gapX;
    }
  }

  place(ROOT, 0, -1);
  return positions;
}

/* ------------------------------------------------------------------ nodes */

interface TriggerData extends Record<string, unknown> {
  trigger: Trigger;
  onChange: (trigger: Trigger) => void;
  onAddAfter: () => void;
}

interface StepData extends Record<string, unknown> {
  step: FlowStep;
  removable: boolean;
  expanded: boolean;
  /** Collapsed, but the last one open — keeps your place after you close it. */
  wasExpanded: boolean;
  onToggle: () => void;
  onChange: (step: AutomationStep) => void;
  onRemove: () => void;
  /** `child` hangs below this step; `sibling` sits beside it under the same parent. */
  onAdd: (relation: "child" | "sibling") => void;
}

type FlowNode = Node<TriggerData, "trigger"> | Node<StepData, "step">;

/**
 * The grab bar every interactive node has to grow.
 *
 * React Flow drags a node by its body, and a body you can select text in is a
 * body you cannot drag. The alternative — dragging everywhere except the
 * inputs — makes an empty patch of card behave differently from the patch two
 * pixels left of it, which is worse than an explicit handle.
 */
function GrabBar({ label, children }: { label: string; children?: React.ReactNode }) {
  return (
    <div className="flow-drag flex cursor-grab items-center gap-1.5 rounded-t-lg border border-b-0 border-border bg-muted/40 px-2 py-1 active:cursor-grabbing">
      <DotsSixIcon weight="bold" aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="text-label text-muted-foreground uppercase">{label}</span>
      <span className="nodrag ml-auto flex items-center gap-0.5">{children}</span>
    </div>
  );
}

/**
 * A "+" on the edge of the node, on the side the new step will appear:
 * below for sequence, right for parallel. The direction IS the join, so
 * neither button needs the words `then` or `together` on it.
 *
 * Hidden until the node is hovered or something inside it has keyboard focus.
 * Always-on, a two-step automation showed FIVE identical "+" targets and they
 * outnumbered the steps — the affordance for adding was louder than the thing
 * it added to. n8n reveals its connector "+" the same way and for the same
 * reason. `group-focus-within` rather than `group-hover` alone, or the buttons
 * would be reachable by tab and invisible while you were on them.
 */
function AddHandle({
  side,
  onClick,
  label,
}: {
  side: "bottom" | "right";
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className={cn(
        "nodrag absolute z-10 grid size-6 place-items-center rounded-full border border-border bg-background text-muted-foreground",
        "opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 focus-visible:opacity-100",
        "transition-[opacity,color,border-color] duration-150 ease-out",
        "hover:border-primary/60 hover:text-primary-text motion-reduce:transition-none",
        "outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50",
        side === "bottom"
          ? "-bottom-3 left-1/2 -translate-x-1/2"
          : "top-1/2 -right-3 -translate-y-1/2",
      )}
    >
      <PlusIcon weight="bold" className="size-3.5" />
    </button>
  );
}

function TriggerNode({ data }: NodeProps<Node<TriggerData, "trigger">>) {
  return (
    <div className="group relative" style={{ width: NODE.triggerWidth }}>
      <GrabBar label="When" />
      {/* nowheel, or scrolling inside the card zooms the canvas instead. */}
      <div className="nodrag nowheel">
        <TriggerCard trigger={data.trigger} onChange={data.onChange} />
      </div>
      <AddHandle side="bottom" onClick={data.onAddAfter} label="Add a step" />
      <Handle type="source" position={Position.Bottom} className="!bg-border" />
    </div>
  );
}

/** The first thing the prompt actually says, for the collapsed face. */
function firstLine(text: string): string {
  return text.split("\n").find((line) => line.trim().length > 0) ?? "";
}

/**
 * The collapsed face: who runs it, on what, and what it opens with.
 *
 * Which is a deliberately short list. The canvas products put an icon and a
 * name here and nothing else, and that is too little for Volli — every step is
 * an agent, so "an agent runs" is not news; WHICH agent, on which model, at
 * what cost, and what it is told are the four things that differ. The runtime
 * line is mono because it is machine vocabulary and reads faster as a command
 * fragment than as a sentence.
 */
function CollapsedStep({ step }: { step: FlowStep }) {
  const { runtime } = step;
  const adapter = HARNESS_ADAPTERS[runtime.harnessId];
  const dials = [
    adapter.effort === null ? null : runtime.effort,
    adapter.approvals === null ? null : runtime.approvals,
  ].filter((value): value is string => value !== null && value !== "");

  return (
    <div
      className="flex flex-col justify-center gap-0.5 px-2.5"
      style={{ height: NODE.collapsedHeight }}
    >
      <span className="flex items-baseline gap-1.5 overflow-hidden">
        <HarnessMark harnessId={runtime.harnessId} className="translate-y-0.5" />
        <span className="shrink-0 text-ui text-foreground">
          {harnessLabelFor(runtime.harnessId)}
        </span>
        <span className="truncate font-mono text-label text-muted-foreground">{runtime.model}</span>
      </span>
      {/* Its own line rather than trailing the model, because the model name is
          long and variable and would push the safety-relevant half of the
          runtime off the end of exactly the steps that need watching. */}
      <span className="truncate font-mono text-label text-muted-foreground">
        {dials.join(" · ")}
      </span>
      <span className="truncate text-label text-muted-foreground">
        {firstLine(step.instructions) || "No instructions"}
      </span>
    </div>
  );
}

function StepNode({ data }: NodeProps<Node<StepData, "step">>) {
  const { expanded, step } = data;

  return (
    <div className="group relative" style={{ width: widthOf(expanded) }}>
      <Handle type="target" position={Position.Top} className="!bg-border" />

      {/* A collapsed node has nothing to select or scroll inside it, so it can
          be dragged by its body and does not need a grab bar. The bar is the
          cost of being editable, and it is only paid where editing happens. */}
      {expanded ? (
        <GrabBar label="Run">
          <Button variant="ghost" size="icon-xs" aria-label="Collapse step" onClick={data.onToggle}>
            <ArrowsInSimpleIcon />
          </Button>
          {data.removable ? (
            <Button variant="ghost" size="icon-xs" aria-label="Remove step" onClick={data.onRemove}>
              <TrashIcon />
            </Button>
          ) : null}
        </GrabBar>
      ) : null}

      {expanded ? (
        <div className="nodrag nowheel overflow-y-auto" style={{ height: NODE.stepHeight - 26 }}>
          <StepCard step={step} onChange={data.onChange} onDuplicate={null} onRemove={null} />
        </div>
      ) : (
        <button
          type="button"
          onClick={data.onToggle}
          // The one you were last inside. Collapsing used to drop you into a
          // graph of identical cards with no memory of which one you had just
          // been editing, which is the cost of a single-focus surface if it
          // does not keep a mark.
          aria-current={data.wasExpanded ? "true" : undefined}
          className={cn(
            "w-full cursor-pointer overflow-hidden rounded-lg border bg-card text-left",
            "transition-colors duration-150 ease-out hover:border-muted-foreground/40",
            "motion-reduce:transition-none",
            "outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50",
            data.wasExpanded ? "border-primary/50" : "border-border",
          )}
        >
          <CollapsedStep step={step} />
        </button>
      )}

      <AddHandle side="bottom" onClick={() => data.onAdd("child")} label="Add a step after this" />
      <AddHandle side="right" onClick={() => data.onAdd("sibling")} label="Add a step alongside" />
      <Handle type="source" position={Position.Bottom} className="!bg-border" />
    </div>
  );
}

const NODE_TYPES = { trigger: TriggerNode, step: StepNode };

/* ------------------------------------------------------------------ graph */

/**
 * One edge per parent link. No inference, so the drawing cannot disagree.
 *
 * Drawn at `muted-foreground`, not `border`. The edges were on the border token
 * and were the faintest thing on a canvas whose entire argument is that
 * structure is visible — the least important surface, the card outline, was
 * carrying more visual weight than the only mark that says what runs after
 * what. The path from the trigger down to the open step is lifted further, so
 * the branch you are inside reads as a branch rather than as one of two.
 */
function edgesFor(steps: FlowStep[], expandedId: string | null): Edge[] {
  const byId = new Map(steps.map((step) => [step.id, step]));
  const onPath = new Set<string>();
  let walk = expandedId === null ? undefined : byId.get(expandedId);
  while (walk !== undefined && !onPath.has(walk.id)) {
    onPath.add(walk.id);
    walk = byId.get(walk.parentId);
  }

  return steps.map((step) => {
    const lit = onPath.has(step.id);
    return {
      id: `${step.parentId}->${step.id}`,
      source: step.parentId,
      target: step.id,
      animated: false,
      style: {
        stroke: lit ? "var(--color-primary)" : "var(--color-muted-foreground)",
        strokeWidth: lit ? 2 : 1.5,
        opacity: lit ? 0.9 : 0.55,
      },
    };
  });
}

/** `Two-opinion review`, re-read as a tree: both reviewers hang off the trigger. */
const SEED: FlowStep[] = SEEDED_AUTOMATIONS[2].steps.map((step) => ({ ...step, parentId: ROOT }));

function Canvas() {
  const [trigger, setTrigger] = React.useState<Trigger>(SEEDED_AUTOMATIONS[2].trigger);
  const [name, setName] = React.useState(SEEDED_AUTOMATIONS[2].name);
  const [steps, setSteps] = React.useState<FlowStep[]>(SEED);
  // One at a time. Two open cards is two 560px columns and the shape is gone
  // again, which is the thing collapsing was for; and "click into it" only
  // means something if there is a single thing you are inside of.
  const [expandedId, setExpandedId] = React.useState<string | null>(null);
  const [nodes, setNodes, onNodesChange] = useNodesState<FlowNode>([]);
  const [edges, setEdges] = useEdgesState<Edge>([]);
  const { fitView } = useReactFlow();

  const stepsRef = React.useRef(steps);
  stepsRef.current = steps;

  // Sticky rather than derived: it has to survive `expandedId` going null,
  // which is exactly the moment it is needed.
  const lastOpenedRef = React.useRef<string | null>(null);
  if (expandedId !== null) lastOpenedRef.current = expandedId;

  const reducedMotion = useReducedMotion();

  const updateStep = React.useCallback((next: AutomationStep) => {
    setSteps((current) =>
      current.map((step) => (step.id === next.id ? { ...next, parentId: step.parentId } : step)),
    );
  }, []);

  const removeStep = React.useCallback((id: string) => {
    // Orphans are adopted by their grandparent rather than dropped — removing a
    // step should remove one step, not the subtree hanging off it.
    setSteps((current) => {
      const gone = current.find((step) => step.id === id);
      if (gone === undefined) return current;
      const kept: FlowStep[] = [];
      for (const step of current) {
        if (step.id === id) continue;
        kept.push(step.parentId === id ? { ...step, parentId: gone.parentId } : step);
      }
      return kept;
    });
  }, []);

  const addStep = React.useCallback((parentId: string) => {
    setSteps((current) => {
      const seed = current.find((step) => step.id === parentId) ?? current.at(-1);
      const next = blankStep(seed?.runtime.harnessId ?? "claude-code");
      // A new step is empty, so it opens: collapsed it would say nothing but
      // its inherited harness, and you would have to click it to do the thing
      // you were already doing.
      setExpandedId(next.id);
      return [...current, { ...next, parentId }];
    });
  }, []);

  /**
   * Structure in, nodes out. Keyed on the parent links rather than on the whole
   * automation, so typing a prompt does not relayout the canvas under the
   * cursor — the graph only moves when the graph changes.
   */
  const signature = `${expandedId}#${steps.map((step) => `${step.id}<${step.parentId}`).join("|")}`;

  React.useEffect(() => {
    const current = stepsRef.current;
    const positions = layout(current, expandedId);
    const built: FlowNode[] = [
      {
        id: ROOT,
        type: "trigger",
        position: { x: -NODE.triggerWidth / 2, y: 0 },
        dragHandle: ".flow-drag",
        data: {
          trigger,
          onChange: setTrigger,
          onAddAfter: () => addStep(ROOT),
        },
      },
      ...current.map<FlowNode>((step) => ({
        id: step.id,
        type: "step" as const,
        position: positions.get(step.id) ?? { x: 0, y: NODE.triggerHeight },
        // Only an expanded node has a grab bar; a collapsed one drags by its
        // body, so it must not name a handle that is not rendered.
        dragHandle: step.id === expandedId ? ".flow-drag" : undefined,
        data: {
          step,
          removable: current.length > 1,
          expanded: step.id === expandedId,
          wasExpanded: step.id === lastOpenedRef.current && step.id !== expandedId,
          onToggle: () => setExpandedId((open) => (open === step.id ? null : step.id)),
          onChange: updateStep,
          onRemove: () => removeStep(step.id),
          onAdd: (relation: "child" | "sibling") =>
            addStep(relation === "child" ? step.id : step.parentId),
        },
      })),
    ];
    setNodes(built);
    setEdges(edgesFor(current, expandedId));
  }, [signature, expandedId, addStep, removeStep, updateStep, setNodes, setEdges, trigger]);

  /**
   * The camera follows what you opened.
   *
   * Without this, expanding a node lays out a 486px card and leaves the
   * viewport where it was, so half of the thing you just clicked into is below
   * the fold and your first act is to scroll. "Click into it" has to mean the
   * canvas moves; collapsing hands the whole graph back.
   *
   * Deferred a frame because the node it is aiming at is measured by the effect
   * above, which has not run when this one is queued on the same change.
   *
   * The duration goes to zero under `prefers-reduced-motion` rather than the
   * move being skipped. A CSS transition can be dropped because the end state
   * is correct either way; a viewport pan IS the correction, so cancelling it
   * would leave the card you opened off-screen. The camera still arrives — it
   * just arrives without the sweep, which is the part that makes people ill.
   */
  React.useEffect(() => {
    const duration = reducedMotion ? 0 : 260;
    const at = window.setTimeout(() => {
      void fitView(
        expandedId === null
          ? { duration, padding: 0.2, maxZoom: 1 }
          : { duration, padding: 0.12, maxZoom: 1, nodes: [{ id: expandedId }] },
      );
    }, 16);
    return () => window.clearTimeout(at);
  }, [expandedId, fitView, reducedMotion]);

  // Prompt edits must reach the node without rebuilding the graph, or every
  // keystroke would reset positions and blur the editor.
  React.useEffect(() => {
    setNodes((current) =>
      current.map((node) => {
        if (node.type !== "step") return node;
        const step = steps.find((item) => item.id === node.id);
        return step === undefined ? node : { ...node, data: { ...node.data, step } };
      }),
    );
  }, [steps, setNodes]);

  function tidy() {
    const positions = layout(stepsRef.current, expandedId);
    setNodes((current) =>
      current.map((node) =>
        node.id === ROOT
          ? { ...node, position: { x: -NODE.triggerWidth / 2, y: 0 } }
          : { ...node, position: positions.get(node.id) ?? node.position },
      ),
    );
    // maxZoom 1, or a two-node graph fits by scaling ITSELF up to fill the
    // window and the whole point of collapsing — that a step is a small thing —
    // is undone by the camera.
    window.setTimeout(
      () => void fitView({ duration: reducedMotion ? 0 : 240, padding: 0.2, maxZoom: 1 }),
      0,
    );
  }

  return (
    <div className="flex h-svh flex-col bg-background text-foreground">
      <header className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-2.5">
        <LightningIcon weight="fill" aria-hidden className="size-3.5 text-muted-foreground" />
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          className="w-72 bg-transparent text-ui text-foreground outline-none"
          placeholder="Name"
        />
        <Button variant="ghost" size="xs" className="ml-auto border border-border" onClick={tidy}>
          Tidy
        </Button>
      </header>

      <div className="min-h-0 flex-1">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          nodeTypes={NODE_TYPES}
          colorMode="dark"
          fitView
          fitViewOptions={{ padding: 0.2, maxZoom: 1 }}
          minZoom={0.25}
          proOptions={{ hideAttribution: false }}
          nodesConnectable={false}
          // React Flow makes the node wrapper a tab stop by default, which here
          // is a stop with no visible ring and nothing to do — dragging is not
          // keyboard-driven. The card inside it is the real control and is
          // focusable on its own, so this removes a dead stop rather than
          // taking anything away.
          nodesFocusable={false}
          // Edges are derived from the joins, so letting someone delete one
          // would leave a step orphaned from a structure that still says it has
          // a parent. The "+" buttons are the only way to change the shape.
          edgesFocusable={false}
        >
          <Background gap={20} size={1} color="var(--color-border)" />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>
    </div>
  );
}

export default function AutomationFlowScratch() {
  return (
    <ReactFlowProvider>
      <Canvas />
    </ReactFlowProvider>
  );
}
