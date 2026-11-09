/** The daemon the shell's own tests run as: a name no real program has. */
import type { ShellIdentity } from "../shell/identity";

export const EXAMPLE: ShellIdentity = {
  program: "volli-example",
  daemon: "example",
  filePrefix: "example",
};
