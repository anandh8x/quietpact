import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { format } from "prettier";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputPath = resolve(projectRoot, "security/sbom.cdx.json");
const result = spawnSync(
  "pnpm",
  [
    "sbom",
    "--prod",
    "--lockfile-only",
    "--sbom-format",
    "cyclonedx",
    "--sbom-spec-version",
    "1.6",
    "--sbom-type",
    "application",
    "--sbom-supplier",
    "QuietPact",
    "--sbom-authors",
    "QuietPact",
  ],
  {
    cwd: projectRoot,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  },
);

if (result.status !== 0) {
  process.stderr.write(result.stderr);
  throw new Error(`pnpm sbom exited with status ${String(result.status)}`);
}

const sbom = JSON.parse(result.stdout);
delete sbom.serialNumber;
if (sbom.metadata !== null && typeof sbom.metadata === "object") {
  delete sbom.metadata.timestamp;
  sbom.metadata.properties = [
    {
      name: "quietpact:source",
      value: "pnpm-lock.yaml",
    },
    {
      name: "quietpact:scope",
      value: "production dependencies",
    },
  ];
}

mkdirSync(dirname(outputPath), { recursive: true });
const formatted = await format(JSON.stringify(sbom), {
  parser: "json",
  printWidth: 100,
  trailingComma: "all",
});
writeFileSync(outputPath, formatted, {
  encoding: "utf8",
  mode: 0o644,
});
process.stdout.write(`Wrote ${outputPath}\n`);
