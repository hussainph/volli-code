/** A money-spending, dev-server-only comparison; never imported by the app. */
import * as React from "react";
import {
  AUTO_SELECT_MIN_CONFIDENCE,
  autoSelectRequest,
  checkDecisionRequest,
  COST_BASES,
  readDecisionAnswers,
  readAutoSelect,
  type AgentModelTier,
  type DecisionAnswered,
  type DecisionRequest,
  type SessionUsage,
} from "@volli/shared";

import { Button } from "@renderer/components/ui/button";
import {
  BILLING_LOG_LIMIT,
  billingLogJson,
  loadBillingLog,
  saveBillingLog,
} from "../billing-run-log";
import {
  billingAwareRequest,
  billingScenarioCriterion,
  DEFAULT_BILLING_INSTRUCTIONS,
  readBillingAware,
  type BillingCandidate,
} from "../auto-select/billing";
import {
  BILLING_LADDERS,
  EVAL_PROMPTS,
  createBillingCandidates,
  type BillingLadderName,
} from "../auto-select/fixtures";
import { parseBillingCandidates } from "../billing-candidate-input";

const LADDER_NAMES = Object.keys(BILLING_LADDERS) as BillingLadderName[];

export const title = "Auto model choice · billing vs baseline (live Jev)";
export const note =
  "Real classifier calls, manual subscription scenarios, labelled JSON evals. Lab only.";

const field =
  "w-full rounded-md border border-border bg-background px-2 py-2 text-ui outline-none focus-visible:ring-2 focus-visible:ring-ring";
// Access storage inside the log helper's try/catch (the getter itself can throw).
const logStorage = {
  getItem: (key: string) => window.localStorage.getItem(key),
  setItem: (key: string, value: string) => window.localStorage.setItem(key, value),
};
const panel = "rounded-xl border border-border bg-background p-4 space-y-4";
const percent = (n: number) => `${(n * 100).toFixed(1)}%`;
const selectionName = (candidate: BillingCandidate) =>
  `${candidate.selection.providerId}/${candidate.selection.modelId} · ${candidate.selection.reasoningLevel}`;

interface LiveArm {
  answered: DecisionAnswered | null;
  error: string | null;
  usage: SessionUsage[];
  elapsedMs: number;
}
interface Run {
  id: string;
  createdAt: string;
  correctOption: string | null;
  requestText: string;
  tierHint: AgentModelTier | null;
  classifier: { providerId: string; modelId: string };
  candidates: BillingCandidate[];
  requests: { baseline: DecisionRequest; billing: DecisionRequest };
  arms: { baseline: LiveArm; billing: LiveArm };
}

function isRun(value: unknown): value is Run {
  if (typeof value !== "object" || value === null) return false;
  const run = value as Partial<Run>;
  return (
    typeof run.id === "string" &&
    typeof run.createdAt === "string" &&
    (run.correctOption === null || typeof run.correctOption === "string") &&
    typeof run.requestText === "string" &&
    typeof run.classifier?.providerId === "string" &&
    typeof run.classifier.modelId === "string" &&
    Array.isArray(run.candidates) &&
    parseBillingCandidates(run.candidates).ok &&
    run.requests !== undefined &&
    checkDecisionRequest(run.requests.baseline).ok &&
    checkDecisionRequest(run.requests.billing).ok &&
    run.arms !== undefined &&
    isArm(run.arms.baseline, run.requests.baseline) &&
    isArm(run.arms.billing, run.requests.billing)
  );
}
function isUsage(value: unknown): value is SessionUsage {
  if (typeof value !== "object" || value === null) return false;
  const usage = value as Partial<SessionUsage>;
  return (
    usage.cause === "decision" &&
    typeof usage.providerId === "string" &&
    typeof usage.modelId === "string" &&
    (COST_BASES as readonly unknown[]).includes(usage.costBasis) &&
    [
      usage.inputTokens,
      usage.outputTokens,
      usage.cacheReadTokens,
      usage.cacheWriteTokens,
      usage.costUsd,
    ].every((n) => n === null || (typeof n === "number" && Number.isFinite(n) && n >= 0))
  );
}
function isArm(value: unknown, request: DecisionRequest): value is LiveArm {
  if (typeof value !== "object" || value === null) return false;
  const arm = value as Partial<LiveArm>;
  return (
    typeof arm.elapsedMs === "number" &&
    Number.isFinite(arm.elapsedMs) &&
    arm.elapsedMs >= 0 &&
    Array.isArray(arm.usage) &&
    arm.usage.every(isUsage) &&
    (arm.error === null || typeof arm.error === "string") &&
    ((arm.answered === null && typeof arm.error === "string") ||
      (arm.error === null &&
        typeof arm.answered === "object" &&
        arm.answered !== null &&
        arm.answered.model !== null &&
        typeof arm.answered.model === "object" &&
        typeof arm.answered.model.providerId === "string" &&
        typeof arm.answered.model.modelId === "string" &&
        (arm.answered.model.where === "cloud" || arm.answered.model.where === "local") &&
        readDecisionAnswers(request.questions, arm.answered.answers) !== null))
  );
}

