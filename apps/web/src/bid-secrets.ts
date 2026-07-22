import {
  address,
  commitmentHash,
  secretSalt,
  type Address,
  type CommitmentHash,
  type SecretSalt,
} from "@quietpact/domain";
import type { Hash } from "viem";

export interface BidSecretIdentity {
  readonly chainId: string;
  readonly auction: Address;
  readonly auctionId: Hash;
  readonly bidder: Address;
}

export interface BidSecretBackup extends BidSecretIdentity {
  readonly version: 1;
  readonly amount: string;
  readonly salt: SecretSalt;
  readonly commitment: CommitmentHash;
  readonly createdAt: string;
}

export interface EncryptedBidSecretBackup extends BidSecretIdentity {
  readonly version: 1;
  readonly kind: "quietpact-encrypted-bid-opening";
  readonly algorithm: "AES-GCM";
  readonly iv: string;
  readonly ciphertext: string;
  readonly createdAt: string;
}

export function createBidSecretBackup(input: {
  readonly chainId: bigint;
  readonly auction: Address;
  readonly auctionId: Hash;
  readonly bidder: Address;
  readonly amount: bigint;
  readonly salt: SecretSalt;
  readonly commitment: CommitmentHash;
  readonly now?: Date;
}): BidSecretBackup {
  if (input.chainId <= 0n) throw new Error("Bid backup chain ID must be positive");
  if (input.amount <= 0n) throw new Error("Bid backup amount must be greater than zero");
  return Object.freeze({
    version: 1,
    chainId: input.chainId.toString(),
    auction: input.auction,
    auctionId: parseHash(input.auctionId, "Auction ID"),
    bidder: input.bidder,
    amount: input.amount.toString(),
    salt: input.salt,
    commitment: input.commitment,
    createdAt: (input.now ?? new Date()).toISOString(),
  });
}

export function bidSecretUnlockMessage(identity: BidSecretIdentity): string {
  return [
    "QuietPact bid-opening backup encryption",
    "Signing unlocks this browser backup. It sends no transaction and costs no gas.",
    `Chain ID: ${identity.chainId}`,
    `Auction contract: ${identity.auction}`,
    `Auction ID: ${identity.auctionId}`,
    `Bidder: ${identity.bidder}`,
  ].join("\n");
}

export async function encryptBidSecret(
  backup: BidSecretBackup,
  walletSignature: string,
): Promise<EncryptedBidSecretBackup> {
  const iv = crypto.getRandomValues(new Uint8Array(new ArrayBuffer(12)));
  const plaintext = new TextEncoder().encode(JSON.stringify(backup));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: associatedData(backup) },
    await encryptionKey(walletSignature),
    plaintext,
  );
  return Object.freeze({
    version: 1,
    kind: "quietpact-encrypted-bid-opening",
    algorithm: "AES-GCM",
    chainId: backup.chainId,
    auction: backup.auction,
    auctionId: backup.auctionId,
    bidder: backup.bidder,
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
    createdAt: backup.createdAt,
  });
}

export async function decryptBidSecret(
  encrypted: EncryptedBidSecretBackup,
  walletSignature: string,
): Promise<BidSecretBackup> {
  try {
    const plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: base64ToBytes(encrypted.iv),
        additionalData: associatedData(encrypted),
      },
      await encryptionKey(walletSignature),
      base64ToBytes(encrypted.ciphertext),
    );
    const backup = parsePlaintextBidSecret(new TextDecoder().decode(plaintext));
    if (!sameIdentity(backup, encrypted)) throw new Error("Bid backup identity was modified");
    return backup;
  } catch (cause: unknown) {
    if (cause instanceof Error && cause.message === "Bid backup identity was modified") throw cause;
    throw new Error("Bid backup could not be decrypted with this wallet signature");
  }
}

export function saveEncryptedBidSecret(storage: Storage, backup: EncryptedBidSecretBackup): void {
  storage.setItem(storageKey(backup), serializeEncryptedBidSecret(backup));
}

export function loadEncryptedBidSecret(
  storage: Storage,
  identity: BidSecretIdentity,
): EncryptedBidSecretBackup | null {
  const stored = storage.getItem(storageKey(identity));
  return stored === null ? null : parseEncryptedBidSecret(stored);
}

export function serializeEncryptedBidSecret(backup: EncryptedBidSecretBackup): string {
  return `${JSON.stringify(backup, null, 2)}\n`;
}

