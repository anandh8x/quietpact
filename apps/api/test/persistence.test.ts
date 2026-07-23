import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { address } from "@quietpact/domain";
import { createEnvelopeModule } from "@quietpact/envelope";
import { privateKeyToAccount } from "viem/accounts";

import { openQuietPactDatabase, QUIETPACT_DATABASE_SCHEMA_VERSION } from "../src/persistence.js";
import { createWalletAuth } from "../src/wallet-auth.js";

const account = privateKeyToAccount(
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
);
const actor = address(account.address);
const payer = address("0x2000000000000000000000000000000000000002");
const invoiceId = `0x${"71".repeat(32)}` as const;
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map(async (directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("SQLite persistence", () => {
  it("records the current schema version and passes a live health check", async () => {
    const databasePath = await temporaryDatabasePath();
    const database = openQuietPactDatabase(databasePath);

    expect(database.schemaVersion).toBe(QUIETPACT_DATABASE_SCHEMA_VERSION);
    await expect(database.checkHealth()).resolves.toBeUndefined();
    database.close();

    const inspection = new DatabaseSync(databasePath);
    const version = inspection.prepare("PRAGMA user_version").get();
    inspection.close();
    expect(Reflect.get(version ?? {}, "user_version")).toBe(QUIETPACT_DATABASE_SCHEMA_VERSION);
  });

  it("migrates legacy projection tables without dropping their data", async () => {
    const databasePath = await temporaryDatabasePath();
    const legacy = new DatabaseSync(databasePath);
    legacy.exec(`
      CREATE TABLE projector_cursors (
        scope TEXT PRIMARY KEY,
        through_block TEXT NOT NULL
      );
      INSERT INTO projector_cursors (scope, through_block) VALUES ('legacy-scope', '42');
      CREATE TABLE invoice_projection (
        scope TEXT NOT NULL,
        id TEXT NOT NULL,
        payer TEXT NOT NULL,
        payee TEXT NOT NULL,
        commitment TEXT NOT NULL,
        ciphertext_hash TEXT NOT NULL,
        state TEXT NOT NULL,
        created_transaction_hash TEXT NOT NULL,
        latest_transaction_hash TEXT NOT NULL,
        latest_block TEXT NOT NULL,
        PRIMARY KEY (scope, id)
      );
    `);
    legacy.close();

    openQuietPactDatabase(databasePath).close();

    const inspection = new DatabaseSync(databasePath);
    const cursor = inspection
      .prepare("SELECT through_block, through_hash FROM projector_cursors WHERE scope = ?")
      .get("legacy-scope");
    const projectionColumns = inspection.prepare("PRAGMA table_info(invoice_projection)").all();
    const version = inspection.prepare("PRAGMA user_version").get();
    inspection.close();
    expect(cursor).toMatchObject({
      through_block: "42",
      through_hash: `0x${"00".repeat(32)}`,
    });
    expect(projectionColumns.map((column) => Reflect.get(column, "name"))).toContain(
      "public_payment_reference",
    );
    expect(Reflect.get(version ?? {}, "user_version")).toBe(QUIETPACT_DATABASE_SCHEMA_VERSION);
  });

  it("refuses a database created by newer application code", async () => {
    const databasePath = await temporaryDatabasePath();
    const future = new DatabaseSync(databasePath);
    future.exec(`PRAGMA user_version = ${String(QUIETPACT_DATABASE_SCHEMA_VERSION + 1)}`);
    future.close();

    expect(() => openQuietPactDatabase(databasePath)).toThrow("newer than supported schema");
  });

  it("keeps encrypted envelopes and public keys across database restarts", async () => {
    const databasePath = await temporaryDatabasePath();
    const envelopes = await createEnvelopeModule();
    const payeeIdentity = envelopes.generateRecipientKeyPair(actor);
    const payerIdentity = envelopes.generateRecipientKeyPair(payer);
    const envelope = envelopes.seal(
      {
        chainId: 31_337n,
        registry: "0x1111111111111111111111111111111111111111",
        workflowId: invoiceId,
        payer,
        payee: actor,
      },
      { amount: "450.00", memo: "SQLITE_PRIVATE_CANARY_17" },
      [payerIdentity, payeeIdentity],
    );
    const first = openQuietPactDatabase(databasePath);
    await first.invoiceEnvelopes.put(invoiceId, envelope);
    await first.encryptionKeys.put({ id: actor, publicKey: payeeIdentity.publicKey });
    first.close();

    const reopened = openQuietPactDatabase(databasePath);
    await expect(
      reopened.invoiceEnvelopes.put(invoiceId, {
        ...envelope,
        ciphertext: `${envelope.ciphertext}A`,
      }),
    ).rejects.toThrow("already stored");
    const storedEnvelope = await reopened.invoiceEnvelopes.get(invoiceId);
    const storedKey = await reopened.encryptionKeys.get(actor);
    reopened.close();

    expect(storedEnvelope).toEqual(envelope);
    expect(storedKey).toEqual({ id: actor, publicKey: payeeIdentity.publicKey });
    expect(JSON.stringify(storedEnvelope)).not.toContain("SQLITE_PRIVATE_CANARY_17");
  });

  it("survives restarts with one-time challenges and hashed session tokens", async () => {
    const databasePath = await temporaryDatabasePath();
    const first = openQuietPactDatabase(databasePath);
    const challenge = await createWalletAuth(first.walletAuth).issueChallenge(actor);
    first.close();

    const signature = await account.signMessage({ message: challenge.message });
    const second = openQuietPactDatabase(databasePath);
    const session = await createWalletAuth(second.walletAuth).createSession({
      actor,
      nonce: challenge.nonce,
      signature,
    });
    second.close();

    const inspection = new DatabaseSync(databasePath);
    const row = inspection.prepare("SELECT token_hash FROM auth_sessions").get();
    inspection.close();
    const expectedHash = createHash("sha256").update(session.token).digest("hex");
    expect(requiredTokenHash(row)).toBe(expectedHash);
    expect(requiredTokenHash(row)).not.toBe(session.token);

    const third = openQuietPactDatabase(databasePath);
    const restartedAuth = createWalletAuth(third.walletAuth);
    await expect(restartedAuth.authenticate(`Bearer ${session.token}`)).resolves.toBe(actor);
    await expect(
      restartedAuth.createSession({ actor, nonce: challenge.nonce, signature }),
    ).rejects.toMatchObject({ code: "CHALLENGE_NOT_FOUND" });
    third.close();
  });
});

async function temporaryDatabasePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "quietpact-persistence-"));
  temporaryDirectories.push(directory);
  return join(directory, "quietpact.sqlite");
}

function requiredTokenHash(row: object | undefined): string {
  if (row === undefined) throw new Error("Stored session was not found");
  const value = Reflect.get(row, "token_hash") as unknown;
  if (typeof value !== "string") throw new Error("Stored session hash is invalid");
  return value;
}
