import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";
import * as NodeTimersPromises from "node:timers/promises";

async function fileExists(filePath) {
  try {
    await NodeFSP.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function tcpPortIsReady({ host, port, connectTimeoutMs = 500 }) {
  return new Promise((resolveReady) => {
    const socket = NodeNet.createConnection({ host, port });
    let settled = false;

    const finish = (ready) => {
      if (settled) {
        return;
      }

      settled = true;
      socket.removeAllListeners();
      socket.destroy();
      resolveReady(ready);
    };

    socket.once("connect", () => {
      finish(true);
    });
    socket.once("timeout", () => {
      finish(false);
    });
    socket.once("error", () => {
      finish(false);
    });
    socket.setTimeout(connectTimeoutMs);
  });
}

async function resolvePendingResources({ baseDir, files, tcpHost, tcpPort, connectTimeoutMs }) {
  const pendingFiles = [];

  for (const relativeFilePath of files) {
    const ready = await fileExists(NodePath.resolve(baseDir, relativeFilePath));
    if (!ready) {
      pendingFiles.push(relativeFilePath);
    }
  }

  const tcpReady = await tcpPortIsReady({
    host: tcpHost,
    port: tcpPort,
    connectTimeoutMs,
  });

  return {
    pendingFiles,
    tcpReady,
  };
}

export async function waitForResources({
  baseDir,
  files = [],
  intervalMs = 100,
  timeoutMs = 120_000,
  tcpHost,
  tcpPort,
  connectTimeoutMs = 500,
}) {
  if (!tcpHost) {
    throw new TypeError("waitForResources requires a tcpHost");
  }
  if (!Number.isInteger(tcpPort) || tcpPort <= 0) {
    throw new TypeError("waitForResources requires a positive integer tcpPort");
  }

  const startedAt = Date.now();

  while (true) {
    const { pendingFiles, tcpReady } = await resolvePendingResources({
      baseDir,
      files,
      tcpHost,
      tcpPort,
      connectTimeoutMs,
    });

    if (pendingFiles.length === 0 && tcpReady) {
      return;
    }

    if (Date.now() - startedAt >= timeoutMs) {
      const pendingResources = [];
      if (!tcpReady) {
        pendingResources.push(`tcp:${tcpHost}:${tcpPort}`);
      }
      for (const filePath of pendingFiles) {
        pendingResources.push(`file:${filePath}`);
      }

      throw new Error(
        `Timed out waiting for desktop dev resources after ${timeoutMs}ms: ${pendingResources.join(", ")}`,
      );
    }

    await NodeTimersPromises.setTimeout(intervalMs);
  }
}
