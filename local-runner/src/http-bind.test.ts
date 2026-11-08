import assert from "node:assert/strict";
import http from "node:http";
import { describe, it } from "node:test";
import { bindRunnerHttpServer, formatListenError } from "./http-bind.js";

describe("formatListenError", () => {
  it("formats EADDRINUSE without stack noise", () => {
    const msg = formatListenError(
      Object.assign(new Error("listen EADDRINUSE"), { code: "EADDRINUSE" }),
      9473,
    );
    assert.match(msg, /Port 9473 is already in use/);
    assert.match(msg, /PRGENIE_RUNNER_PORT/);
  });

  it("formats EACCES and EADDRNOTAVAIL", () => {
    assert.match(
      formatListenError(Object.assign(new Error("x"), { code: "EACCES" }), 80),
      /not permitted/,
    );
    assert.match(
      formatListenError(Object.assign(new Error("x"), { code: "EADDRNOTAVAIL" }), 1),
      /not available/,
    );
  });
});

describe("bindRunnerHttpServer", () => {
  it("resolves once listening and rejects when port is occupied", async () => {
    const host = "127.0.0.1";
    const s1 = http.createServer();
    try {
      await new Promise<void>((r) => s1.listen(0, host, () => r()));
      const port = (s1.address() as { port: number }).port;

      const s2 = http.createServer();
      try {
        await assert.rejects(
          () => bindRunnerHttpServer(s2, host, port),
          (err: Error) => {
            assert.match(err.message, /already in use/);
            return true;
          },
        );
      } finally {
        await new Promise<void>((r) => s2.close(() => r()));
      }
    } finally {
      await new Promise<void>((r) => s1.close(() => r()));
    }
  });
});
