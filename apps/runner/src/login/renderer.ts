import { ModelAccessSignInService } from "@volli/host-core/session-runtime";
import type { PiSignIn } from "@volli/agent-runtime";
import type {
  ModelAccessSignInEvent,
  ModelAccessSignInPrompt,
  ModelAccessSignInType,
  ModelAccessSignInUpdate,
} from "@volli/shared";

export interface LoginTerminal {
  write(text: string): void;
  /** Answers are never echoed, logged, or retained as terminal history. */
  read(prompt: ModelAccessSignInPrompt, signal: AbortSignal): Promise<string>;
  close(): void;
}

/** One ephemeral sign-in conversation, not a Session or a durable transcript. */
export async function renderLogin(
  pi: PiSignIn,
  providerId: string,
  type: ModelAccessSignInType,
  terminal: LoginTerminal,
  signal: AbortSignal,
): Promise<number> {
  const service = new ModelAccessSignInService({ pi });
  const pending = new Map<string, AbortController>();
  const stopInputs = (): void => {
    for (const controller of pending.values()) controller.abort();
    pending.clear();
  };
  let finish!: (code: number) => void;
  const done = new Promise<number>((resolve) => {
    finish = resolve;
  });
  let attemptId: string;
  // Registered only after begin returned its id.
  const cancel = (): void => {
    service.cancel(attemptId);
  };
  const send = (update: ModelAccessSignInUpdate): void => {
    switch (update.kind) {
      case "prompt": {
        const controller = new AbortController();
        pending.set(update.prompt.promptId, controller);
        void terminal.read(update.prompt, controller.signal).then(
          (answer) => {
            if (!pending.delete(update.prompt.promptId)) return;
            service.respond(update.attemptId, update.prompt.promptId, answer);
          },
          () => {
            if (pending.delete(update.prompt.promptId)) service.cancel(update.attemptId);
          },
        );
        break;
      }
      case "prompt-withdrawn":
        pending.get(update.promptId)?.abort();
        pending.delete(update.promptId);
        break;
      case "event":
        terminal.write(renderEvent(update.event));
        break;
      case "settled":
        stopInputs();
        if (update.outcome.kind === "signed-in") {
          terminal.write(`Stored sign-in for ${providerId}.\n`);
          finish(0);
        } else {
          // Provider exceptions can contain keys, tokens or pasted callback URLs.
          // The service redacts submitted values; the terminal also withholds its
          // free-form failure text, including credentials shorter than 8 chars.
          terminal.write(
            update.outcome.kind === "cancelled"
              ? "Sign-in cancelled.\n"
              : "Sign-in failed. Check the provider and try again.\n",
          );
          finish(signal.aborted ? 130 : 1);
        }
        break;
    }
  };
  const begin = service.begin(providerId, type, { send });
  if (!begin.ok) {
    terminal.write(`${begin.error}\n`);
    terminal.close();
    return 1;
  }
  attemptId = begin.attemptId;
  signal.addEventListener("abort", cancel, { once: true });
  if (signal.aborted) cancel();
  try {
    return await done;
  } finally {
    signal.removeEventListener("abort", cancel);
    stopInputs();
    terminal.close();
  }
}

function renderEvent(event: ModelAccessSignInEvent): string {
  switch (event.kind) {
    case "auth-url":
      return (
        `Open this URL in your browser:\n${event.url}\n` +
        `${event.instructions === null ? "" : `${event.instructions}\n`}` +
        "On SSH, follow the provider's paste-code or redirect-URL prompt.\n" +
        (event.url.includes("1455")
          ? "For a port-1455 callback, connect with ssh -L 1455:localhost:1455 <box>.\n"
          : "")
      );
    case "device-code":
      return `Open ${event.verificationUri} and enter code ${event.userCode}.\n`;
    case "info":
      return `${event.message}\n${event.links.map((link) => `${link.url}\n`).join("")}`;
    case "progress":
      return `${event.message}\n`;
  }
}
