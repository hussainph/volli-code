/**
 * VC-615 flow 1 — Add a host over SSH, over the real app window.
 *
 * Type `you@box` or pick a host from `~/.ssh/config`; the sheet connects,
 * checks the system, installs, starts and pairs, then ends on the box's
 * sign-ins. Three directions for how much of that you watch — open decision 5
 * — behind the picker (1/2/3, ←/→, R to replay):
 *
 *  - **Checklist** — five rows that turn into facts about the box; the log is
 *    one click away. VS Code Remote-SSH's honesty with Setup Assistant's calm.
 *  - **Quiet** — one object, one ring, one line. The box's facts gather under
 *    its name. Nothing technical unless something breaks.
 *  - **Console** — the pipeline beside the live commands, for people who want
 *    to see exactly what ran on their machine.
 *
 * The lab bar picks the outcome. "Natural" lets each `~/.ssh/config` host end
 * its own way (hetzner-1 succeeds, mac-mini is a Mac, build has an older host,
 * studio is already paired, pi is arm64, staging has no linger); the rest force
 * one failure on whatever you connect to.
 */
import * as React from "react";
import { AnimatePresence, motion, MotionConfig } from "motion/react";
import { CaretDownIcon } from "@phosphor-icons/react/dist/csr/CaretDown";
import { toast } from "sonner";

import { AppShell } from "@renderer/components/app-shell";
import { Button } from "@renderer/components/ui/button";
import { cn } from "@renderer/lib/utils";

import { seedApp } from "../seed";
import { shellApi } from "../remote-host/shell-api";
import {
  Entry,
  ReadyBody,
  RecoveryReveal,
  Screen,
  SheetFrame,
  useRecovery,
  type Transport,
} from "../remote-host/add-sheet";
import {
  APP_VERSION,
  OUTCOME_LABELS,
  type Outcome,
  type SshConfigHost,
} from "../remote-host/fixtures";
import {
  currentStep,
  initialInstall,
  installScript,
  overallProgress,
  STEP_NOUN,
  STEP_ORDER,
  type Answer,
  type InstallState,
  type LogLine,
  type Question,
  type StepId,
  type Target,
} from "../remote-host/install-script";
import {
  LabBar,
  LabPills,
  LabSelect,
  ProtoPicker,
  SPEEDS,
  useVariants,
  type Speed,
} from "../remote-host/lab-chrome";
import {
  AutoHeight,
  EASE_OUT,
  HostGlyph,
  ProgressLine,
  StepMark,
  SwapText,
  type GlyphBadge,
} from "../remote-host/parts";
import { useScript, type Script } from "../remote-host/script";
import { defaultForwarding } from "../remote-host/sign-in-rows";

export const title = "Remote host — Add a host over SSH";
export const note =
  "VC-615 flow 1: address → connect, check, install, start, pair → sign-ins; every failure";
export const viewport = "window";
export const seed = seedApp;
export const api = shellApi;

const VARIANTS = ["Checklist", "Quiet", "Console"] as const;
const WIDTHS = [480, 440, 760] as const;

type OutcomeChoice = "natural" | Outcome;
const OUTCOME_OPTIONS: readonly { value: OutcomeChoice; label: string }[] = [
  { value: "natural", label: "Natural (per host)" },
  ...(Object.keys(OUTCOME_LABELS) as Outcome[]).map((value) => ({
    value,
    label: OUTCOME_LABELS[value],
  })),
];

type Flow =
  | { screen: "entry"; query: string }
  | { screen: "run"; target: Target; outcome: Outcome; run: number }
  | { screen: "closed" };

type Install = Script<InstallState, Question, Answer>;

