import { readFileSync } from "node:fs";

const raw = readFileSync(0, "utf8");
let input = {};
try {
  input = raw ? JSON.parse(raw) : {};
} catch {
  input = {};
}

const command = String(input.command ?? "");
const blocked =
  /\bgit(\.exe)?\s+push\b/i.test(command) ||
  /\bgh(\.exe)?\s+pr\s+create\b/i.test(command) ||
  /\bgh(\.exe)?\s+pr\s+merge\b/i.test(command);

if (blocked) {
  process.stdout.write(
    JSON.stringify({
      permission: "ask",
      user_message:
        "PR Genie: this would publish to GitHub. Create or update a local PR instead (prgenie create / MCP create_local_pr), then export when you are ready.",
      agent_message:
        "Do not git push or gh pr create. Open a local PR with PR Genie, then wait for the user to export.",
    }),
  );
} else {
  process.stdout.write(JSON.stringify({ permission: "allow" }));
}
