import { createClient } from "@libsql/client";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";

import { address } from "@quietpact/domain";
import { createEnvelopeModule } from "@quietpact/envelope";

import { createTursoQuietPactDatabase } from "../src/turso-persistence.js";
import { createWalletAuth } from "../src/wallet-auth.js";

const account = privateKeyToAccount(
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
);
const actor = address(account.address);
const payer = address("0x2000000000000000000000000000000000000002");
const invoiceId = `0x${"71".repeat(32)}` as const;
const databases: Array<Awaited<ReturnType<typeof createTursoQuietPactDatabase>>> = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const database of databases.splice(0)) database.close();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map(async (directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("Turso persistence", () => {
  it("migrates a fresh database and stores encrypted invoice data", async () => {
    const database = await openDatabase();
    const envelopes = await createEnvelopeModule();
    const payeeIdentity = envelopes.generateRecipientKeyPair(actor);
    const payerIdentity = envelopes.generateRecipientKeyPair(payer);
    const envelope = envelopes.seal(
      {
        chainId: 5_042_002n,
        registry: "0x1111111111111111111111111111111111111111",
        workflowId: invoiceId,
        payer,
        payee: actor,
      },
      { amount: "450.00", memo: "TURSO_PRIVATE_CANARY_17" },
      [payerIdentity, payeeIdentity],
    );

    await expect(database.checkHealth()).resolves.toBeUndefined();
    await database.invoiceEnvelopes.put(invoiceId, envelope);
    await database.encryptionKeys.put({ id: actor, publicKey: payeeIdentity.publicKey });

    await expect(database.invoiceEnvelopes.get(invoiceId)).resolves.toEqual(envelope);
    await expect(database.encryptionKeys.get(actor)).resolves.toEqual({
      id: actor,
      publicKey: payeeIdentity.publicKey,
    });
    await expect(
      database.invoiceEnvelopes.put(invoiceId, {
        ...envelope,
        ciphertext: `${envelope.ciphertext}A`,
      }),
    ).rejects.toThrow("already stored");
    expect(JSON.stringify(await database.invoiceEnvelopes.get(invoiceId))).not.toContain(
      "TURSO_PRIVATE_CANARY_17",
    );
  });

  it("atomically consumes challenges and persists hashed wallet sessions", async () => {
    const database = await openDatabase();
    const auth = createWalletAuth(database.walletAuth);
    const challenge = await auth.issueChallenge(actor);
    const signature = await account.signMessage({ message: challenge.message });
    const session = await auth.createSession({
      actor,
      nonce: challenge.nonce,
      signature,
    });

    await expect(auth.authenticate(`Bearer ${session.token}`)).resolves.toBe(actor);
    await expect(
      auth.createSession({ actor, nonce: challenge.nonce, signature }),
    ).rejects.toMatchObject({ code: "CHALLENGE_NOT_FOUND" });
  });

  it("applies projected invoice events and cursors atomically", async () => {
    const database = await openDatabase();
    const projection = database.invoiceProjection("arc-testnet:registry");
    const createdTransactionHash = `0x${"21".repeat(32)}` as const;
    const approvedTransactionHash = `0x${"22".repeat(32)}` as const;
    const throughBlockHash = `0x${"23".repeat(32)}` as const;
    const invoice = {
      id: invoiceId,
      payer,
      payee: actor,
      commitment: `0x${"31".repeat(32)}` as const,
      ciphertextHash: `0x${"32".repeat(32)}` as const,
      state: "REGISTERED" as const,
      publicPaymentReference: null,
      createdTransactionHash,
      latestTransactionHash: createdTransactionHash,
      latestBlock: 10n,
    };

    await projection.apply({
      events: [
        { type: "created", invoice, logIndex: 0 },
        {
          type: "stateChanged",
          id: invoiceId,
          state: "APPROVED",
          transactionHash: approvedTransactionHash,
          blockNumber: 11n,
          logIndex: 0,
        },
      ],
      throughBlock: 11n,
      throughBlockHash,
      reset: false,
    });

    await expect(projection.cursor()).resolves.toEqual({
      blockNumber: 11n,
      blockHash: throughBlockHash,
    });
    await expect(projection.view(invoiceId)).resolves.toMatchObject({
      id: invoiceId,
      state: "APPROVED",
      latestTransactionHash: approvedTransactionHash,
      latestBlock: 11n,
    });

    await projection.apply({
      events: [{ type: "created", invoice, logIndex: 0 }],
      throughBlock: 10n,
      throughBlockHash: `0x${"24".repeat(32)}`,
      reset: false,
    });
    await expect(projection.cursor()).resolves.toEqual({
      blockNumber: 11n,
      blockHash: throughBlockHash,
    });
    await expect(projection.view(invoiceId)).resolves.toMatchObject({
      state: "APPROVED",
      latestTransactionHash: approvedTransactionHash,
    });
  });
});

async function openDatabase() {
  const directory = await mkdtemp(join(tmpdir(), "quietpact-turso-"));
  temporaryDirectories.push(directory);
  const database = await createTursoQuietPactDatabase(
    createClient({ url: `file:${join(directory, "quietpact.db")}` }),
  );
  databases.push(database);
  return database;
}
