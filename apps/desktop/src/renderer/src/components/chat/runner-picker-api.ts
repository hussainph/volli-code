import type { FunctionReference } from "convex/server";
import type {
  RunnerPickerAnswer,
  SessionStartOnArgs,
  SessionStartOnResult,
  SessionStartStatus,
} from "@volli/shared/cloud";
import type { CloudSession } from "@renderer/lib/cloud-client";

/** C2 references come from the cloud-only runtime, never a Convex value import
 * in a local launch. The explicit shape bridges the contract-only dependency;
 * use generated members directly when the producer's codegen lands. */
interface RunnerPickerApi {
  runnerPicker: {
    forComposer: FunctionReference<"query", "public", { projectId: string }, RunnerPickerAnswer>;
  };
  sessionStarts: {
    startOn: FunctionReference<
      "mutation",
      "public",
      Pick<SessionStartOnArgs, keyof SessionStartOnArgs>,
      SessionStartOnResult
    >;
    status: FunctionReference<"query", "public", { sessionId: string }, SessionStartStatus | null>;
  };
}
export function runnerPickerApi(session: CloudSession): RunnerPickerApi {
  return session.api as unknown as RunnerPickerApi;
}