export default function AddHostScratch() {
  const variants = useVariants(VARIANTS.length);
  const [outcome, setOutcome] = React.useState<OutcomeChoice>("natural");
  const [speed, setSpeed] = React.useState<Speed>("1");
  const [flow, setFlow] = React.useState<Flow>({ screen: "entry", query: "" });
  const runs = React.useRef(0);
  const [added, setAdded] = React.useState<{ name: string; os: "linux" | "macos" } | null>(null);

  const resolve = (config: SshConfigHost | null): Outcome =>
    outcome === "natural" ? (config?.natural ?? "success") : outcome;

  // A new outcome while a run is on screen re-runs it with that ending.
  React.useEffect(() => {
    setFlow((current) =>
      current.screen === "run" && outcome !== "natural"
        ? { ...current, outcome, run: (runs.current += 1) }
        : current,
    );
  }, [outcome]);

  const close = React.useCallback(() => setFlow({ screen: "closed" }), []);
  const variant = variants.current;

  return (
    <MotionConfig reducedMotion="user">
      <div className="relative h-svh w-full">
        <AppShell />
        <AnimatePresence>
          {added ? <LandedChip key={added.name} {...added} /> : null}
        </AnimatePresence>
        <AnimatePresence>
          {flow.screen === "closed" ? null : (
            <SheetFrame
              key="sheet"
              width={WIDTHS[variant] ?? 480}
              onClose={close}
              label="Add a host"
            >
              <AutoHeight>
                <AnimatePresence initial={false} mode="popLayout">
                  {flow.screen === "entry" ? (
                    <Screen id={`entry-${variants.mountKey}`} key={`entry-${variants.mountKey}`}>
                      <Entry
                        initialQuery={flow.query}
                        detailColumns={variant === 2}
                        onPairCode={() => {
                          window.location.hash = "host-pair";
                        }}
                        onConnect={(target, config) =>
                          setFlow({
                            screen: "run",
                            target,
                            outcome: resolve(config),
                            run: (runs.current += 1),
                          })
                        }
                      />
                    </Screen>
                  ) : flow.screen === "run" ? (
                    <Screen
                      id={`run-${flow.run}-${variants.mountKey}`}
                      key={`run-${flow.run}-${variants.mountKey}`}
                    >
                      <Run
                        variant={variant}
                        target={flow.target}
                        outcome={flow.outcome}
                        speed={Number(speed)}
                        runKey={`${flow.run}-${variants.mountKey}`}
                        onBack={() => setFlow({ screen: "entry", query: flow.target.alias })}
                        onCancel={close}
                        onOpened={() => {
                          close();
                          toast(`Opened ${flow.target.alias}`);
                        }}
                        onDone={() => {
                          close();
                          setAdded({
                            name: flow.target.alias,
                            os: flow.outcome === "success-mac" ? "macos" : "linux",
                          });
                          toast.success(`${flow.target.alias} is ready`, {
                            description: "New tickets can run there",
                          });
                        }}
                      />
                    </Screen>
                  ) : null}
                </AnimatePresence>
              </AutoHeight>
            </SheetFrame>
          )}
        </AnimatePresence>
      </div>

      <LabBar>
        <LabSelect
          label="Outcome"
          value={outcome}
          options={OUTCOME_OPTIONS}
          onChange={setOutcome}
        />
        <LabPills label="Speed" value={speed} options={SPEEDS} onChange={setSpeed} />
        <button
          type="button"
          onClick={() => setFlow({ screen: "entry", query: "" })}
          className="rounded-full bg-foreground px-2.5 py-1 text-[11px] text-background"
        >
          Add a host…
        </button>
      </LabBar>
      <ProtoPicker
        names={VARIANTS}
        current={variant}
        onSelect={variants.select}
        onReplay={() => {
          variants.replay();
          setFlow((current) =>
            current.screen === "run" ? { ...current, run: (runs.current += 1) } : current,
          );
        }}
      />
    </MotionConfig>
  );
}

/**
 * Where the host lands: the title-bar host chip (see the health scratch).
 * It arrives once, from the sheet's direction, and settles — the one
 * moment in the flow allowed a little ceremony.
 */
