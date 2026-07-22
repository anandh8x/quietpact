import { address, commitmentHash, secretSalt } from "@quietpact/domain";
import { describe, expect, it } from "vitest";

import {
  createBidSecretBackup,
  decryptBidSecret,
  encryptBidSecret,
  loadEncryptedBidSecret,
  parseEncryptedBidSecret,
  saveEncryptedBidSecret,
  serializeEncryptedBidSecret,
} from "./bid-secrets.js";

const signature = `0x${"ab".repeat(65)}`;

describe("encrypted bid opening backups", () => {
  it("encrypts browser storage and exported files while round-tripping the opening", async () => {
    const storage = memoryStorage();
    const backup = createBackup();
    const encrypted = await encryptBidSecret(backup, signature);

    saveEncryptedBidSecret(storage, encrypted);
    const stored = loadEncryptedBidSecret(storage, encrypted);

    expect(stored).toEqual(encrypted);
    expect(JSON.stringify(encrypted)).not.toContain(backup.amount);
    expect(JSON.stringify(encrypted)).not.toContain(backup.salt);
    await expect(decryptBidSecret(stored!, signature)).resolves.toEqual(backup);
    expect(parseEncryptedBidSecret(serializeEncryptedBidSecret(encrypted))).toEqual(encrypted);
  });

  it("fails closed for the wrong wallet signature or modified public identity", async () => {
    const encrypted = await encryptBidSecret(createBackup(), signature);
    await expect(decryptBidSecret(encrypted, `0x${"cd".repeat(65)}`)).rejects.toThrow(
      "could not be decrypted",
    );

    const modified = { ...encrypted, chainId: "1" };
    await expect(decryptBidSecret(modified, signature)).rejects.toThrow("could not be decrypted");
  });
});

function createBackup() {
  return createBidSecretBackup({
    chainId: 31_337n,
    auction: address("0x1000000000000000000000000000000000000001"),
    auctionId: `0x${"12".repeat(32)}`,
    bidder: address("0x2000000000000000000000000000000000000002"),
    amount: 987_654_321n,
    salt: secretSalt(`0x${"34".repeat(32)}`),
    commitment: commitmentHash(`0x${"56".repeat(32)}`),
    now: new Date("2026-07-22T12:00:00.000Z"),
  });
}

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value),
  };
}
