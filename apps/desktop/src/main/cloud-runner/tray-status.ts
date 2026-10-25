import type { ThisMacRunnerSnapshot } from "@volli/shared";

/** A cloud-only Tray line. Never put runner ids, tokens or paths in it. */
export function runnerTrayStatus(runner: ThisMacRunnerSnapshot): string {
  const name = runner.runnerName ?? "this Mac";
  if (runner.state === "online") return `Connected to Volli Cloud as ${name}`;
  if (runner.state === "offline") {
    const count = runner.waitingFacts;
    return `Offline — ${count} ${count === 1 ? "update" : "updates"} waiting`;
  }
  if (runner.state === "asleep") return `${name} is asleep`;
  if (runner.state === "removed") return `${name} was removed from your account`;
  if (runner.state === "failed") return runner.message ?? "This Mac could not connect";
  if (runner.state === "off") return "This Mac is not connected to Volli Cloud";
  return `Connecting ${name} to Volli Cloud…`;
}