function LandedChip({ name, os }: { name: string; os: "linux" | "macos" }) {
  return (
    <motion.div
      className="fixed top-[7px] left-[196px] z-40 flex h-7 items-center gap-2 rounded-full pr-2 pl-0.5 text-ui"
      initial={{ opacity: 0, y: 24, scale: 0.9, filter: "blur(4px)" }}
      animate={{ opacity: 1, y: 0, scale: 1, filter: "blur(0px)" }}
      exit={{ opacity: 0 }}
      transition={{ type: "spring", duration: 0.6, bounce: 0.2, delay: 0.15 }}
    >
      <motion.span
        aria-hidden
        className="pointer-events-none absolute inset-0 rounded-full bg-primary/15"
        initial={{ opacity: 1 }}
        animate={{ opacity: 0 }}
        transition={{ duration: 1.4, delay: 0.6, ease: "easeOut" }}
      />
      <HostGlyph os={os} size="sm" />
      <span className="relative">{name}</span>
      <CaretDownIcon className="relative size-3 text-muted-foreground" />
    </motion.div>
  );
}

/* ── One run, in the chosen direction ───────────────────────────────────── */

interface RunProps {
  variant: number;
  target: Target;
  outcome: Outcome;
  speed: number;
  runKey: string;
  onBack: () => void;
  onCancel: () => void;
  onOpened: () => void;
  onDone: () => void;
}

function Run(props: RunProps) {
  const { target, outcome, speed, runKey, onBack, onOpened } = props;
  const install = useScript<InstallState, Question, Answer>(
    () => initialInstall(target),
    installScript(outcome, target),
    { speed, key: runKey },
  );
  const phase = install.state.phase;
  React.useEffect(() => {
    if (phase === "back") onBack();
    if (phase === "opened") onOpened();
  }, [phase, onBack, onOpened]);

  const [forwarding, setForwarding] = React.useState(defaultForwarding);
  const [transport, setTransport] = React.useState<Transport>("ssh");
  const recovery = useRecovery(install.question, target.alias, target.user, install.answer);

  const ready =
    phase === "done" ? (
      <ReadyBody
        host={target.alias}
        forwarding={forwarding}
        onForwarding={setForwarding}
        transport={transport}
        onTransport={setTransport}
        onDone={props.onDone}
      />
    ) : null;

  const shared = { install, recovery, ready, target, onCancel: props.onCancel };
  if (props.variant === 1) return <QuietRun {...shared} />;
  if (props.variant === 2) return <ConsoleRun {...shared} />;
  return <ChecklistRun {...shared} />;
}

interface ViewProps {
  install: Install;
  recovery: { body: React.ReactNode; actions: React.ReactNode } | null;
  ready: React.ReactNode;
  target: Target;
  onCancel: () => void;
}

function glyphBadge(state: InstallState): GlyphBadge {
  if (state.phase === "done") return "ok";
  const step = currentStep(state);
  if (step === null) return null;
  const status = state.steps[step].status;
  if (status === "failed") return "fail";
  if (status === "attention") return "attention";
  return null;
}

function address(target: Target): string {
  return `${target.user}@${target.hostname}${target.port ? `:${target.port}` : ""}`;
}

function Footer({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("flex items-center gap-2 border-t border-border/60 px-4 py-4", className)}>
      {children}
    </div>
  );
}

/* ── 1 · Checklist ──────────────────────────────────────────────────────── */

