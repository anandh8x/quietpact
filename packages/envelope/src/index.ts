import { encodeAbiParameters, isAddress, keccak256, toHex, type Address, type Hex } from "viem";
import sodium from "libsodium-wrappers";

export type CanonicalValue =
  | null
  | boolean
  | number
  | string
  | readonly CanonicalValue[]
  | { readonly [key: string]: CanonicalValue };

export type Hex32 = `0x${string}`;

export interface CommitmentContext {
  readonly chainId: bigint;
  readonly registry: Address;
  readonly workflowId: Hex32;
  readonly payer: Address;
  readonly payee: Address;
}

export interface EnvelopeContext {
  readonly chainId: string;
  readonly registry: Address;
  readonly workflowId: Hex32;
  readonly payer: Address;
  readonly payee: Address;
}

export interface RecipientKey {
  readonly id: string;
  readonly publicKey: string;
}

export interface RecipientIdentity extends RecipientKey {
  readonly privateKey: string;
}

export interface SealedEnvelope {
  readonly version: 1;
  readonly algorithm: "XChaCha20-Poly1305+X25519-SealedBox";
  readonly context: EnvelopeContext;
  readonly commitment: Hex;
  readonly nonce: string;
  readonly ciphertext: string;
  readonly wrappedKeys: readonly {
    readonly recipientId: string;
    readonly sealedKey: string;
  }[];
}

export interface OpenedEnvelope<T> {
  readonly value: T;
  readonly salt: Hex32;
}

export type EnvelopeErrorCode =
  "INVALID_ENVELOPE" | "RECIPIENT_NOT_AUTHORIZED" | "DECRYPTION_FAILED";

export class EnvelopeError extends Error {
  override readonly name = "EnvelopeError";