export function parseEncryptedBidSecret(serialized: string): EncryptedBidSecretBackup {
  const value: unknown = JSON.parse(serialized);
  if (value === null || typeof value !== "object") throw new Error("Bid backup must be an object");
  if (!("version" in value) || value.version !== 1) {
    throw new Error("Unsupported bid backup version");
  }
  if (!("kind" in value) || value.kind !== "quietpact-encrypted-bid-opening") {
    throw new Error("File is not an encrypted QuietPact bid backup");
  }
  if (!("algorithm" in value) || value.algorithm !== "AES-GCM") {
    throw new Error("Unsupported bid backup encryption");
  }
  const identity = parseIdentity(value);
  const iv = requireBase64(value, "iv");
  const ciphertext = requireBase64(value, "ciphertext");
  const createdAt = requireTimestamp(value, "createdAt");
  if (base64ToBytes(iv).length !== 12) throw new Error("Bid backup IV is invalid");
  return Object.freeze({
    version: 1,
    kind: "quietpact-encrypted-bid-opening",
    algorithm: "AES-GCM",
    ...identity,
    iv,
    ciphertext,
    createdAt,
  });
}

export function sameBidSecretIdentity(left: BidSecretIdentity, right: BidSecretIdentity): boolean {
  return sameIdentity(left, right);
}

function parsePlaintextBidSecret(serialized: string): BidSecretBackup {
  const value: unknown = JSON.parse(serialized);
  if (value === null || typeof value !== "object") throw new Error("Bid opening is invalid");
  if (!("version" in value) || value.version !== 1) throw new Error("Bid opening is invalid");
  const identity = parseIdentity(value);
  const amount = requireString(value, "amount");
  if (!/^[1-9][0-9]*$/.test(amount)) throw new Error("Bid backup amount is invalid");
  return Object.freeze({
    version: 1,
    ...identity,
    amount,
    salt: secretSalt(requireString(value, "salt")),
    commitment: commitmentHash(requireString(value, "commitment")),
    createdAt: requireTimestamp(value, "createdAt"),
  });
}

function parseIdentity(value: object): BidSecretIdentity {
  const chainId = requireString(value, "chainId");
  if (!/^[1-9][0-9]*$/.test(chainId)) throw new Error("Bid backup chain ID is invalid");
  return {
    chainId,
    auction: address(requireString(value, "auction")),
    auctionId: parseHash(requireString(value, "auctionId"), "Auction ID"),
    bidder: address(requireString(value, "bidder")),
  };
}

function storageKey(identity: BidSecretIdentity): string {
  return [
    "quietpact:encrypted-bid-opening",
    identity.chainId,
    identity.auction,
    identity.auctionId,
    identity.bidder,
  ].join(":");
}

async function encryptionKey(walletSignature: string): Promise<CryptoKey> {
  if (!/^0x[0-9a-fA-F]+$/.test(walletSignature)) throw new Error("Wallet signature is invalid");
  const material = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`QuietPact bid backup key v1\0${walletSignature}`),
  );
  return crypto.subtle.importKey("raw", material, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

function associatedData(identity: BidSecretIdentity): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(
    [identity.chainId, identity.auction, identity.auctionId, identity.bidder].join("\0"),
  );
}

function sameIdentity(left: BidSecretIdentity, right: BidSecretIdentity): boolean {
  return (
    left.chainId === right.chainId &&
    left.auction === right.auction &&
    left.auctionId === right.auctionId &&
    left.bidder === right.bidder
  );
}

function requireString(value: object, field: string): string {
  const result = (value as Record<string, unknown>)[field];
  if (typeof result !== "string") throw new Error(`Bid backup ${field} is invalid`);
  return result;
}

function requireBase64(value: object, field: string): string {
  const result = requireString(value, field);
  try {
    base64ToBytes(result);
    return result;
  } catch {
    throw new Error(`Bid backup ${field} is invalid`);
  }
}

function requireTimestamp(value: object, field: string): string {
  const result = requireString(value, field);
  if (Number.isNaN(Date.parse(result))) throw new Error("Bid backup timestamp is invalid");
  return result;
}

function parseHash(value: string, label: string): Hash {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) throw new Error(`${label} must be 32-byte hex`);
  return value.toLowerCase() as Hash;
}

function bytesToBase64(value: Uint8Array): string {
  return btoa(String.fromCharCode(...value));
}

function base64ToBytes(value: string): Uint8Array<ArrayBuffer> {
  const decoded = atob(value);
  const bytes = new Uint8Array(new ArrayBuffer(decoded.length));
  for (let index = 0; index < decoded.length; index += 1) {
    bytes[index] = decoded.charCodeAt(index);
  }
  return bytes;
}
