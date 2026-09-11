import { readFileSync } from "node:fs";
import path from "node:path";

function getPackageVersion(): string {
  let dir = __dirname;
  for (let i = 0; i < 5; i++) {
    try {
      const pkgPath = path.join(dir, "package.json");
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
      if (pkg.name === "@prgenie/cli") {
        return pkg.version;
      }
    } catch {
      // Continue searching parent directories
    }
    dir = path.dirname(dir);
  }
  return "unknown";
}

export const version: string = getPackageVersion();
