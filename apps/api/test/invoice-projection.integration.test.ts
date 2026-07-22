import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Writable } from "node:stream";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createViemInvoiceProjector,
  createViemInvoiceRecords,
  invoiceCreatedEvent,
  invoiceRegistryAbi,
  invoiceStateChangedEvent,
} from "@quietpact/chain-records";
import { address } from "@quietpact/domain";
import { canonicalize, createEnvelopeModule } from "@quietpact/envelope";
import {
  createEncryptedInvoiceModule,
  type InvoiceBlobStore,
  type InvoiceParticipant,
} from "@quietpact/invoice";
import { publicPaymentReference as confirmedPublicPaymentReference } from "@quietpact/payments";
import { createPublicClient, createWalletClient, http, keccak256, toHex, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";

import { createApp } from "../src/app.js";
import { openQuietPactDatabase, type QuietPactDatabase } from "../src/persistence.js";

const rpcUrl = "http://127.0.0.1:18546";
const payerAccount = privateKeyToAccount(
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
);
const payeeAccount = privateKeyToAccount(
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
);
const publicClient = createPublicClient({ chain: foundry, transport: http(rpcUrl) });
const walletFor = (account: typeof payerAccount) =>
  createWalletClient({ account, chain: foundry, transport: http(rpcUrl) });
const canary = "PHASE4_PLAINTEXT_CANARY_f813";
const invoiceId = `0x${"81".repeat(32)}` as const;

let anvil: ChildProcess;
let database: QuietPactDatabase;
let databasePath: string;
let temporaryDirectory: string;
let registry: `0x${string}`;
let registryBytecode: Hex;

beforeAll(async () => {
  anvil = spawn(process.env.ANVIL_BIN ?? "anvil", ["--silent", "--port", "18546"], {
    stdio: "ignore",
  });
  await waitForAnvil();
  const artifactUrl = new URL(
    "../../../contracts/out/InvoiceRegistry.sol/InvoiceRegistry.json",
    import.meta.url,
  );
  const artifact = JSON.parse(await readFile(artifactUrl, "utf8")) as {
    bytecode: { object: Hex };
  };
  registryBytecode = artifact.bytecode.object;
  registry = await deployRegistry();
  temporaryDirectory = await mkdtemp(join(tmpdir(), "quietpact-projection-"));
  databasePath = join(temporaryDirectory, "quietpact.sqlite");
  database = openQuietPactDatabase(databasePath);
}, 15_000);

afterAll(async () => {
  database.close();
  anvil.kill("SIGTERM");
  await rm(temporaryDirectory, { recursive: true, force: true });
});

describe("invoice event projection and leakage gate", () => {
  it("projects the complete encrypted invoice slice without leaking plaintext", async () => {
    const envelopes = await createEnvelopeModule();
    const payerAddress = address(payerAccount.address);
    const payeeAddress = address(payeeAccount.address);
    const payer: InvoiceParticipant = {
      address: payerAddress,
      encryption: envelopes.generateRecipientKeyPair(payerAddress),
    };
    const payee: InvoiceParticipant = {
      address: payeeAddress,
      encryption: envelopes.generateRecipientKeyPair(payeeAddress),
    };
    const wallets = new Map([
      [payerAddress, walletFor(payerAccount)],
      [payeeAddress, walletFor(payeeAccount)],
    ]);
    const records = createViemInvoiceRecords({
      registry: address(registry),
      publicClient,
      walletClientFor: (actor) => {
        const wallet = wallets.get(actor);
        if (wallet === undefined) throw new Error("No wallet for actor");
        return wallet;
      },
    });
    const blobs = databaseBlobStore(database);
    const moduleFor = (actor: InvoiceParticipant) =>
      createEncryptedInvoiceModule({
        actor,
        chainId: 31_337n,
        registry,
        envelopes,
        records,
        blobs,
      });
    const body = { amount: "910.00", currency: "USDC", memo: canary };

    await moduleFor(payee).create({ id: invoiceId, payer, payee, body });
    const approved = await moduleFor(payer).act<typeof body>(invoiceId, { type: "approve" });
    const publicPaymentReference = confirmedPublicPaymentReference(`0x${"ab".repeat(32)}`);
    const referenced = await moduleFor(payer).act<typeof body>(invoiceId, {
      type: "attachPublicPayment",
      reference: publicPaymentReference,
    });
    const projection = database.invoiceProjection(`31337:${address(registry)}`);
    const projector = createViemInvoiceProjector({
      registry: address(registry),
      publicClient,
      repository: projection,
    });
    const firstSync = await projector.sync();
    const secondSync = await projector.sync();
    const projected = await projection.view(invoiceId);
    let apiLogs = "";
    const logStream = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        apiLogs += chunk.toString("utf8");
        callback();
      },
    });
    const app = createApp({
      invoiceProjection: projection,
      invoiceEnvelopes: database.invoiceEnvelopes,
      authenticate: () => payeeAddress,
      logger: { stream: logStream },
    });
    const publicResponse = await app.inject({
      method: "GET",
      url: `/v1/invoice-records/${invoiceId}`,
    });
    const envelopeResponse = await app.inject({
      method: "PUT",
      url: `/v1/invoice-envelopes/${invoiceId}`,
      payload: { envelope: await database.invoiceEnvelopes.get(invoiceId) },
    });
    await app.close();

    const createdLogs = await publicClient.getLogs({
      address: registry,
      event: invoiceCreatedEvent,
      args: { invoiceId },
      fromBlock: 0n,
    });
    const stateLogs = await publicClient.getLogs({
      address: registry,
      event: invoiceStateChangedEvent,
      args: { invoiceId },
      fromBlock: 0n,
    });
    const transactionHashes = [...createdLogs, ...stateLogs].flatMap((log) =>
      log.transactionHash === null ? [] : [log.transactionHash],
    );
    const transactions = await Promise.all(
      transactionHashes.map(async (hash) => publicClient.getTransaction({ hash })),
    );
    const receipts = await Promise.all(
      transactionHashes.map(async (hash) => publicClient.getTransactionReceipt({ hash })),
    );
    const contractView = await publicClient.readContract({
      address: registry,
      abi: invoiceRegistryAbi,
      functionName: "getInvoice",
      args: [invoiceId],
    });
    const storedEnvelope = await database.invoiceEnvelopes.get(invoiceId);
    const inspection = new DatabaseSync(databasePath);
    const publicRows = inspection
      .prepare("SELECT * FROM invoice_projection WHERE id = ?")
      .all(invoiceId);
    inspection.close();
    const publicArtifacts = stringify([
      transactions.map((transaction) => transaction.input),
      receipts.map((receipt) => receipt.logs),
      contractView,
      projected,
      publicResponse.json(),
      publicRows,
      apiLogs,
    ]);

    expect(approved).toMatchObject({ public: { state: "APPROVED" }, body });
    expect(referenced).toMatchObject({
      public: { state: "PAYMENT_REFERENCED", publicPaymentReference },
      body,
    });
    expect(firstSync.events).toBe(4);
    expect(secondSync.events).toBe(0);
    expect(projected).toMatchObject({
      id: invoiceId,
      state: "PAYMENT_REFERENCED",
      publicPaymentReference,
    });
    expect(publicResponse.statusCode).toBe(200);
    expect(envelopeResponse.statusCode).toBe(201);
    expect(publicArtifacts).not.toContain(canary);
    expect(JSON.stringify(storedEnvelope)).not.toContain(canary);

    await resetAnvil();
    expect(await deployRegistry()).toBe(registry);
    const replacementId = `0x${"82".repeat(32)}` as const;
    await moduleFor(payee).create({
      id: replacementId,
      payer,
      payee,
      body: { amount: "25.00", currency: "USDC", memo: "replacement chain" },
    });
    const resetSync = await projector.sync();
    expect(resetSync.events).toBe(1);
    await expect(projection.view(invoiceId)).resolves.toBeNull();
    await expect(projection.view(replacementId)).resolves.toMatchObject({ state: "REGISTERED" });
  }, 20_000);
});

