import type http from "node:http";

export function formatListenError(err: NodeJS.ErrnoException, port: number): string {
  if (err.code === "EADDRINUSE") {
    return `Port ${port} is already in use (another prgenie serve?). Stop it or set PRGENIE_RUNNER_PORT=<port>.`;
  }
  if (err.code === "EACCES") {
    return `Port ${port} is not permitted (try a higher port or run with privileges that can bind it).`;
  }
  if (err.code === "EADDRNOTAVAIL") {
    return `Address is not available for port ${port} (check PRGENIE_RUNNER_HOST).`;
  }
  return err.message || String(err);
}

/** Attach error handling; resolves on `listening`, rejects on bind failure. */
export function bindRunnerHttpServer(
  server: http.Server,
  host: string,
  port: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException) => {
      server.off("listening", onListening);
      reject(Object.assign(err, { message: formatListenError(err, port) }));
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}
