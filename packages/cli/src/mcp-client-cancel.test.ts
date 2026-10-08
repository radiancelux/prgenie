import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { describe, it } from "node:test";
import { attachMcpInput, type McpToolHandler } from "./mcp.js";
import { encodeMcpFrame } from "./mcp-stdio.js";

function toolsCall(id: number, name: string): Buffer {
  return encodeMcpFrame({
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name, arguments: { id: "lp-test" } },
  });
}

function cancelled(requestId: number): Buffer {
  return encodeMcpFrame({
    jsonrpc: "2.0",
    method: "notifications/cancelled",
    params: { requestId },
  });
}

/**
 * Block inside the tool until `signal` aborts. Resolves only after abort so the
 * caller can observe `aborted === true` before this function returns.
 */
function holdUntilAbort(signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("in-flight signal was not aborted")), 1000);
    const finish = () => {
      clearTimeout(timer);
      if (!signal?.aborted) {
        reject(new Error("handler resumed before the signal aborted"));
        return;
      }
      resolve();
    };
    if (signal?.aborted) {
      finish();
      return;
    }
    if (!signal) {
      clearTimeout(timer);
      reject(new Error("tools/call did not receive a signal"));
      return;
    }
    signal.addEventListener("abort", finish, { once: true });
  });
}

describe("MCP client notifications/cancelled", { concurrency: 1 }, () => {
  it("aborts an in-flight export_local_pr signal before the handler returns", async () => {
    const input = new PassThrough();
    let signal: AbortSignal | undefined;
    let handlerReturned = false;
    let releaseEntered: () => void = () => undefined;
    const entered = new Promise<void>((resolve) => {
      releaseEntered = resolve;
    });

    const handleTool: McpToolHandler = async (_name, _args, options) => {
      signal = options?.signal;
      releaseEntered();
      await holdUntilAbort(signal);
      assert.equal(signal?.aborted, true);
      handlerReturned = true;
      return { cancelled: true };
    };
    attachMcpInput(input, { handleTool });

    input.write(toolsCall(41, "export_local_pr"));
    await entered;
    assert.equal(signal?.aborted, false);
    assert.equal(handlerReturned, false);

    input.write(cancelled(41));
    assert.equal(signal?.aborted, true);
    assert.equal(
      handlerReturned,
      false,
      "cancel must abort the live signal before the tool handler returns",
    );

    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(handlerReturned, true);
  });

  it("aborts in-flight run_ci when stdin errors before the handler returns", async () => {
    const input = new PassThrough();
    let signal: AbortSignal | undefined;
    let handlerReturned = false;
    let releaseEntered: () => void = () => undefined;
    const entered = new Promise<void>((resolve) => {
      releaseEntered = resolve;
    });

    const handleTool: McpToolHandler = async (_name, _args, options) => {
      signal = options?.signal;
      releaseEntered();
      await holdUntilAbort(signal);
      handlerReturned = true;
      return { cancelled: true };
    };
    attachMcpInput(input, { handleTool });

    input.write(toolsCall(42, "run_ci"));
    await entered;
    assert.equal(handlerReturned, false);

    input.emit("error", new Error("stdin closed"));
    assert.equal(signal?.aborted, true);
    assert.equal(handlerReturned, false);

    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(handlerReturned, true);
  });

  it("does not recurse on a partial stdin frame", () => {
    const input = new PassThrough();
    attachMcpInput(input, {
      handleTool: async () => {
        throw new Error("partial frame must not dispatch a tool");
      },
    });
    input.write(Buffer.from('{"jsonrpc":"2.0","method":"ping"'));
  });
});