function databaseBlobStore(store: QuietPactDatabase): InvoiceBlobStore {
  return {
    async put(id, envelope) {
      const reference = await store.invoiceEnvelopes.put(id, envelope);
      return { reference, ciphertextHash: keccak256(toHex(canonicalize(envelope))) };
    },
    async get(reference) {
      const prefix = "invoice-envelope:";
      if (!reference.startsWith(prefix)) throw new Error("Invalid envelope reference");
      const envelope = await store.invoiceEnvelopes.get(reference.slice(prefix.length));
      if (envelope === null) throw new Error("Envelope not found");
      return envelope;
    },
  };
}

async function waitForAnvil(): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (anvil.exitCode !== null) throw new Error("Anvil exited before accepting connections");
    try {
      await publicClient.getChainId();
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error("Timed out waiting for Anvil");
}

async function deployRegistry(): Promise<`0x${string}`> {
  const deploymentHash = await walletFor(payerAccount).deployContract({
    abi: [],
    bytecode: registryBytecode,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: deploymentHash });
  if (receipt.contractAddress == null) throw new Error("InvoiceRegistry deployment failed");
  return receipt.contractAddress;
}

async function resetAnvil(): Promise<void> {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "anvil_reset", params: [] }),
  });
  if (!response.ok) throw new Error("Anvil reset failed");
  const result: unknown = await response.json();
  if (result === null || typeof result !== "object" || !("result" in result)) {
    throw new Error("Anvil reset returned an invalid response");
  }
}

function stringify(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    typeof item === "bigint" ? item.toString() : item,
  );
}
