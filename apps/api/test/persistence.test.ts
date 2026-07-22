import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { address } from "@quietpact/domain";
import { createEnvelopeModule } from "@quietpact/envelope";
import { privateKeyToAccount } from "viem/accounts";

import { openQuietPactDatabase } from "../src/persistence.js";
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
    const challenge = createWalletAuth(first.walletAuth).issueChallenge(actor);
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
    expect(restartedAuth.authenticate(`Bearer ${session.token}`)).toBe(actor);
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