function ChecklistRun({ install, recovery, ready, target, onCancel }: ViewProps) {
  const { state } = install;
  const done = state.phase === "done";
  const [details, setDetails] = React.useState(false);

  return (
    <div>
      <div className="flex items-center gap-4 px-6 pt-6 pb-4">
        <HostGlyph os={state.os} size="md" badge={glyphBadge(state)} />
        <div className="min-w-0">
          <h2 className="text-heading font-semibold">
            <SwapText>{done ? `${target.alias} is ready` : target.alias}</SwapText>
          </h2>
          <p className={cn("truncate text-ui text-muted-foreground", !done && "font-mono")}>
            {done ? readySummary(state) : address(target)}
          </p>
        </div>
      </div>

      <AnimatePresence initial={false}>
        {done ? null : (
          <motion.div
            key="steps"
            initial={false}
            exit={{ opacity: 0, height: 0, transition: { duration: 0.24, ease: EASE_OUT } }}
          >
            <ol className="flex flex-col px-6 pb-4">
              {STEP_ORDER.map((id) => (
                <ChecklistRow key={id} id={id} state={state} />
              ))}
            </ol>
            <RecoveryReveal className="px-6 pb-4">{recovery?.body}</RecoveryReveal>
            <AnimatePresence initial={false}>
              {details ? (
                <motion.div
                  key="log"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.16 }}
                  className="px-6 pb-4"
                >
                  <LogView lines={state.log} running={state.phase === "running"} className="h-40" />
                </motion.div>
              ) : null}
            </AnimatePresence>
            <Footer>
              <Button
                size="sm"
                variant="ghost"
                className="text-muted-foreground"
                aria-expanded={details}
                onClick={() => setDetails((value) => !value)}
              >
                Details
                <CaretDownIcon
                  className={cn(
                    "size-3 transition-transform duration-200 ease-out",
                    details && "rotate-180",
                  )}
                />
              </Button>
              <span className="flex-1" />
              {recovery?.actions ?? (
                <Button size="sm" variant="ghost" onClick={onCancel}>
                  Cancel
                </Button>
              )}
            </Footer>
          </motion.div>
        )}
      </AnimatePresence>
      {ready}
    </div>
  );
}

function ChecklistRow({ id, state }: { id: StepId; state: InstallState }) {
  const step = state.steps[id];
  const showBar = step.status === "active" && step.progress !== undefined;
  return (
    <li className="flex flex-col">
      <div className="flex h-8 items-center gap-2">
        <StepMark status={step.status} />
        <SwapText
          className={cn(
            "min-w-0 flex-1 text-ui transition-colors duration-200",
            step.status === "pending" ? "text-muted-foreground" : "text-foreground",
            step.status === "done" && "text-foreground/90",
          )}
        >
          {step.status === "active" ? `${step.label}…` : step.label}
        </SwapText>
        {step.detail ? (
          <span className="shrink-0 text-ui text-muted-foreground tabular-nums">{step.detail}</span>
        ) : null}
      </div>
      <AnimatePresence initial={false}>
        {showBar ? (
          <motion.div
            key="bar"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.2, ease: EASE_OUT }}
            className="pl-6"
          >
            <ProgressLine value={step.progress ?? 0} className="mb-2" />
          </motion.div>
        ) : null}
      </AnimatePresence>
    </li>
  );
}

function readySummary(state: InstallState): string {
  return [...state.facts.slice(0, 2), `Volli host ${state.version}`].join(" · ");
}

/* ── 2 · Quiet ──────────────────────────────────────────────────────────── */

