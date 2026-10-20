/** Keep internal planning and research out of the public repository. */
import { execFileSync } from "node:child_process";

const paths = execFileSync(
  "git",
  [
    "ls-files",
    "--cached",
    "--others",
    "--exclude-standard",
    "-z",
    "--",
    "docs/plans/",
    "docs/research/",
  ],
  { encoding: "utf8" },
)
  .split("\0")
  .filter(Boolean);

if (paths.length > 0) {
  console.error("Internal plans and research must not be committed to the public repository:");
  for (const path of paths) console.error(`  ${path}`);
  process.exitCode = 1;
} else {
  console.log("Public content check passed.");
}
