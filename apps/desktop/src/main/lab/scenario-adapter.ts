/**
 * A harness that only ever plays a script.
 *
 * It is a `NativeHarnessAdapter` and nothing else — the Session runtime cannot
 * tell it from OpenCode, so a scripted permission travels the same road a real
 * one does: observation, durable event, projection, tRPC frame, renderer. That
 * is the whole point of hosting scenarios here rather than handing the chat
 * surface a hand-built projection. A fixture that skips the ledger proves the
 * component renders; it proves nothing about what reaches the component.
 *
 * One harness profile per scenario, which is how the pick travels: the renderer
 * attaches with `profileId` set to the scenario's id and the runtime validates
 * it against this manifest, so an unknown scenario fails as a profile rather
 * than as a silent empty stream.
 *
 * Dev-only. It is constructed by the lab's Vite middleware and by nothing else.
 */
import type {
  BindingHandle,
  DeliveryReceipt,
  HarnessCommand,
  HarnessObservation,
  NativeAttachmentSpec,
  NativeHarnessAdapter,
  NativeProbeContext,
  NativeProbeResult,
  ObservationSink,
} from "@volli/session-engine";

import {
  labScenario,
  LAB_SCENARIOS,
  LAB_SCENARIO_ADAPTER_ID,
  LAB_SCENARIO_TURN_ID,
  type LabScenario,
  type LabScenarioBeat,
} from "../../lab-scenarios";

/**
 * Long enough that the beats arrive as a stream through the subscription rather
 * than as one snapshot, short enough that a pick feels like a click.
 */
const DEFAULT_BEAT_DELAY_MS = 90;

export interface LabScenarioAdapterOptions {
  now?: () => number;
  /** Zero makes a script deterministic for a test. */
  beatDelayMs?: number;
  /** Where a failed beat is reported. Defaults to the console. */
  onBeatFailure?: (error: unknown) => void;
}

export function createLabScenarioAdapter(
  options: LabScenarioAdapterOptions = {},
): NativeHarnessAdapter {
  const now = options.now ?? Date.now;
  const beatDelayMs = options.beatDelayMs ?? DEFAULT_BEAT_DELAY_MS;
  const onBeatFailure =
    options.onBeatFailure ?? ((error: unknown) => console.error("[lab-scenario]", error));

  return {
    manifest: {
      id: LAB_SCENARIO_ADAPTER_ID,
      displayName: "Lab scenarios",
      adapterVersion: "1.0.0",
      profiles: LAB_SCENARIOS.map((scenario) => ({
        id: scenario.id,
        label: scenario.label,
        transport: "native" as const,
      })),
    },

    async probe(context: NativeProbeContext): Promise<NativeProbeResult> {
      const scenario = labScenario(context.profileId);
      if (!scenario) {
        return {
          status: "unavailable",
          runtime: null,
          reason: `Lab scenario ${context.profileId} does not exist`,
        };
      }
      return {
        status: "available",
        runtime: {
          path: "lab://scenarios",
          version: "1.0.0",
          fingerprint: `${LAB_SCENARIO_ADAPTER_ID}:${scenario.id}`,
        },
        // Deliberately empty. A scripted harness has no models to offer and
        // claiming some would put a lab fixture in the composer's model pill.
        capabilities: { features: [], catalog: [] },
      };
    },

    async attach(spec: NativeAttachmentSpec, sink: ObservationSink): Promise<BindingHandle> {
      const scenario = labScenario(spec.profileId);
      if (!scenario) throw new Error(`Lab scenario ${spec.profileId} does not exist`);
      return new LabScenarioBinding({
        scenario,
        spec,
        sink,
        now,
        beatDelayMs,
        onBeatFailure,
      });
    },
  };
}

interface LabScenarioBindingOptions {
  scenario: LabScenario;
  spec: NativeAttachmentSpec;
  sink: ObservationSink;
  now: () => number;
  beatDelayMs: number;
  onBeatFailure: (error: unknown) => void;
}

class LabScenarioBinding implements BindingHandle {
  readonly native: BindingHandle["native"];
  readonly #options: LabScenarioBindingOptions;
  /**
   * Beats commit in order and never overlap a reply's own beats, so a script
   * and an answer cannot interleave into a history that never happened.
   */
  #queue: Promise<void> = Promise.resolve();
  #sequence = 0;
  #released = false;

