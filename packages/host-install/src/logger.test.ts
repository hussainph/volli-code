import { describe, expect, it } from "vite-plus/test";

import { componentLogger, SILENT_LOGGER } from "./logger";
import { recordingLogger } from "./testing/fake-process";

describe("the host-install logger", () => {
  it("stamps every line with its component and host, which no call can replace", () => {
    const { lines, logger } = recordingLogger();
    const log = componentLogger(logger, { host: "box" });
    log.debug("a");
    log.info("b", { step: "probe", component: "forged", host: "forged" });
    log.warn("c");
    log.error("d");
    expect(lines).toEqual([
      { level: "debug", msg: "a", fields: { host: "box", component: "host-install" } },
      {
        level: "info",
        msg: "b",
        fields: { step: "probe", host: "box", component: "host-install" },
      },
      { level: "warn", msg: "c", fields: { host: "box", component: "host-install" } },
      { level: "error", msg: "d", fields: { host: "box", component: "host-install" } },
    ]);
    componentLogger(SILENT_LOGGER).info("nothing");
    for (const level of ["debug", "info", "warn", "error"] as const) SILENT_LOGGER[level]("x");
  });
});
