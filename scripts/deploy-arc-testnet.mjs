/* global fetch, process, setTimeout */

import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";

const chainId = 5_042_002;
const rpcUrl = process.env.QUIETPACT_ARC_RPC_URL ?? "https://rpc.testnet.arc.network";
const explorer = "https://testnet.arcscan.app";
const signingMode = process.env.QUIETPACT_DEPLOYER_MODE ?? "browser";
const account = process.env.QUIETPACT_FOUNDRY_ACCOUNT;

if (signingMode !== "browser" && signingMode !== "account") {
  throw new Error("QUIETPACT_DEPLOYER_MODE must be browser or account");
}
if (signingMode === "account" && !account) {
  throw new Error("QUIETPACT_FOUNDRY_ACCOUNT is required when using account signing");
}

const actualChainId = Number.parseInt(await rpc("eth_chainId"), 16);
if (actualChainId !== chainId) {
  throw new Error(
    `Refusing deployment: expected Arc Testnet ${chainId}, received ${actualChainId}`,
  );
}

run("forge", ["build", "--root", "contracts"]);
const invoice = deploy("src/InvoiceRegistry.sol:InvoiceRegistry");
const auction = deploy("src/SealedBidAuction.sol:SealedBidAuction");
if (invoice.deployer.toLowerCase() !== auction.deployer.toLowerCase()) {
  throw new Error("Deployment outputs used different deployer addresses");
}

for (const deployment of [invoice, auction]) {
  const receipt = await waitForReceipt(deployment.transactionHash);
  if (
    receipt.status !== "0x1" ||
    receipt.contractAddress?.toLowerCase() !== deployment.address.toLowerCase()
  ) {
    throw new Error(`Deployment receipt did not confirm ${deployment.address}`);
  }
  deployment.blockNumber = Number.parseInt(receipt.blockNumber, 16);
  const code = await rpc("eth_getCode", [deployment.address, "latest"]);
  if (code === "0x") throw new Error(`No deployed code found at ${deployment.address}`);
}

const startBlock = Math.min(invoice.blockNumber, auction.blockNumber);
const manifest = {
  schemaVersion: 1,
  network: "Arc Testnet",
  chainId,
  rpcUrl,
  explorer,
  nativeGasToken: { name: "USDC", symbol: "USDC", decimals: 18 },
  privacyCapability: "UNAVAILABLE_ROADMAP",
  compiler: {
    version: "0.8.30",
    optimizer: true,
    optimizerRuns: 200,
  },
  deployedAt: new Date().toISOString(),
  deployer: invoice.deployer,
  contracts: {
    InvoiceRegistry: {
      address: invoice.address,
      transactionHash: invoice.transactionHash,
      blockNumber: invoice.blockNumber,
    },
    SealedBidAuction: {
      address: auction.address,
      transactionHash: auction.transactionHash,
      blockNumber: auction.blockNumber,
    },
  },
};
mkdirSync("deployments", { recursive: true });
writeFileSync("deployments/arc-testnet.json", `${JSON.stringify(manifest, null, 2)}\n`, {
  mode: 0o644,
});
writeFileSync(
  "deployments/arc-testnet.env",
  [
    `QUIETPACT_CHAIN_ID=${chainId}`,
    `QUIETPACT_RPC_URL=${rpcUrl}`,
    `QUIETPACT_REGISTRY_ADDRESS=${invoice.address}`,
    `QUIETPACT_REGISTRY_START_BLOCK=${startBlock}`,
    "VITE_QUIETPACT_API_URL=/api",
    `VITE_QUIETPACT_AUCTION_ADDRESS=${auction.address}`,
    `VITE_QUIETPACT_CHAIN_ID=${chainId}`,
    `VITE_QUIETPACT_RPC_URL=${rpcUrl}`,
    `VITE_QUIETPACT_REGISTRY_ADDRESS=${invoice.address}`,
    "",
  ].join("\n"),
  { mode: 0o644 },
);
process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);

function deploy(contract) {
  const signingArgs =
    signingMode === "browser" ? ["--browser"] : ["--account", /** @type {string} */ (account)];
  const result = run("forge", [
    "create",
    "--root",
    "contracts",
    "--broadcast",
    "--rpc-url",
    rpcUrl,
    "--json",
    ...signingArgs,
    contract,
  ]);
  const parsed = JSON.parse(result);
  const deployer = requireAddress(parsed.deployer, "deployer");
  const address = requireAddress(parsed.deployedTo ?? parsed.deployed_to, "deployed contract");
  const transactionHash = requireHash(
    parsed.transactionHash ?? parsed.transaction_hash,
    "deployment transaction",
  );
  return { deployer, address, transactionHash };
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: ["inherit", "pipe", "inherit"],
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} exited with status ${String(result.status)}`);
  }
  return result.stdout.trim();
}

function requireAddress(value, label) {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw new Error(`Forge returned an invalid ${label} address`);
  }
  return value;
}

function requireHash(value, label) {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(`Forge returned an invalid ${label} hash`);
  }
  return value;
}

async function rpc(method, params = []) {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: method, method, params }),
  });
  if (!response.ok) throw new Error(`${method} failed with HTTP ${response.status}`);
  const payload = await response.json();
  if (payload.error !== undefined) {
    throw new Error(`${method} failed: ${payload.error.message ?? JSON.stringify(payload.error)}`);
  }
  if (typeof payload.result !== "string") throw new Error(`${method} returned an invalid result`);
  return payload.result;
}

async function waitForReceipt(transactionHash) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const receipt = await rpcObject("eth_getTransactionReceipt", [transactionHash]);
    if (receipt !== null) return receipt;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for deployment ${transactionHash}`);
}

async function rpcObject(method, params = []) {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: method, method, params }),
  });
  if (!response.ok) throw new Error(`${method} failed with HTTP ${response.status}`);
  const payload = await response.json();
  if (payload.error !== undefined) {
    throw new Error(`${method} failed: ${payload.error.message ?? JSON.stringify(payload.error)}`);
  }
  if (payload.result !== null && typeof payload.result !== "object") {
    throw new Error(`${method} returned an invalid result`);
  }
  return payload.result;
}