  constructor(options: LabScenarioBindingOptions) {
    this.#options = options;
    this.native = {
      id: `${LAB_SCENARIO_ADAPTER_ID}:${options.spec.attachmentId}`,
      detail: { scenario: options.scenario.id },
    };
    this.#play(options.scenario.beats({ now: options.now() }));
  }

  async dispatch(command: HarnessCommand): Promise<DeliveryReceipt> {
    // A script has no model behind it and nothing to say back, so a message has
    // nowhere to go. `rejected` is the receipt contract's answer for a command
    // this harness cannot serve: `accepted` for a command that was dispatched
    // nowhere told the surface the words had landed, which cleared the composer
    // over a message that no longer existed anywhere.
    if (command.kind === "message.submit") {
      return {
        commandId: command.commandId,
        status: "rejected",
        code: "unsupported_command",
        detail: `Lab scenario ${this.#options.scenario.id} plays a script and takes no messages`,
        native: this.native,
      };
    }
    if (command.kind === "model.select") {
      return {
        commandId: command.commandId,
        status: "rejected",
        code: "unsupported_command",
        detail: `Lab scenario ${this.#options.scenario.id} has no live model policy`,
        native: this.native,
      };
    }
    if (command.kind === "executor.retry") {
      return {
        commandId: command.commandId,
        status: "rejected",
        code: "unsupported_command",
        detail: `Lab scenario ${this.#options.scenario.id} has no failed runtime turn to retry`,
        native: this.native,
      };
    }
    const accepted: DeliveryReceipt = {
      commandId: command.commandId,
      status: "accepted",
      acceptedAt: this.#options.now(),
      native: this.native,
    };
    // Stop is the turn's other exit, and a script has to honour it or the card
    // offers a button that does nothing.
    if (command.kind === "executor.interrupt") {
      this.#play([{ kind: "turn.completed", turnId: LAB_SCENARIO_TURN_ID }]);
      return accepted;
    }

    // The verdict is the harness's to state, and stating it is what clears the
    // card. Queued rather than awaited: the runtime is still inside this
    // command and has not yet written its delivery receipt.
    const context = {
      now: this.#options.now(),
      interactionId: command.interaction.id,
      optionIds: [...command.resolution.optionIds],
    };
    this.#play([
      {
        kind: "interaction.resolved",
        interactionId: command.interaction.id,
        resolution: command.resolution,
      },
      ...(this.#options.scenario.afterResolve?.(context) ?? []),
    ]);
    return accepted;
  }

  /** A script has no upstream to re-read; everything it will ever say is already queued. */
  async reconcile(): ReturnType<BindingHandle["reconcile"]> {
    return { cursor: null, observations: [], receipts: [] };
  }

  async release(): Promise<void> {
    this.#released = true;
  }

  #play(beats: readonly LabScenarioBeat[]): void {
    this.#queue = this.#queue
      .then(async () => {
        for (const beat of beats) {
          if (this.#released) return;
          if (this.#options.beatDelayMs > 0) await delay(this.#options.beatDelayMs);
          if (this.#released) return;
          await this.#options.sink.emit(this.#stamp(beat));
        }
      })
      .catch((error: unknown) => {
        this.#options.onBeatFailure(error);
      });
  }

  /**
   * The envelope a harness owes every observation: an identity stable across
   * repeats, and when it happened. Written as a switch rather than one spread so
   * each branch stays a concrete member of the union — a single spread over the
   * union would need a cast, and a cast here is exactly the kind of hole that
   * lets a malformed fixture reach the ledger.
   */
  #stamp(beat: LabScenarioBeat): HarnessObservation {
    const id = `${this.#options.spec.attachmentId}:beat:${++this.#sequence}`;
    const occurredAt = this.#options.now();
    switch (beat.kind) {
      case "transcript.message":
        return { ...beat, id, occurredAt };
      case "turn.started":
      case "turn.completed":
      case "turn.interrupted":
        return { ...beat, id, occurredAt };
      case "interaction.opened":
        return { ...beat, id, occurredAt };
      case "interaction.resolved":
        return { ...beat, id, occurredAt };
      case "attention.raised":
        return { ...beat, id, occurredAt };
      case "attention.cleared":
        return { ...beat, id, occurredAt };
      case "attachment.failed":
        return { ...beat, id, occurredAt };
      case "attachment.closed":
        return { ...beat, id, occurredAt };
      case "transcript.delta":
        return { ...beat, id, occurredAt };
    }
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