function QuietRun({ install, recovery, ready, target, onCancel }: ViewProps) {
  const { state } = install;
  const done = state.phase === "done";
  const step = currentStep(state);
  const active = step ? state.steps[step] : null;
  const tone: "run" | "fail" | "attention" | "done" = done
    ? "done"
    : active?.status === "failed"
      ? "fail"
      : active?.status === "attention"
        ? "attention"
        : "run";
  const line = done
    ? null
    : active === null
      ? "Connecting"
      : active.status === "active" && !active.detail
        ? `${active.label}…`
        : active.label;
  // The byte count ticks every frame, so it never rides the swap animation —
  // only the words do.
  const detail = !done && active?.status === "active" ? active.detail : undefined;

  return (
    <div>
      <div className="flex flex-col items-center px-6 pt-8 pb-6 text-center">
        <ProgressRing value={overallProgress(state)} tone={tone}>
          <HostGlyph os={state.os} size="lg" badge={done ? "ok" : null} />
        </ProgressRing>
        <h2 className="mt-4 text-heading font-semibold">
          <SwapText>{done ? `${target.alias} is ready` : target.alias}</SwapText>
        </h2>
        <div className="h-5">
          {line ? (
            <span
              className={cn(
                "inline-flex items-center gap-1 text-ui",
                tone === "fail" ? "text-destructive" : "text-muted-foreground",
              )}
            >
              <SwapText>{line}</SwapText>
              {detail ? <span className="tabular-nums">· {detail}</span> : null}
            </span>
          ) : (
            <span className="text-ui text-muted-foreground">Volli host {state.version}</span>
          )}
        </div>
        <ul className="mt-2 flex h-6 flex-wrap items-center justify-center gap-1">
          <AnimatePresence initial={false}>
            {state.facts.map((fact) => (
              <motion.li
                key={fact}
                layout
                initial={{ opacity: 0, scale: 0.85, filter: "blur(3px)" }}
                animate={{ opacity: 1, scale: 1, filter: "blur(0px)" }}
                transition={{ duration: 0.24, ease: EASE_OUT }}
                className="rounded-full border border-border bg-muted/40 px-2 text-ui leading-5 text-muted-foreground"
              >
                {fact}
              </motion.li>
            ))}
          </AnimatePresence>
        </ul>
        <RecoveryReveal className="mt-4 w-full text-left">{recovery?.body}</RecoveryReveal>
      </div>
      {done ? (
        ready
      ) : (
        <Footer className="justify-center border-t-0 pt-0">
          {recovery?.actions ?? (
            <Button size="sm" variant="ghost" className="text-muted-foreground" onClick={onCancel}>
              Cancel
            </Button>
          )}
        </Footer>
      )}
    </div>
  );
}

function ProgressRing({
  value,
  tone,
  children,
}: {
  value: number;
  tone: "run" | "fail" | "attention" | "done";
  children: React.ReactNode;
}) {
  const r = 38;
  const circumference = 2 * Math.PI * r;
  return (
    <div className="relative grid size-22 place-items-center">
      <svg viewBox="0 0 88 88" className="absolute inset-0 size-22 -rotate-90" aria-hidden>
        <circle
          cx="44"
          cy="44"
          r={r}
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          className="text-border/70"
        />
        <motion.circle
          cx="44"
          cy="44"
          r={r}
          fill="none"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeDasharray={circumference}
          initial={false}
          animate={{
            strokeDashoffset: circumference * (1 - Math.max(0.03, value)),
            opacity: tone === "done" ? 0 : 1,
          }}
          transition={{
            strokeDashoffset: { duration: 0.5, ease: EASE_OUT },
            opacity: { duration: 0.4, delay: 0.25 },
          }}
          className={cn(
            "transition-colors duration-200",
            tone === "fail"
              ? "stroke-destructive"
              : tone === "attention"
                ? "stroke-attention"
                : "stroke-foreground/80",
          )}
        />
      </svg>
      {children}
    </div>
  );
}

/* ── 3 · Console ────────────────────────────────────────────────────────── */

