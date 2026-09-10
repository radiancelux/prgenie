import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deflateRawSync } from "node:zlib";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const extDir = path.join(root, "packages", "extension");
const distJs = path.join(extDir, "dist", "extension.js");
const pkgPath = path.join(extDir, "package.json");

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return ~c >>> 0;
}

function zipStore(files) {
  /** @type {Buffer[]} */
  const locals = [];
  /** @type {Buffer[]} */
  const centrals = [];
  let offset = 0;
  for (const { name, data } of files) {
    const nameBuf = Buffer.from(name, "utf8");
    const compressed = deflateRawSync(data);
    const useStore = compressed.length >= data.length;
    const payload = useStore ? data : compressed;
    const method = useStore ? 0 : 8;
    const crc = crc32(data);
    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    nameBuf.copy(local, 30);
    const central = Buffer.alloc(46 + nameBuf.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    nameBuf.copy(central, 46);
    locals.push(local, payload);
    centrals.push(central);
    offset += local.length + payload.length;
  }
  const centralDir = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralDir.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, centralDir, end]);
}

function escapeXml(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function main() {
  if (!existsSync(distJs)) {
    console.error(`Missing ${distJs}. Run pnpm build first.`);
    process.exit(1);
  }
  const pkg = JSON.parse(await readFile(pkgPath, "utf8"));
  const version = pkg.version;
  if (typeof version !== "string" || !version) {
    console.error("packages/extension/package.json has no version.");
    process.exit(1);
  }

  // Drop stale VSIX artifacts so doctor does not flag leftover skew.
  for (const name of await readdir(extDir)) {
    if (/^prgenie-.+\.vsix$/i.test(name)) {
      await unlink(path.join(extDir, name));
      console.log(`Removed stale ${name}`);
    }
  }

  const displayName = pkg.displayName ?? pkg.name ?? "PR Genie";
  const description = pkg.description ?? "";
  const publisher = pkg.publisher ?? "prgenie";
  const id = pkg.name ?? "prgenie";

  const manifest = `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
  <Metadata>
    <Identity Language="en-US" Id="${escapeXml(id)}" Version="${escapeXml(version)}" Publisher="${escapeXml(publisher)}" />
    <DisplayName>${escapeXml(displayName)}</DisplayName>
    <Description xml:space="preserve">${escapeXml(description)}</Description>
  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code" />
  </Installation>
  <Dependencies />
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />
  </Assets>
</PackageManifest>
`;

  const contentTypes = `<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension=".json" ContentType="application/json" />
  <Default Extension=".vsixmanifest" ContentType="text/xml" />
  <Default Extension=".js" ContentType="application/javascript" />
  <Default Extension=".svg" ContentType="image/svg+xml" />
</Types>
`;

  /** @type {{ name: string, data: Buffer }[]} */
  const files = [
    { name: "extension.vsixmanifest", data: Buffer.from(manifest, "utf8") },
    { name: "[Content_Types].xml", data: Buffer.from(contentTypes, "utf8") },
    { name: "extension/package.json", data: await readFile(pkgPath) },
    { name: "extension/dist/extension.js", data: await readFile(distJs) },
  ];

  const icon = path.join(extDir, "media", "icon.svg");
  if (existsSync(icon)) {
    files.push({ name: "extension/media/icon.svg", data: await readFile(icon) });
  }

  const outName = `prgenie-${version}.vsix`;
  const outPath = path.join(extDir, outName);
  await mkdir(extDir, { recursive: true });
  const zip = zipStore(files);
  await writeFile(outPath, zip);
  const sha = createHash("sha256").update(zip).digest("hex").slice(0, 12);
  console.log(`Packed ${outPath} (${zip.length} bytes, sha256 ${sha})`);
  console.log("VSIX is gitignored — keep it local or attach to a GitHub Release.");
}

await main();
