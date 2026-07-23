/* global fetch, process, setTimeout */

import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";

import { createArcSmokeSchedule } from "./arc-smoke-schedule.mjs";

const manifestPath = "deployments/arc-testnet.json";
const evidencePath = "deployments/arc-testnet-smoke.json";
const checkpointPath = ".quietpact-data/arc-testnet-smoke-checkpoint.json";
const accountName = process.env.QUIETPACT_FOUNDRY_ACCOUNT ?? "quietpact-arc-testnet";
const passwordFile = process.env.QUIETPACT_PASSWORD_FILE;
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const rpcUrl = manifest.rpcUrl;
const registry = manifest.contracts.InvoiceRegistry.address;
const auction = manifest.contracts.SealedBidAuction.address;
const deployer = manifest.deployer;
const payee = "0x000000000000000000000000000000000000beef";

if (!passwordFile) throw new Error("QUIETPACT_PASSWORD_FILE is required");
if (manifest.chainId !== 5_042_002) throw new Error("Deployment manifest is not Arc Testnet");
if (Number.parseInt(await rpc("eth_chainId"), 16) !== manifest.chainId) {
  throw new Error("Arc RPC chain ID does not match the deployment manifest");
}
if ((await rpc("eth_getCode", [registry, "latest"])) === "0x") {
  throw new Error("InvoiceRegistry has no runtime bytecode");
}
if ((await rpc("eth_getCode", [auction, "latest"])) === "0x") {
  throw new Error("SealedBidAuction has no runtime bytecode");
}

const checkpoint = loadCheckpoint();
if (checkpoint.invoice === undefined) {
  const invoiceId = randomHex32();
  const commitment = randomHex32();
  const ciphertextHash = randomHex32();
  const auditorKeyId = `0x${"00".repeat(32)}`;
  const invoiceCreate = send(
    registry,
    "createInvoice(bytes32,address,address,bytes32,bytes32,bytes32)",
    [invoiceId, deployer, payee, commitment, ciphertextHash, auditorKeyId],
  );
  const invoiceApprove = send(registry, "approveInvoice(bytes32)", [invoiceId]);
  const publicPayment = send(payee, null, [], "0.001ether");
  const invoiceReference = send(registry, "attachPublicPayment(bytes32,bytes32)", [
    invoiceId,
    publicPayment.transactionHash,
  ]);
  checkpoint.invoice = {
    id: invoiceId,
    createTransaction: invoiceCreate.transactionHash,
    approveTransaction: invoiceApprove.transactionHash,
    publicPaymentTransaction: publicPayment.transactionHash,
    referenceTransaction: invoiceReference.transactionHash,
  };
  saveCheckpoint(checkpoint);
}
const invoiceId = checkpoint.invoice.id;
const invoiceView = call(
  registry,
  "getInvoice(bytes32)(address,address,bytes32,bytes32,bytes32,bytes32,uint64,uint8)",
  [invoiceId],
);

if (checkpoint.auction === undefined) {
  const latestBlock = await rpcObject("eth_getBlockByNumber", ["latest", false]);
  const now = Number.parseInt(latestBlock.timestamp, 16);
  const schedule = createArcSmokeSchedule(now);
  const auctionId = randomHex32();
  const bidAmount = "75";
  const salt = randomHex32();
  const bondWei = "10000000000000000";
  const encodedOpening = run("cast", [
    "abi-encode",
    "f(uint256,address,bytes32,address,uint256,bytes32)",
    String(manifest.chainId),
    auction,
    auctionId,
    deployer,
    bidAmount,
    salt,
  ]);
  const bidCommitment = run("cast", ["keccak", encodedOpening]);
  const auctionCreate = send(auction, "createAuction(bytes32,uint64,uint64,uint64,uint256)", [
    auctionId,
    String(schedule.commitOpensAt),
    String(schedule.revealOpensAt),
    String(schedule.revealClosesAt),
    bondWei,
  ]);
  checkpoint.auction = {
    id: auctionId,
    bidAmount,
    salt,
    bidCommitment,
    ...schedule,
    createTransaction: auctionCreate.transactionHash,
  };
  saveCheckpoint(checkpoint);
}
const auctionCheckpoint = checkpoint.auction;
await waitForTimestamp(auctionCheckpoint.commitOpensAt);
if (auctionCheckpoint.commitTransaction === undefined) {
  const bidCommit = send(
    auction,
    "commitBid(bytes32,bytes32)",
    [auctionCheckpoint.id, auctionCheckpoint.bidCommitment],
    "0.01ether",
  );
  auctionCheckpoint.commitTransaction = bidCommit.transactionHash;
  saveCheckpoint(checkpoint);
}
await waitForTimestamp(auctionCheckpoint.revealOpensAt);
if (auctionCheckpoint.revealTransaction === undefined) {
  const bidReveal = send(auction, "revealBid(bytes32,uint256,bytes32)", [
    auctionCheckpoint.id,
    auctionCheckpoint.bidAmount,
    auctionCheckpoint.salt,
  ]);
  auctionCheckpoint.revealTransaction = bidReveal.transactionHash;
  saveCheckpoint(checkpoint);
}
await waitForTimestamp(auctionCheckpoint.revealClosesAt);
if (auctionCheckpoint.finalizeTransaction === undefined) {
  const auctionFinalize = send(auction, "finalizeAuction(bytes32)", [auctionCheckpoint.id]);
  auctionCheckpoint.finalizeTransaction = auctionFinalize.transactionHash;
  saveCheckpoint(checkpoint);
}
const auctionId = auctionCheckpoint.id;
const auctionView = call(
  auction,
  "getAuction(bytes32)(address,uint64,uint64,uint64,uint256,uint32,address,uint256,bool)",
  [auctionId],
);
const bidView = call(auction, "getBid(bytes32,address)(bytes32,uint256,bool)", [
  auctionId,
  deployer,
]);
const creditBeforeWithdrawal = call(auction, "creditOf(address)(uint256)", [deployer]);
if (auctionCheckpoint.withdrawalTransaction === undefined) {
  const creditWithdrawal = send(auction, "withdrawCredit()", []);
  auctionCheckpoint.withdrawalTransaction = creditWithdrawal.transactionHash;
  saveCheckpoint(checkpoint);
}
const creditAfterWithdrawal = call(auction, "creditOf(address)(uint256)", [deployer]);