function costOf(usage: readonly SessionUsage[]): string {
  const priced = usage.filter((item) => item.costUsd !== null && item.costBasis !== "unavailable");
  if (priced.length === 0) return "Unknown";
  const total = priced.reduce((sum, item) => sum + item.costUsd!, 0);
  const estimated = priced.some((item) => item.costBasis !== "provider-reported");
  return `${estimated ? "~" : ""}$${total.toFixed(8)}${priced.length < usage.length ? "+ (partial)" : ""} · ${estimated ? "catalog estimate" : "provider reported"}`;
}

async function callArm(classifier: Run["classifier"], request: DecisionRequest): Promise<LiveArm> {
  const started = performance.now();
  try {
    const response = await fetch("/__lab/auto-select", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Volli-Lab": "1" },
      body: JSON.stringify({ classifier, request }),
      signal: AbortSignal.timeout(45_000),
    });
    const raw: unknown = await response.json();
    if (typeof raw !== "object" || raw === null) throw new Error("Invalid lab endpoint response.");
    const body = raw as {
      result?: unknown;
      error?: { message?: unknown };
      usage?: unknown;
      elapsedMs?: unknown;
    };
    const arm = {
      answered: response.ok ? body.result : null,
      error: response.ok
        ? null
        : typeof body.error?.message === "string"
          ? body.error.message
          : `Lab endpoint returned ${response.status}`,
      usage: Array.isArray(body.usage) ? body.usage : [],
      elapsedMs: typeof body.elapsedMs === "number" ? body.elapsedMs : performance.now() - started,
    };
    if (!isArm(arm, request)) throw new Error("Invalid lab endpoint response.");
    return arm;
  } catch (error) {
    return {
      answered: null,
      error: error instanceof Error ? error.message : "Could not reach the lab endpoint.",
      usage: [],
      elapsedMs: performance.now() - started,
    };
  }
}

