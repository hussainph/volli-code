// The shape of `npx` and `uvx`: a launcher that starts the real server as its
// CHILD (stdio inherited), rather than becoming it. Closing the launcher's
// stdin or signalling only the launcher leaves that child behind unless the
// whole process group is ended (VC-470).
import { spawn } from "node:child_process";

const [script, ...args] = process.argv.slice(2);
const child = spawn(process.execPath, [script, ...args], { stdio: "inherit" });
child.on("exit", (code, signal) => process.exit(code ?? (signal === null ? 0 : 1)));
// A launcher that ignores SIGTERM, as some wrappers effectively do while they
// wait on their child; only the group kill reaches its child.
process.on("SIGTERM", () => {});