function ConsoleRun({ install, recovery, ready, target, onCancel }: ViewProps) {
  const { state } = install;
  const done = state.phase === "done";
  const timings = useStepTimings(state);

  return (
    <div>
      <div className="flex items-center gap-4 px-6 pt-6 pb-4">
        <HostGlyph os={state.os} size="md" badge={glyphBadge(state)} />
        <div className="min-w-0">
          <h2 className="text-heading font-semibold">
            <SwapText>{done ? `${target.alias} is ready` : `Adding ${target.alias}`}</SwapText>
          </h2>
          <p className={cn("truncate text-ui text-muted-foreground", !done && "font-mono")}>
            {done ? readySummary(state) : address(target)}
          </p>
        </div>
      </div>
      <AnimatePresence initial={false}>
        {done ? null : (
          <motion.div
            key="console"
            initial={false}
            exit={{ opacity: 0, height: 0, transition: { duration: 0.24, ease: EASE_OUT } }}
          >
            <div className="grid grid-cols-[200px_1fr] gap-4 px-6 pb-4">
              <ol className="flex flex-col py-2">
                {STEP_ORDER.map((id) => {
                  const step = state.steps[id];
                  return (
                    <li key={id} className="flex h-8 items-center gap-2">
                      <StepMark status={step.status} />
                      <span
                        className={cn(
                          "flex-1 truncate text-ui",
                          step.status === "pending" ? "text-muted-foreground" : "text-foreground",
                        )}
                      >
                        {STEP_NOUN[id]}
                      </span>
                      <span className="font-mono text-ui text-muted-foreground tabular-nums">
                        {timings[id] ?? ""}
                      </span>
                    </li>
                  );
                })}
              </ol>
              <LogView lines={state.log} running={state.phase === "running"} className="h-64" />
            </div>
            <RecoveryReveal className="px-6 pb-4">
              {recovery ? (
                <div className="flex flex-col gap-2">
                  <p className="text-ui font-medium">{blockedLine(state)}</p>
                  {recovery.body}
                </div>
              ) : null}
            </RecoveryReveal>
            <Footer>
              <span className="flex-1 font-mono text-ui text-muted-foreground">
                volli-hostd {APP_VERSION} · linux-x64 · 48 MB
              </span>
              {recovery?.actions ?? (
                <Button size="sm" variant="ghost" onClick={onCancel}>
                  Cancel
                </Button>
              )}
            </Footer>
          </motion.div>
        )}
      </AnimatePresence>
      {ready}
    </div>
  );
}

function blockedLine(state: InstallState): string {
  const step = currentStep(state);
  return step ? state.steps[step].label : "";
}

function useStepTimings(state: InstallState): Partial<Record<StepId, string>> {
  const started = React.useRef<Partial<Record<StepId, number>>>({});
  const [timings, setTimings] = React.useState<Partial<Record<StepId, string>>>({});
  React.useEffect(() => {
    for (const id of STEP_ORDER) {
      const status = state.steps[id].status;
      if (status === "active" && started.current[id] === undefined)
        started.current[id] = performance.now();
      if (status === "done" && timings[id] === undefined) {
        const begin = started.current[id];
        setTimings((current) => ({
          ...current,
          [id]: begin === undefined ? "—" : `${((performance.now() - begin) / 1000).toFixed(1)}s`,
        }));
      }
    }
  }, [state.steps, timings]);
  return timings;
}

/* ── The log ────────────────────────────────────────────────────────────── */

/**
 * The commands that ran on the box, in the box's terminal colours rather than
 * the app's — this is a window onto another machine, and should look like one.
 */
function LogView({
  lines,
  running,
  className,
}: {
  lines: readonly LogLine[];
  running: boolean;
  className?: string;
}) {
  const scroller = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    const element = scroller.current;
    if (element) element.scrollTo({ top: element.scrollHeight, behavior: "smooth" });
  }, [lines.length]);
  return (
    <div
      ref={scroller}
      className={cn(
        "overflow-y-auto rounded-[14px] border border-white/5 bg-[#101012] px-4 py-2 font-mono text-ui leading-5 text-white/60 shadow-raised",
        className,
      )}
    >
      {lines.map((line) => (
        <motion.div
          key={line.id}
          initial={{ opacity: 0, x: -4 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.16, ease: EASE_OUT }}
          className={cn(
            "break-words whitespace-pre-wrap",
            line.kind === "cmd" && "mt-1 text-white/90",
            line.kind === "ok" && "text-[#5fd38d]",
            line.kind === "err" && "text-[#ff7b72]",
          )}
        >
          {line.kind === "cmd" ? <span className="text-white/35 select-none">$ </span> : null}
          {line.text}
        </motion.div>
      ))}
      {running ? (
        <span className="mt-1 inline-block h-3.5 w-1.5 translate-y-0.5 animate-pulse bg-white/70 [animation-duration:1s]" />
      ) : null}
    </div>
  );
}