function ArmResult({
  name,
  arm,
  candidates,
  read = readAutoSelect,
}: {
  name: string;
  arm: LiveArm;
  candidates: BillingCandidate[];
  read?: typeof readBillingAware;
}) {
  const answer = arm.answered?.answers["model"];
  const choice = answer?.type === "choice" ? answer : null;
  const picked = arm.answered === null ? null : read(arm.answered, candidates);
  return (
    <section className={panel} aria-label={name}>
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-medium">{name}</h3>
        <span className="text-label text-muted-foreground">{Math.round(arm.elapsedMs)} ms</span>
      </div>
      {arm.error !== null && (
        <p role="alert" className="text-ui text-destructive">
          {arm.error}
        </p>
      )}
      <div className="space-y-1">
        <p className="text-ui font-medium">
          {picked === null
            ? "Fall back to default (option_1)"
            : `Use ${picked.selection.modelId} · ${picked.selection.reasoningLevel}`}
        </p>
        <p className="text-label text-muted-foreground">
          Confidence {choice === null ? "—" : percent(choice.confidence)} · threshold{" "}
          {percent(AUTO_SELECT_MIN_CONFIDENCE)} · {picked === null ? "not cleared" : "cleared"}
        </p>
        <p className="text-label text-muted-foreground">
          Raw pick: {choice?.choice ?? "none"} · classifier cost: {costOf(arm.usage)}
        </p>
      </div>
      <ul className="space-y-2">
        {candidates.map((candidate, index) => {
          const key = `option_${index + 1}`;
          const probability = choice?.probabilities[key];
          return (
            <li key={key} className="space-y-1">
              <div className="flex justify-between gap-2 text-label">
                <span>
                  {key} · {selectionName(candidate)}
                </span>
                <span className="tabular-nums">
                  {probability === undefined ? "—" : percent(probability)}
                </span>
              </div>
              <div className="h-1 overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full bg-primary"
                  style={{ width: `${(probability ?? 0) * 100}%` }}
                />
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function CorrectLabel({ run, onChange }: { run: Run; onChange: (option: string | null) => void }) {
  return (
    <label className="flex flex-wrap items-center gap-2 text-ui">
      Right answer
      <select
        className={`${field} w-auto max-w-full`}
        aria-label={`Right answer for ${run.id}`}
        value={run.correctOption ?? ""}
        onChange={(event) => onChange(event.target.value || null)}
      >
        <option value="">Unlabelled</option>
        {run.candidates.map((candidate, index) => (
          <option key={selectionName(candidate)} value={`option_${index + 1}`}>
            {`option_${index + 1}`} · {selectionName(candidate)}
          </option>
        ))}
      </select>
    </label>
  );
}

export default function BillingAutoSelect() {
  const [candidateText, setCandidateText] = React.useState(() =>
    JSON.stringify(createBillingCandidates("real-user-ladder", Date.now()), null, 2),
  );
  const [requestText, setRequestText] = React.useState(
    "Add a login form with email/password validation and inline error states.",
  );
  const [tierHint, setTierHint] = React.useState<AgentModelTier | "">("");
  const [instructions, setInstructions] = React.useState(DEFAULT_BILLING_INSTRUCTIONS);
  const [providerId, setProviderId] = React.useState("typesafe");
  const [modelId, setModelId] = React.useState("jev-latest");
  const [loaded] = React.useState(() => loadBillingLog<Run>(logStorage, isRun));
  const [runs, setRuns] = React.useState(loaded.runs);
  const runsRef = React.useRef(runs);
  const [storageError, setStorageError] = React.useState(loaded.error);
  const [selectedId, setSelectedId] = React.useState<string | null>(loaded.runs[0]?.id ?? null);
  const [busy, setBusy] = React.useState(false);
  const [runError, setRunError] = React.useState<string | null>(null);
  const lock = React.useRef(false);

  let candidates: BillingCandidate[] = [];
  let candidateError: string | null = null;
  try {
    const parsed = parseBillingCandidates(JSON.parse(candidateText));
    if (parsed.ok) candidates = parsed.candidates;
    else candidateError = parsed.error;
  } catch {
    candidateError = "Candidates must be valid JSON.";
  }
  const now = Date.now();
  const baseline = autoSelectRequest(
    { request: requestText, tierHint: tierHint || null },
    candidates,
  );
  let billing: DecisionRequest | null = null;
  let requestError: string | null = null;
  try {
    billing = billingAwareRequest(
      { request: requestText, tierHint: tierHint || null },
      candidates,
      instructions,
      now,
    );
  } catch (error) {
    requestError = error instanceof Error ? error.message : "Invalid billing request.";
  }
  requestError ??=
    baseline === null || billing === null
      ? "Add at least two candidates."
      : !checkDecisionRequest(baseline).ok
        ? "Baseline exceeds classifier bounds. Shorten candidate text."
        : !requestText.trim()
          ? "Enter a request."
          : !providerId.trim() || !modelId.trim()
            ? "Enter the classifier provider and model."
            : null;
  const selected = runs.find((run) => run.id === selectedId) ?? null;

  function keep(update: (current: Run[]) => Run[]) {
    const next = update(runsRef.current);
    runsRef.current = next;
    setRuns(next);
    setStorageError(saveBillingLog(logStorage, next));
  }
  async function compare() {
    if (
      lock.current ||
      baseline === null ||
      billing === null ||
      candidateError !== null ||
      requestError !== null
    )
      return;
    lock.current = true;
    setBusy(true);
    setRunError(null);
    try {
      // Pace is a fact at the press, not at the last render (the page can sit idle).
      const startedAt = Date.now();
      const submittedBilling = billingAwareRequest(
        { request: requestText, tierHint: tierHint || null },
        candidates,
        instructions,
        startedAt,
      );
      if (submittedBilling === null) throw new Error("Add at least two candidates.");
      const classifier = { providerId: providerId.trim(), modelId: modelId.trim() };
      const [baselineArm, billingArm] = await Promise.all([
        callArm(classifier, baseline),
        callArm(classifier, submittedBilling),
      ]);
      const run: Run = {
        id: crypto.randomUUID(),
        createdAt: new Date(startedAt).toISOString(),
        correctOption: null,
        requestText,
        tierHint: tierHint || null,
        classifier,
        candidates,
        requests: { baseline, billing: submittedBilling },
        arms: { baseline: baselineArm, billing: billingArm },
      };
      keep((current) => [run, ...current].slice(0, BILLING_LOG_LIMIT));
      setSelectedId(run.id);
    } catch (error) {
      setRunError(error instanceof Error ? error.message : "Could not record this run.");
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  function label(id: string, correctOption: string | null) {
    keep((current) => current.map((run) => (run.id === id ? { ...run, correctOption } : run)));
  }
  function exportLog() {
    try {
      const url = URL.createObjectURL(
        new Blob([billingLogJson(runsRef.current)], { type: "application/json" }),
      );
      const link = document.createElement("a");
      link.href = url;
      link.download = `billing-auto-select-${new Date().toISOString().slice(0, 10)}.json`;
      link.click();
      URL.revokeObjectURL(url);
    } catch {
      setRunError("Could not export the run log. Check this browser's download permissions.");
    }
  }

  return (
    <div className="space-y-6 text-foreground">
      <header className="space-y-2">
        <h1 className="text-heading font-medium">Billing-aware auto model choice</h1>
        <p className="text-ui text-muted-foreground">
          Live Jev · manual billing scenarios · baseline unchanged
        </p>
        <p className="text-label text-muted-foreground">
          Run comparison sends both requests to the chosen cloud classifier using server-side Pi
          credentials. Each press makes two paid calls. No calls on edit or load.
        </p>
      </header>
      <fieldset disabled={busy} className="space-y-4 disabled:opacity-70">
        <div className="grid gap-4 md:grid-cols-2">
          <label className="space-y-1 text-ui">
            Classifier provider
            <input
              className={field}
              value={providerId}
              onChange={(event) => setProviderId(event.target.value)}
            />
          </label>
          <label className="space-y-1 text-ui">
            Classifier model
            <input
              className={field}
              value={modelId}
              onChange={(event) => setModelId(event.target.value)}
            />
          </label>
        </div>
        <section className={panel}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-medium">Candidates & billing scenario</h2>
            <label className="flex items-center gap-2 text-label">
              Load ladder
              <select
                className={`${field} w-auto`}
                defaultValue=""
                onChange={(event) => {
                  const ladder = event.target.value as BillingLadderName;
                  if (LADDER_NAMES.includes(ladder))
                    setCandidateText(
                      JSON.stringify(createBillingCandidates(ladder, Date.now()), null, 2),
                    );
                  event.target.value = "";
                }}
              >
                <option value="" disabled>
                  Choose fixture…
                </option>
                {LADDER_NAMES.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <p className="text-label text-muted-foreground">
            Editable JSON · first candidate is the fallback default. Billing is hand-set, not
            measured. Subscription percentages are remaining capacity; reset times are ISO
            timestamps. Unknown windows are not free capacity.
          </p>
          <label className="block space-y-1 text-label">
            Candidate list
            <textarea
              aria-label="Candidate list"
              spellCheck={false}
              className={`${field} h-64 font-mono`}
              value={candidateText}
              onChange={(event) => setCandidateText(event.target.value)}
            />
          </label>
          {candidateError && (
            <p role="alert" className="text-ui text-destructive">
              {candidateError}
            </p>
          )}
          <ul className="space-y-2">
            {candidates.map((candidate, index) => (
              <li key={selectionName(candidate)} className="text-label">
                <span className="font-medium">
                  option_{index + 1} · {selectionName(candidate)}
                </span>
                <p className="text-muted-foreground">{billingScenarioCriterion(candidate, now)}</p>
              </li>
            ))}
          </ul>
        </section>
        <section className={panel}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-medium">Input</h2>
            <label className="flex items-center gap-2 text-label">
              Eval prompt
              <select
                className={`${field} w-auto`}
                defaultValue=""
                onChange={(event) => {
                  const prompt = EVAL_PROMPTS.find((item) => item.id === event.target.value);
                  if (prompt) {
                    setRequestText(prompt.request);
                    setTierHint(prompt.tierHint ?? "");
                  }
                  event.target.value = "";
                }}
              >
                <option value="" disabled>
                  Choose prompt…
                </option>
                {EVAL_PROMPTS.map((prompt) => (
                  <option key={prompt.id} value={prompt.id}>
                    {prompt.id}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label className="block space-y-1 text-ui">
            Request
            <textarea
              className={`${field} h-24`}
              value={requestText}
              onChange={(event) => setRequestText(event.target.value)}
            />
          </label>
          <label className="flex items-center gap-2 text-ui">
            Tier hint
            <select
              className={`${field} w-auto`}
              value={tierHint}
              onChange={(event) => setTierHint(event.target.value as AgentModelTier | "")}
            >
              <option value="">None</option>
              {["fast", "deep", "visual", "ticket", "global"].map((tier) => (
                <option key={tier}>{tier}</option>
              ))}
            </select>
          </label>
        </section>
        <details className={panel}>
          <summary className="cursor-pointer text-ui font-medium">
            Billing-aware wording & exact payloads
          </summary>
          <label className="block space-y-1 text-label">
            Billing instructions
            <textarea
              className={`${field} h-40`}
              value={instructions}
              onChange={(event) => setInstructions(event.target.value)}
            />
          </label>
          <div className="grid gap-4 md:grid-cols-2">
            {[
              ["Baseline", baseline],
              ["Billing-aware", billing],
            ].map(([name, payload]) => (
              <div key={String(name)} className="min-w-0 space-y-2">
                <h3 className="text-ui font-medium">{String(name)}</h3>
                <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words text-label">
                  {JSON.stringify(payload, null, 2)}
                </pre>
              </div>
            ))}
          </div>
        </details>
        {candidateError === null && requestError && (
          <p role="alert" className="text-ui text-destructive">
            {requestError}
          </p>
        )}
        <Button
          size="lg"
          onClick={() => void compare()}
          disabled={candidateError !== null || requestError !== null}
        >
          {busy ? "Calling both arms…" : "Run comparison · 2 live calls"}
        </Button>
      </fieldset>
      {runError && (
        <p role="alert" className="text-ui text-destructive">
          {runError}
        </p>
      )}
      {storageError && (
        <p role="alert" className="text-ui text-destructive">
          {storageError}
        </p>
      )}
      {selected && (
        <section aria-label="Selected comparison" className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-medium">
              Comparison · {new Date(selected.createdAt).toLocaleString()}
            </h2>
            <span className="text-label text-muted-foreground">
              {selected.classifier.providerId}/{selected.classifier.modelId}
            </span>
          </div>
          <p className="text-ui">{selected.requestText}</p>
          <div className="grid gap-4 md:grid-cols-2">
            <ArmResult
              name="Baseline"
              arm={selected.arms.baseline}
              candidates={selected.candidates}
            />
            <ArmResult
              name="Billing-aware"
              arm={selected.arms.billing}
              candidates={selected.candidates}
              read={readBillingAware}
            />
          </div>
          <CorrectLabel run={selected} onChange={(option) => label(selected.id, option)} />
        </section>
      )}
      <section className={panel}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-medium">
            Run log · {runs.length}/{BILLING_LOG_LIMIT}
          </h2>
          <Button variant="outline" disabled={runs.length === 0} onClick={exportLog}>
            Export JSON
          </Button>
        </div>
        <p className="text-label text-muted-foreground">
          Saved in this browser's localStorage. Export includes frozen candidates, both exact
          requests, answers, usage and labels. Oldest runs roll off after {BILLING_LOG_LIMIT}.
        </p>
        {runs.length === 0 ? (
          <p className="text-ui text-muted-foreground">No runs yet.</p>
        ) : (
          <ul className="space-y-2">
            {runs.map((run) => (
              <li
                key={run.id}
                className="flex flex-wrap items-center gap-2 border-t border-border pt-2"
              >
                <Button
                  variant={run.id === selectedId ? "secondary" : "ghost"}
                  className="max-w-full truncate"
                  onClick={() => setSelectedId(run.id)}
                >
                  {new Date(run.createdAt).toLocaleTimeString()} · {run.requestText.slice(0, 64)}
                </Button>
                <span className="text-label text-muted-foreground">
                  {run.correctOption === null ? "Unlabelled" : `Right: ${run.correctOption}`}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
