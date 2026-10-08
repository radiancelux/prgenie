/**
 * RAD-185 phase-1 temporary diagnostic hook.
 * Captures raw stdin bytes, argv, and env KEY NAMES ONLY (never values).
 * Remove after delivery channel is documented.
 */
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

const LOOP_WORKTREE =
  "C:\\Users\\BrettHumphreys\\Documents\\GitHub\\pr-genie.loops\\lp-79761c42";
const DEFAULT_LOG = path.join(LOOP_WORKTREE, ".prgenie", "rad185-cursor-hook-stdin-capture.jsonl");

function logPath() {
  const override = process.env.PRGENIE_HOOK_STDIN_DIAG_LOG;
  if (override && override.trim()) return path.resolve(override.trim());
  return DEFAULT_LOG;
}

function bomLabel(buf) {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return "UTF-8 BOM";
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return "UTF-16 LE BOM";
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) return "UTF-16 BE BOM";
  if (buf.length >= 4 && buf[1] === 0 && buf[3] === 0 && buf[0] !== 0) {
    return "UTF-16 LE (no BOM, heuristic)";
  }
  return null;
}

function hexPreview(buf, max = 96) {
  const slice = buf.subarray(0, Math.min(buf.length, max));
  const hex = [...slice].map((b) => b.toString(16).padStart(2, "0")).join(" ");
  return buf.length > max ? `${hex} … (+${buf.length - max} bytes)` : hex;
}

function encodingAttempts(buf) {
  const out = {};
  try {
    out.utf8 = buf.toString("utf8");
  } catch (e) {
    out.utf8Error = String(e);
  }
  try {
    out.utf16le = buf.toString("utf16le");
  } catch (e) {
    out.utf16leError = String(e);
  }
  return out;
}

function readStdinSyncBuffer() {
  let buf;
  let readError = null;
  try {
    buf = readFileSync(0);
  } catch (e) {
    readError = e instanceof Error ? e.message : String(e);
    buf = Buffer.alloc(0);
  }
  return { buf, readError };
}

function stdinMeta() {
  return {
    isTTY: Boolean(process.stdin.isTTY),
    readable: process.stdin.readable,
    fd: typeof process.stdin.fd === "number" ? process.stdin.fd : null,
  };
}

function appendCapture(record) {
  const file = logPath();
  mkdirSync(path.dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify(record)}\n`, "utf8");
}

const hookEvent = process.argv[2] ?? "unknown";
const { buf, readError } = readStdinSyncBuffer();
const bom = bomLabel(buf);
const decoded = encodingAttempts(buf);

let jsonParseUtf8 = null;
let jsonParseError = null;
if (decoded.utf8 && buf.length > 0) {
  try {
    jsonParseUtf8 = JSON.parse(decoded.utf8);
  } catch (e) {
    jsonParseError = e instanceof Error ? e.message : String(e);
  }
}

const payloadKeys =
  jsonParseUtf8 && typeof jsonParseUtf8 === "object" && !Array.isArray(jsonParseUtf8)
    ? Object.keys(jsonParseUtf8).sort()
    : null;

appendCapture({
  ts: new Date().toISOString(),
  hookEvent,
  pid: process.pid,
  cwd: process.cwd(),
  argv: process.argv,
  envKeyNames: Object.keys(process.env).sort(),
  stdin: {
    byteCount: buf.length,
    readError,
    bom,
    hexPreview: hexPreview(buf),
    meta: stdinMeta(),
    utf8Length: decoded.utf8?.length ?? null,
    utf16leLength: decoded.utf16le?.length ?? null,
    jsonParseError,
    payloadKeyNames: payloadKeys,
  },
  readPattern: "readFileSync(0) buffer (same fd read as github-gate utf8 path)",
});

process.stdout.write(JSON.stringify({ permission: "allow" }));
