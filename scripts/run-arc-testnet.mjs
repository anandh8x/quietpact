/* global process */

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";

const deploymentEnvironment = "deployments/arc-testnet.env";
let content;
try {
  content = readFileSync(deploymentEnvironment, "utf8");
} catch {
  throw new Error("Arc deployment configuration is missing. Run pnpm arc:deploy first.");
}

const environment = { ...process.env };
for (const line of content.split("\n")) {
  const trimmed = line.trim();
  if (trimmed === "" || trimmed.startsWith("#")) continue;
  const separator = trimmed.indexOf("=");
  if (separator <= 0) throw new Error(`Invalid line in ${deploymentEnvironment}: ${trimmed}`);
  environment[trimmed.slice(0, separator)] = trimmed.slice(separator + 1);
}

const child = spawn("pnpm", ["dev"], {
  cwd: process.cwd(),
  env: environment,
  stdio: "inherit",
});
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => child.kill(signal));
}
child.once("error", (error) => {
  throw error;
});
child.once("exit", (code, signal) => {
  if (signal !== null) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});
