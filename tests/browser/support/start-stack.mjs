/* global fetch, process, setTimeout */

import { spawn } from "node:child_process";
import { rm, readFile } from "node:fs/promises";

const rpcUrl = "http://127.0.0.1:18545";
const apiUrl = "http://127.0.0.1:13001";
const databasePath = "/tmp/quietpact-browser.sqlite";
const deployer = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";
const expectedRegistry = "0x5fbdb2315678afecb367f032d93f642f64180aa3";
const expectedAuction = "0xe7f1725e7734ce288f8367e1bb143e90bb3f0512";
const children = [];
let stopping = false;

await run("forge", ["build", "--root", "contracts"]);
await Promise.all(
  ["", "-shm", "-wal"].map(async (suffix) => rm(`${databasePath}${suffix}`, { force: true })),
);

const anvil = start("anvil", ["--silent", "--port", "18545", "--chain-id", "31337"]);
await waitFor(async () => {
  await rpc("eth_chainId");
});

const registry = await deploy("contracts/out/InvoiceRegistry.sol/InvoiceRegistry.json");
const auction = await deploy("contracts/out/SealedBidAuction.sol/SealedBidAuction.json");
if (registry !== expectedRegistry || auction !== expectedAuction) {
  throw new Error(`Unexpected browser-test deployments: registry=${registry}, auction=${auction}`);
}

const api = start("apps/api/node_modules/.bin/tsx", ["apps/api/src/server.ts"], {
  QUIETPACT_API_PORT: "13001",
  QUIETPACT_DATABASE_PATH: databasePath,
  QUIETPACT_RPC_URL: rpcUrl,
  QUIETPACT_CHAIN_ID: "31337",
  QUIETPACT_REGISTRY_ADDRESS: registry,
  QUIETPACT_REGISTRY_START_BLOCK: "0",
});
await waitFor(async () => {
  const response = await fetch(`${apiUrl}/health`);
  if (!response.ok) throw new Error(`API health returned ${response.status}`);
});

process.stdout.write(`QuietPact browser stack ready on ${rpcUrl} and ${apiUrl}\n`);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => void shutdown());
}

await new Promise((_, reject) => {
  anvil.once("exit", (code) => {
    if (!stopping) reject(new Error(`Anvil exited unexpectedly (${String(code)})`));
  });
  api.once("exit", (code) => {
    if (!stopping) reject(new Error(`QuietPact API exited unexpectedly (${String(code)})`));
  });
});

function start(command, args, extraEnv = {}) {
  const child = spawn(command, args, {
    cwd: process.cwd(),
    env: { ...process.env, ...extraEnv },
    stdio: "ignore",
  });
  children.push(child);
  return child;
}

async function run(command, args) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: process.cwd(), stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with code ${String(code)}`));
    });
  });
}

async function deploy(artifactPath) {
  const artifact = JSON.parse(await readFile(artifactPath, "utf8"));
  const hash = await rpc("eth_sendTransaction", [
    { from: deployer, data: artifact.bytecode.object },
  ]);
  const receipt = await waitFor(async () => {
    const result = await rpc("eth_getTransactionReceipt", [hash]);
    if (result === null) throw new Error("Deployment receipt is not ready");
    return result;
  });
  if (receipt.status !== "0x1" || typeof receipt.contractAddress !== "string") {
    throw new Error(`Contract deployment failed: ${hash}`);
  }
  return receipt.contractAddress.toLowerCase();
}

async function rpc(method, params = []) {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const payload = await response.json();
  if (payload.error !== undefined) {
    throw new Error(`${method}: ${payload.error.message ?? JSON.stringify(payload.error)}`);
  }
  return payload.result;
}

async function waitFor(operation) {
  let lastError;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw lastError ?? new Error("Timed out waiting for browser-test stack");
}

async function shutdown() {
  if (stopping) return;
  stopping = true;
  for (const child of children.reverse()) {
    if (child.exitCode !== null || child.pid === undefined) continue;
    child.kill("SIGTERM");
  }
  await Promise.all(
    ["", "-shm", "-wal"].map(async (suffix) => rm(`${databasePath}${suffix}`, { force: true })),
  );
  process.exit(0);
}
