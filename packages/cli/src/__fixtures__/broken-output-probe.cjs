// Verify the fixture's OS-level failure, independently of the CLI's handler.
// A missing gate/early write produces no report; a bad descriptor reports EBADF.
const argv = process.argv.slice(2);
const broken = argv[0];
if (broken !== "stdout" && broken !== "stderr") {
  throw new Error("Expected stdout or stderr");
}
const intact = broken === "stdout" ? process.stderr : process.stdout;
process[broken].on("error", (error) => {
  intact.write(JSON.stringify({ code: error.code, argv }));
  process.exitCode = 23;
});
process[broken].write("first byte");
