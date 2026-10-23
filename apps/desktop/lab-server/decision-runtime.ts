/** Loaded by Vite SSR only after an explicit, same-origin lab POST. No Electron or ledger. */
import { createDecisionService } from "../../../packages/agent-runtime/src/decision/service";
import { piDecisionClassifier } from "../../../packages/agent-runtime/src/pi/classifier";
import { piOwnedModelAccess } from "../../../packages/agent-runtime/src/pi/models";
import type { DecisionAnswered, DecisionMiss, SessionUsage } from "@volli/shared";
import type { LabDecisionInput, LabDecisionOutcome } from "./auto-select-plugin";

let access: ReturnType<typeof piOwnedModelAccess> | undefined;

/** In-memory usage only: no Session identity, persistence, or product settings. */
export async function decide(
  input: LabDecisionInput,
  signal: AbortSignal,
): Promise<LabDecisionOutcome> {
  const started = performance.now();
  const usage: SessionUsage[] = [];
  const elapsed = (): number => Math.max(0, performance.now() - started);
  try {
    const owned = (access ??= piOwnedModelAccess());
    // Catalog restoration does not spend a classifier call. A startup failure
    // is still bounded and never forwards paths, credentials, or provider text.
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(40_000)]);
    await new Promise<void>((resolve, reject) => {
      const aborted = (): void => reject(new Error("Lab request withdrawn."));
      if (deadline.aborted) {
        aborted();
        return;
      }
      deadline.addEventListener("abort", aborted, { once: true });
      void owned.catalogReady
        .then(resolve, reject)
        .finally(() => deadline.removeEventListener("abort", aborted));
    });
    const classifier = piDecisionClassifier(owned.models);
    const { providerId, modelId } = input.classifier;
    const service = createDecisionService({
      resolveSetting: () => ({
        kind: "cloud",
        providerId,
        modelId,
        optIn: { acceptedAt: Date.now(), purposes: ["agent.classify"] },
      }),
      classifier: {
        async classify(target, request, options) {
          const answer = await classifier.classify(target, request, options);
          if (answer.usage !== null) usage.push(answer.usage);
          return answer;
        },
      },
    });
    const result = await service.decide<DecisionAnswered | DecisionMiss>({
      purpose: "agent.classify",
      state: input.request.state,
      questions: input.request.questions,
      signal: deadline,
      use: (answer) => answer,
      fallback: (miss) => miss,
    });
    if ("answers" in result) return { ok: true, result, usage: [...usage], elapsedMs: elapsed() };
    // needs-setup text is synthesized by resolveClassifierModel from catalog
    // presence/auth availability, never the provider response/error body.
    const message =
      result.reason === "needs-setup"
        ? result.message
        : {
            unset: "No decision classifier is configured.",
            "not-opted-in": "This lab call is not enabled for the chosen classifier.",
            "invalid-request": "The decision request is invalid.",
            timeout: "The decision classifier timed out.",
            aborted: "The lab call was withdrawn.",
            "provider-error":
              "The decision provider could not answer. Check its sign-in and availability.",
            "malformed-answer": "The decision classifier returned an invalid answer.",
          }[result.reason];
    return {
      ok: false,
      error: { code: result.reason, message },
      usage: [...usage],
      elapsedMs: elapsed(),
    };
  } catch {
    // Retrying an explicit action can restore a catalog after a transient
    // startup failure; a rejected promise must not poison the lab forever.
    access = undefined;
    return {
      ok: false,
      error: {
        code: "runtime-unavailable",
        message: "Could not load Pi's model catalog. Check the lab server and Pi model setup.",
      },
      usage: [...usage],
      elapsedMs: elapsed(),
    };
  }
}
