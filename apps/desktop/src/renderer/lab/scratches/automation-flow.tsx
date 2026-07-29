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
 * ── WHAT THE GRAPH GENUINELY MODELS BETTER ────────────────────────────────
 * One thing, and it is not decoration: the `join`. In the form, "run these two
 * together" versus "run this after that" is a pill on a vertical spine, which
 * is a word doing a diagram's job. Here it is topology — two edges leaving the
 * same handle mean parallel, one edge leaving a step means sequence — and you
 * add each by pressing the "+" on the side it will appear. Nothing is labelled
 * `together` or `then`, because the layout already says it.
 *
 * ── THE COSTS, WHICH ARE ALSO FINDINGS ────────────────────────────────────
 * 1. A node you can type in cannot be dragged by its body, so every node needs
 *    a grab bar it would not otherwise have, and the whole interior needs
 *    `nodrag`/`nowheel` or the canvas eats your scroll and your text selection.
 *    The affordance budget goes up before the capability does.
 * 2. Two parallel steps are ~1150px of node. On a 1560px window with a sidebar
 *    that is already panning, and Volli's real chrome is not this generous.
 * 3. Position is now state that can disagree with the program. `Tidy` exists
 *    because of that, and n8n, Make, Gumloop and Zapier all ship the same
 *    button — which is the tell. Every canvas product has a button that means
 *    "undo my layout"; a form never needs one.
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
import { DotsSixIcon } from "@phosphor-icons/react/dist/csr/DotsSix";
import { LightningIcon } from "@phosphor-icons/react/dist/csr/Lightning";
import { PlusIcon } from "@phosphor-icons/react/dist/csr/Plus";
import { TrashIcon } from "@phosphor-icons/react/dist/csr/Trash";

import { Button } from "@renderer/components/ui/button";
import { cn } from "@renderer/lib/utils";

import { StepCard } from "../automation/step-card";
import { TriggerCard } from "../automation/trigger-card";
import {
  blankStep,
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
  gapX: 40,
  gapY: 92,
} as const;

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
 */
function layout(steps: FlowStep[]): Map<string, { x: number; y: number }> {
  function subtreeWidth(id: string): number {
    const kids = childrenOf(steps, id);
    if (kids.length === 0) return NODE.stepWidth;
    const packed =
      kids.reduce((total, kid) => total + subtreeWidth(kid.id), 0) + NODE.gapX * (kids.length - 1);
    return Math.max(NODE.stepWidth, packed);
  }

  const positions = new Map<string, { x: number; y: number }>();

  function place(id: string, centreX: number, depth: number) {
    if (id !== ROOT) {
      positions.set(id, {
        x: centreX - NODE.stepWidth / 2,
        y: NODE.triggerHeight + depth * (NODE.stepHeight + NODE.gapY),
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
        "transition-colors duration-150 ease-out hover:border-primary/60 hover:text-primary-text",
        "motion-reduce:transition-none",
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
    <div className="relative" style={{ width: NODE.triggerWidth }}>
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

function StepNode({ data }: NodeProps<Node<StepData, "step">>) {
  return (
    <div className="relative" style={{ width: NODE.stepWidth }}>
      <Handle type="target" position={Position.Top} className="!bg-border" />
      <GrabBar label="Run">
        {data.removable ? (
          <Button variant="ghost" size="icon-xs" aria-label="Remove step" onClick={data.onRemove}>
            <TrashIcon />
          </Button>
        ) : null}
      </GrabBar>
      <div className="nodrag nowheel overflow-y-auto" style={{ height: NODE.stepHeight - 26 }}>
        <StepCard step={data.step} onChange={data.onChange} onDuplicate={null} onRemove={null} />
      </div>
      <AddHandle side="bottom" onClick={() => data.onAdd("child")} label="Add a step after this" />
      <AddHandle side="right" onClick={() => data.onAdd("sibling")} label="Add a step alongside" />
      <Handle type="source" position={Position.Bottom} className="!bg-border" />
    </div>
  );
}

const NODE_TYPES = { trigger: TriggerNode, step: StepNode };

/* ------------------------------------------------------------------ graph */

/** One edge per parent link. No inference, so the drawing cannot disagree. */
function edgesFor(steps: FlowStep[]): Edge[] {
  return steps.map((step) => ({
    id: `${step.parentId}->${step.id}`,
    source: step.parentId,
    target: step.id,
    animated: false,
    style: { stroke: "var(--color-border)", strokeWidth: 1.5 },
  }));
}

/** `Two-opinion review`, re-read as a tree: both reviewers hang off the trigger. */
const SEED: FlowStep[] = SEEDED_AUTOMATIONS[2].steps.map((step) => ({ ...step, parentId: ROOT }));

function Canvas() {
  const [trigger, setTrigger] = React.useState<Trigger>(SEEDED_AUTOMATIONS[2].trigger);
  const [name, setName] = React.useState(SEEDED_AUTOMATIONS[2].name);
  const [steps, setSteps] = React.useState<FlowStep[]>(SEED);
  const [nodes, setNodes, onNodesChange] = useNodesState<FlowNode>([]);
  const [edges, setEdges] = useEdgesState<Edge>([]);
  const { fitView } = useReactFlow();

  const stepsRef = React.useRef(steps);
  stepsRef.current = steps;

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
      return [...current, { ...next, parentId }];
    });
  }, []);

  /**
   * Structure in, nodes out. Keyed on the parent links rather than on the whole
   * automation, so typing a prompt does not relayout the canvas under the
   * cursor — the graph only moves when the graph changes.
   */
  const signature = steps.map((step) => `${step.id}<${step.parentId}`).join("|");

  React.useEffect(() => {
    const current = stepsRef.current;
    const positions = layout(current);
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
        dragHandle: ".flow-drag",
        data: {
          step,
          removable: current.length > 1,
          onChange: updateStep,
          onRemove: () => removeStep(step.id),
          onAdd: (relation: "child" | "sibling") =>
            addStep(relation === "child" ? step.id : step.parentId),
        },
      })),
    ];
    setNodes(built);
    setEdges(edgesFor(current));
  }, [signature, addStep, removeStep, updateStep, setNodes, setEdges, trigger]);

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
    const positions = layout(stepsRef.current);
    setNodes((current) =>
      current.map((node) =>
        node.id === ROOT
          ? { ...node, position: { x: -NODE.triggerWidth / 2, y: 0 } }
          : { ...node, position: positions.get(node.id) ?? node.position },
      ),
    );
    window.setTimeout(() => void fitView({ duration: 240, padding: 0.15 }), 0);
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
          fitViewOptions={{ padding: 0.15 }}
          minZoom={0.25}
          proOptions={{ hideAttribution: false }}
          nodesConnectable={false}
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
