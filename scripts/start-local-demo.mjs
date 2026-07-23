/* global fetch, setTimeout */

import { spawn } from "node:child_process";
import { readFile, rm, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";

const checkOnly = process.argv.includes("--check");
const projectRoot = resolve(import.meta.dirname, "..");
const rpcUrl = "http://127.0.0.1:18545";
const apiUrl = "http://127.0.0.1:13001";
const websiteUrl = "http://127.0.0.1:4173";
const deployer = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";
const expectedRegistry = "0x5fbdb2315678afecb367f032d93f642f64180aa3";
const expectedAuction = "0xe7f1725e7734ce288f8367e1bb143e90bb3f0512";
const temporaryDirectory = await mkdtemp(join(tmpdir(), "quietpact-demo-"));
const databasePath = join(temporaryDirectory, "quietpact-demo.sqlite");
const children = [];
let stopping = false;

try {
  await run("forge", ["build", "--root", "contracts"]);
  const anvilArguments = ["--port", "18545", "--chain-id", "31337"];
  if (checkOnly) anvilArguments.unshift("--silent");
  const anvil = start("anvil", anvilArguments);
  await waitFor(async () => rpc("eth_chainId"));

  const registry = await deploy("contracts/out/InvoiceRegistry.sol/InvoiceRegistry.json");
  const auction = await deploy("contracts/out/SealedBidAuction.sol/SealedBidAuction.json");
  if (registry !== expectedRegistry || auction !== expectedAuction) {
    throw new Error(`Unexpected local demo deployments: registry=${registry}, auction=${auction}`);
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
    const response = await fetch(`${apiUrl}/ready`);
    if (!response.ok) throw new Error(`API readiness returned ${String(response.status)}`);
  });

  const web = start(
    "pnpm",
    ["--filter", "@quietpact/web", "dev", "--host", "127.0.0.1", "--port", "4173"],
    {
      QUIETPACT_API_PROXY_TARGET: apiUrl,
      VITE_QUIETPACT_API_URL: "/api",
      VITE_QUIETPACT_AUCTION_ADDRESS: auction,
      VITE_QUIETPACT_CHAIN_ID: "31337",
      VITE_QUIETPACT_REGISTRY_ADDRESS: registry,
      VITE_QUIETPACT_RPC_URL: rpcUrl,
    },
  );
  await waitFor(async () => {
    const response = await fetch(websiteUrl);
    if (!response.ok) throw new Error(`Demo website returned ${String(response.status)}`);
  });

  process.stdout.write(
    [
      "",
      "QuietPact local demo is ready.",
      `Website: ${websiteUrl}`,
      `API readiness: ${apiUrl}/ready`,
      `Local RPC: ${rpcUrl}`,
      `InvoiceRegistry: ${registry}`,
      `SealedBidAuction: ${auction}`,
      "",
      "This stack uses disposable Anvil accounts and test ETH only.",
      "Never send real assets to an Anvil account or reuse its development keys.",
      checkOnly ? "Demo verification completed." : "Press Ctrl+C to stop and erase demo state.",
      "",
    ].join("\n"),
  );

  if (checkOnly) {
    await shutdown();
  } else {
    for (const signal of ["SIGINT", "SIGTERM"]) {
      process.once(signal, () => void shutdown().then(() => process.exit(0)));
    }
    await new Promise((_, reject) => {
      for (const [name, child] of [
        ["Anvil", anvil],
        ["QuietPact API", api],
        ["QuietPact web", web],
      ]) {
        child.once("exit", (code) => {
          if (!stopping) reject(new Error(`${name} exited unexpectedly (${String(code)})`));
        });
      }
    });
  }
} catch (error) {
  await shutdown();
  throw error;
}

function start(command, args, extraEnvironment = {}) {
  const child = spawn(command, args, {
    cwd: projectRoot,
    env: { ...process.env, ...extraEnvironment },
    stdio: checkOnly ? "ignore" : "inherit",
  });
  children.push(child);
  return child;
}

async function run(command, args) {
  await new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: projectRoot,
      stdio: checkOnly ? "ignore" : "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`${command} exited with code ${String(code)}`));
    });
  });
}

async function deploy(artifactPath) {
  const artifact = JSON.parse(await readFile(resolve(projectRoot, artifactPath), "utf8"));
  const transactionHash = await rpc("eth_sendTransaction", [
    { from: deployer, data: artifact.bytecode.object },
  ]);
  const receipt = await waitFor(async () => {
    const result = await rpc("eth_getTransactionReceipt", [transactionHash]);
    if (result === null) throw new Error("Deployment receipt is not ready");
    return result;
  });
  if (receipt.status !== "0x1" || typeof receipt.contractAddress !== "string") {
    throw new Error(`Local demo contract deployment failed: ${String(transactionHash)}`);
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
    throw new Error(`${method}: ${payload.error.message ?? "RPC request failed"}`);
  }
  return payload.result;
}

async function waitFor(operation) {
  let lastError;
  for (let attempt = 0; attempt < 150; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
    }
  }
  throw lastError ?? new Error("Timed out waiting for the local demo stack");
}

async function shutdown() {
  if (stopping) return;
  stopping = true;
  for (const child of children.reverse()) {
    if (child.exitCode !== null || child.pid === undefined) continue;
    child.kill("SIGTERM");
  }
  await Promise.all(
    children.map(
      (child) =>
        new Promise((resolvePromise) => {
          if (child.exitCode !== null) resolvePromise();
          else child.once("exit", resolvePromise);
        }),
    ),
  );
  await rm(temporaryDirectory, { recursive: true });
}