  constructor(
    readonly code: EnvelopeErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export interface EnvelopeModule {
  generateRecipientKeyPair(id: string): RecipientIdentity;
  seal<T>(
    context: CommitmentContext,
    value: T,
    recipients: readonly RecipientKey[],
  ): SealedEnvelope;
  open<T>(envelope: SealedEnvelope, recipient: RecipientIdentity): OpenedEnvelope<T>;
  verify(context: CommitmentContext, value: unknown, salt: Hex32, commitment: Hex): boolean;
}

const ENVELOPE_VERSION = 1 as const;
const ENVELOPE_ALGORITHM = "XChaCha20-Poly1305+X25519-SealedBox" as const;
const BASE64_VARIANT = sodium.base64_variants.ORIGINAL;

export function canonicalize(value: unknown): Uint8Array {
  return new TextEncoder().encode(serializeCanonical(value, new Set<object>()));
}

export function commitmentFor(context: CommitmentContext, value: unknown, salt: Hex32): Hex {
  validateContext(context);
  assertHex32(salt, "salt");

  const contentHash = keccak256(toHex(canonicalize(value)));
  return keccak256(
    encodeAbiParameters(
      [
        { type: "uint256" },
        { type: "address" },
        { type: "bytes32" },
        { type: "address" },
        { type: "address" },
        { type: "bytes32" },
        { type: "bytes32" },
      ],
      [
        context.chainId,
        context.registry,
        context.workflowId,
        context.payer,
        context.payee,
        contentHash,
        salt,
      ],
    ),
  );
}

export async function createEnvelopeModule(): Promise<EnvelopeModule> {
  await sodium.ready;

  return {
    generateRecipientKeyPair(id) {
      assertRecipientId(id);
      const keyPair = sodium.crypto_box_keypair();
      return {
        id,
        publicKey: encodeBase64(keyPair.publicKey),
        privateKey: encodeBase64(keyPair.privateKey),
      };
    },

    seal(context, value, recipients) {
      validateContext(context);
      validateRecipients(recipients);

      const salt = toHex(sodium.randombytes_buf(32));
      const commitment = commitmentFor(context, value, salt);
      const wireContext = toEnvelopeContext(context);
      const nonce = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
      const contentKey = sodium.crypto_aead_xchacha20poly1305_ietf_keygen();
      const recipientIds = recipients.map((recipient) => recipient.id);
      const associatedData = envelopeAssociatedData(wireContext, commitment, recipientIds);
      const plaintext = canonicalize({ schemaVersion: 1, salt, value });
      const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
        plaintext,
        associatedData,
        null,
        nonce,
        contentKey,
      );

      return {
        version: ENVELOPE_VERSION,
        algorithm: ENVELOPE_ALGORITHM,
        context: wireContext,
        commitment,
        nonce: encodeBase64(nonce),
        ciphertext: encodeBase64(ciphertext),
        wrappedKeys: recipients.map((recipient) => ({
          recipientId: recipient.id,
          sealedKey: encodeBase64(
            sodium.crypto_box_seal(contentKey, decodeBase64(recipient.publicKey)),
          ),
        })),
      };
    },

    open<T>(envelope: SealedEnvelope, recipient: RecipientIdentity): OpenedEnvelope<T> {
      const wrappedKey = envelope.wrappedKeys.find((entry) => entry.recipientId === recipient.id);
      if (wrappedKey === undefined) {
        throw new EnvelopeError(
          "RECIPIENT_NOT_AUTHORIZED",
          `No encrypted content key exists for recipient ${recipient.id}`,
        );
      }

      try {
        validateEnvelopeHeader(envelope);
        const contentKey = sodium.crypto_box_seal_open(
          decodeBase64(wrappedKey.sealedKey),
          decodeBase64(recipient.publicKey),
          decodeBase64(recipient.privateKey),
        );
        const plaintext = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
          null,
          decodeBase64(envelope.ciphertext),
          envelopeAssociatedData(
            envelope.context,
            envelope.commitment,
            envelope.wrappedKeys.map((entry) => entry.recipientId),
          ),
          decodeBase64(envelope.nonce),
          contentKey,
        );
        const parsed: unknown = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(plaintext),
        );
        const opened = parseOpenedEnvelope<T>(parsed);
        const sourceContext = fromEnvelopeContext(envelope.context);
        if (commitmentFor(sourceContext, opened.value, opened.salt) !== envelope.commitment) {
          throw new EnvelopeError(
            "INVALID_ENVELOPE",
            "Decrypted content does not match the envelope commitment",
          );
        }
        return opened;
      } catch (error) {
        if (error instanceof EnvelopeError) {
          throw error;
        }

        throw new EnvelopeError(
          "DECRYPTION_FAILED",
          "The envelope could not be authenticated and decrypted",
          { cause: error },
        );
      }
    },

    verify(context, value, salt, commitment) {
      try {
        return commitmentFor(context, value, salt).toLowerCase() === commitment.toLowerCase();
      } catch {
        return false;
      }
    },
  };
}

function toEnvelopeContext(context: CommitmentContext): EnvelopeContext {
  return {
    chainId: context.chainId.toString(10),
    registry: context.registry,
    workflowId: context.workflowId,
    payer: context.payer,
    payee: context.payee,
  };
}

function fromEnvelopeContext(context: EnvelopeContext): CommitmentContext {
  return { ...context, chainId: BigInt(context.chainId) };
}

function envelopeAssociatedData(
  context: EnvelopeContext,
  commitment: Hex,
  recipientIds: readonly string[],
): Uint8Array {
  return canonicalize({
    version: ENVELOPE_VERSION,
    algorithm: ENVELOPE_ALGORITHM,
    context,
    commitment,
    recipientIds,
  });
}

function parseOpenedEnvelope<T>(value: unknown): OpenedEnvelope<T> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new EnvelopeError("INVALID_ENVELOPE", "Decrypted envelope content must be an object");
  }

  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== 1) {
    throw new EnvelopeError("INVALID_ENVELOPE", "Unsupported encrypted payload schema");
  }
  if (typeof record.salt !== "string") {
    throw new EnvelopeError("INVALID_ENVELOPE", "Decrypted envelope content has no salt");
  }
  assertHex32(record.salt, "salt");
  if (!("value" in record)) {
    throw new EnvelopeError("INVALID_ENVELOPE", "Decrypted envelope content has no value");
  }

  return { value: record.value as T, salt: record.salt };
}