const evidence = {
  schemaVersion: 1,
  network: manifest.network,
  chainId: manifest.chainId,
  checkedAt: new Date().toISOString(),
  deployer,
  contracts: { InvoiceRegistry: registry, SealedBidAuction: auction },
  invoice: {
    ...checkpoint.invoice,
    finalView: invoiceView,
    plaintextCanaryUsed: false,
    classification: "PUBLIC_ONCHAIN",
  },
  auction: {
    id: auctionId,
    createTransaction: auctionCheckpoint.createTransaction,
    commitTransaction: auctionCheckpoint.commitTransaction,
    revealTransaction: auctionCheckpoint.revealTransaction,
    finalizeTransaction: auctionCheckpoint.finalizeTransaction,
    withdrawalTransaction: auctionCheckpoint.withdrawalTransaction,
    finalView: auctionView,
    finalBidView: bidView,
    creditBeforeWithdrawal,
    creditAfterWithdrawal,
    bidVisibility: "PUBLIC_AFTER_REVEAL",
  },
};
writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o644 });
unlinkSync(checkpointPath);
process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);

function loadCheckpoint() {
  if (!existsSync(checkpointPath)) return {};
  return JSON.parse(readFileSync(checkpointPath, "utf8"));
}

function saveCheckpoint(value) {
  mkdirSync(".quietpact-data", { recursive: true });
  writeFileSync(checkpointPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function send(target, signature, args, value) {
  const commandArgs = ["send", target];
  if (signature !== null) commandArgs.push(signature, ...args);
  if (value !== undefined) commandArgs.push("--value", value);
  commandArgs.push(
    "--account",
    accountName,
    "--password-file",
    passwordFile,
    "--rpc-url",
    rpcUrl,
    "--confirmations",
    "1",
    "--json",
  );
  const receipt = JSON.parse(run("cast", commandArgs));
  if (receipt.status !== "0x1") {
    throw new Error(`Transaction reverted: ${receipt.transactionHash ?? "unknown hash"}`);
  }
  if (typeof receipt.transactionHash !== "string") {
    throw new Error("Transaction receipt did not include a hash");
  }
  return receipt;
}

function call(target, signature, args) {
  return run("cast", ["call", target, signature, ...args, "--rpc-url", rpcUrl]);
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} exited with status ${String(result.status)}`);
  }
  return result.stdout.trim();
}

async function waitForTimestamp(target) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const block = await rpcObject("eth_getBlockByNumber", ["latest", false]);
    if (Number.parseInt(block.timestamp, 16) >= target) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for Arc timestamp ${target}`);
}

function randomHex32() {
  return `0x${randomBytes(32).toString("hex")}`;
}

async function rpc(method, params = []) {
  const result = await rpcRequest(method, params);
  if (typeof result !== "string") throw new Error(`${method} returned an invalid result`);
  return result;
}

async function rpcObject(method, params = []) {
  const result = await rpcRequest(method, params);
  if (result === null || typeof result !== "object") {
    throw new Error(`${method} returned an invalid result`);
  }
  return result;
}

async function rpcRequest(method, params) {
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
  return payload.result;
}
