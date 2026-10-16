/**
 * The decision model's say over a new Session's model (VC-432), as the
 * `SessionAutoSelectPort` a start reaches: purpose `model.select` on the one
 * host decision service, with the configured default as the fallback.
 *
 * What is asked and how an answer is read is `@volli/shared`'s
 * (`model-auto-select.ts`); this only joins it to the service and to the
 * setting that says whether a decision may run for a project at all (a cloud
 * model whose opt-in names `model.select`). A miss —
 * unset, not opted in, slow, wrong, below the confidence threshold — is null,
 * and null is the caller's default, instantly and without a word.
 */

import type Database from "better-sqlite3";
import {
  autoSelectRequest,
  decisionTargetFor,
  readAutoSelect,
  type AutoSelectPick,
  type DecisionPort,
} from "@volli/shared";

import type { SessionAutoSelectPort } from "../session-runtime/sessions";
import { resolveScopedDecisionModel } from "./settings";

export function createModelAutoSelect(options: {
  db: Database.Database;
  port: DecisionPort;
}): SessionAutoSelectPort {
  return {
    // Cloud only, and only once the person switched this purpose on: a
    // decision model somebody set up for the `classify` tool does not start
    // choosing models for them, and a local one is not used for this yet.
    available: (projectId) => {
      const setting = resolveScopedDecisionModel(options.db, { sessionId: null, projectId });
      return setting.kind === "cloud" && decisionTargetFor(setting, "model.select").ok;
    },

    async decide({ sessionId, projectId, request, tierHint, candidates, signal }) {
      const asked = autoSelectRequest({ request, tierHint }, candidates);
      if (asked === null) return null;
      return options.port.decide<AutoSelectPick | null>({
        purpose: "model.select",
        sessionId,
        projectId,
        state: asked.state,
        questions: asked.questions,
        ...(signal === undefined ? {} : { signal }),
        use: (answered) => readAutoSelect(answered, candidates),
        fallback: () => null,
      });
    },
  };
}