function validateEnvelopeHeader(envelope: SealedEnvelope): void {
  if (envelope.version !== ENVELOPE_VERSION || envelope.algorithm !== ENVELOPE_ALGORITHM) {
    throw new EnvelopeError("INVALID_ENVELOPE", "Unsupported envelope version or algorithm");
  }

  if (!/^\d+$/.test(envelope.context.chainId)) {
    throw new EnvelopeError("INVALID_ENVELOPE", "Envelope chainId must be a decimal integer");
  }

  validateContext(fromEnvelopeContext(envelope.context));
}

function validateRecipients(recipients: readonly RecipientKey[]): void {
  if (recipients.length === 0) {
    throw new TypeError("At least one recipient is required");
  }

  const ids = new Set<string>();
  for (const recipient of recipients) {
    assertRecipientId(recipient.id);
    if (ids.has(recipient.id)) {
      throw new TypeError(`Duplicate recipient id: ${recipient.id}`);
    }
    ids.add(recipient.id);

    const key = decodeBase64(recipient.publicKey);
    if (key.length !== sodium.crypto_box_PUBLICKEYBYTES) {
      throw new TypeError(`Recipient ${recipient.id} has an invalid public key`);
    }
  }
}

function assertRecipientId(id: string): void {
  if (id.trim().length === 0 || id.length > 128) {
    throw new TypeError("Recipient id must contain between 1 and 128 characters");
  }
}

function encodeBase64(value: Uint8Array): string {
  return sodium.to_base64(value, BASE64_VARIANT);
}

function decodeBase64(value: string): Uint8Array {
  return sodium.from_base64(value, BASE64_VARIANT);
}

function validateContext(context: CommitmentContext): void {
  if (context.chainId < 0n) {
    throw new TypeError("chainId must be an unsigned integer");
  }

  for (const [name, address] of [
    ["registry", context.registry],
    ["payer", context.payer],
    ["payee", context.payee],
  ] as const) {
    if (!isAddress(address, { strict: true })) {
      throw new TypeError(`${name} must be a valid EVM address`);
    }
  }

  assertHex32(context.workflowId, "workflowId");
}

function assertHex32(value: string, name: string): asserts value is Hex32 {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new TypeError(`${name} must be exactly 32 bytes of hexadecimal data`);
  }
}

function serializeCanonical(value: unknown, ancestors: Set<object>): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("Canonical values cannot contain non-finite numbers");
    }

    return JSON.stringify(value);
  }

  if (typeof value !== "object") {
    throw new TypeError(`Unsupported canonical value: ${typeof value}`);
  }

  if (ancestors.has(value)) {
    throw new TypeError("Canonical values cannot contain cycles");
  }

  ancestors.add(value);

  try {
    if (Array.isArray(value)) {
      const keys = Object.keys(value);
      const hasEveryIndex = Array.from({ length: value.length }, (_unused, index) =>
        Object.hasOwn(value, index),
      ).every(Boolean);
      if (!hasEveryIndex || keys.length !== value.length) {
        throw new TypeError(
          "Canonical values cannot contain sparse arrays or extra array properties",
        );
      }

      return `[${value.map((item) => serializeCanonical(item, ancestors)).join(",")}]`;
    }

    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("Canonical values must contain only plain objects");
    }

    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.some((key) => typeof key === "symbol")) {
      throw new TypeError("Canonical values cannot contain symbol-keyed data");
    }

    const entries = (ownKeys as string[]).sort().map((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
        throw new TypeError("Canonical values require enumerable data properties");
      }

      return `${JSON.stringify(key)}:${serializeCanonical(descriptor.value, ancestors)}`;
    });

    return `{${entries.join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}
