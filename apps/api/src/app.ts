import { address, type Address } from "@quietpact/domain";
import type { RecipientKey, SealedEnvelope } from "@quietpact/envelope";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { isHex } from "viem";

import { WalletAuthError, type WalletAuth } from "./wallet-auth.js";

export interface InvoiceEnvelopeRepository {
  put(id: string, envelope: SealedEnvelope): Promise<string>;
  get(id: string): Promise<SealedEnvelope | null>;
}

export interface EncryptionKeyRepository {
  put(key: PublishedEncryptionKey): Promise<void>;
  get(id: Address): Promise<PublishedEncryptionKey | null>;
}

export interface PublishedEncryptionKey extends RecipientKey {
  readonly id: Address;
}

export interface AppOptions {
  readonly authenticate?: (request: FastifyRequest) => Address | Promise<Address>;
  readonly invoiceEnvelopes?: InvoiceEnvelopeRepository;
  readonly encryptionKeys?: EncryptionKeyRepository;
  readonly walletAuth?: WalletAuth;
}

export function createApp(options: AppOptions = {}): FastifyInstance {
  const app = Fastify({ logger: true });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof WalletAuthError) {
      return reply.code(error.statusCode).send({ code: error.code });
    }
    return reply.send(error);
  });

  app.get("/health", () => ({
    name: "quietpact-api",
    status: "ok",
  }));

  if (options.walletAuth !== undefined) {
    const walletAuth = options.walletAuth;

    app.post("/v1/auth/challenges", async (request, reply) => {
      const actor = parseActorBody(request.body);
      return actor === null
        ? reply.code(400).send({ code: "INVALID_ADDRESS" })
        : { challenge: walletAuth.issueChallenge(actor) };
    });

    app.post("/v1/auth/sessions", async (request, reply) => {
      const input = parseSessionBody(request.body);
      if (input === null) return reply.code(400).send({ code: "INVALID_SESSION_REQUEST" });
      const session = await walletAuth.createSession(input);
      return reply.code(201).send({ session });
    });
  }

  if (options.authenticate !== undefined && options.invoiceEnvelopes !== undefined) {
    const authenticate = options.authenticate;
    const repository = options.invoiceEnvelopes;

    app.put<{ Params: { id: string } }>("/v1/invoice-envelopes/:id", async (request, reply) => {
      const actor = await authenticate(request);
      const envelope = parseEnvelope(request.body);
      if (envelope === null) {
        return reply.code(400).send({ code: "INVALID_ENVELOPE" });
      }
      if (envelope.context.workflowId.toLowerCase() !== request.params.id.toLowerCase()) {
        return reply.code(400).send({ code: "WORKFLOW_MISMATCH" });
      }
      if (actor !== envelope.context.payer && actor !== envelope.context.payee) {
        return reply.code(403).send({ code: "UNAUTHORIZED" });
      }

      const reference = await repository.put(request.params.id, envelope);
      return reply.code(201).send({ reference });
    });

    app.get<{ Params: { id: string } }>("/v1/invoice-envelopes/:id", async (request, reply) => {
      const actor = await authenticate(request);
      const envelope = await repository.get(request.params.id);
      if (envelope === null) return reply.code(404).send({ code: "NOT_FOUND" });
      if (!envelope.wrappedKeys.some((key) => key.recipientId === actor)) {
        return reply.code(403).send({ code: "UNAUTHORIZED" });
      }

      return { envelope };
    });
  }

  if (options.authenticate !== undefined && options.encryptionKeys !== undefined) {
    const authenticate = options.authenticate;
    const repository = options.encryptionKeys;

    app.put<{ Params: { address: string } }>(
      "/v1/encryption-keys/:address",
      async (request, reply) => {
        const actor = await authenticate(request);
        const recipient = parseAddress(request.params.address);
        const publicKey = parsePublicKey(request.body);
        if (recipient === null || publicKey === null) {
          return reply.code(400).send({ code: "INVALID_ENCRYPTION_KEY" });
        }
        if (actor !== recipient) return reply.code(403).send({ code: "UNAUTHORIZED" });

        await repository.put({ id: recipient, publicKey });
        return reply.code(204).send();
      },
    );

    app.get<{ Params: { address: string } }>(
      "/v1/encryption-keys/:address",
      async (request, reply) => {
        const recipient = parseAddress(request.params.address);
        if (recipient === null) {
          return reply.code(400).send({ code: "INVALID_ADDRESS" });
        }
        const key = await repository.get(recipient);
        return key === null ? reply.code(404).send({ code: "NOT_FOUND" }) : { key };
      },
    );
  }

  return app;
}

export function createInMemoryEncryptionKeyRepository(): EncryptionKeyRepository {
  const keys = new Map<Address, PublishedEncryptionKey>();

  return {
    put(key) {
      keys.set(key.id, Object.freeze({ ...key }));
      return Promise.resolve();
    },
    get(id) {
      return Promise.resolve(keys.get(id) ?? null);
    },
  };
}

export function createInMemoryInvoiceEnvelopeRepository(): InvoiceEnvelopeRepository {
  const envelopes = new Map<string, SealedEnvelope>();

  return {
    put(id, envelope) {
      envelopes.set(id.toLowerCase(), structuredClone(envelope));
      return Promise.resolve(`invoice-envelope:${id}`);
    },
    get(id) {
      const envelope = envelopes.get(id.toLowerCase());
      return Promise.resolve(envelope === undefined ? null : structuredClone(envelope));
    },
  };
}

function parseEnvelope(body: unknown): SealedEnvelope | null {
  if (body === null || typeof body !== "object" || !("envelope" in body)) {
    return null;
  }

  const envelope: unknown = body.envelope;
  if (
    envelope === null ||
    typeof envelope !== "object" ||
    !("context" in envelope) ||
    !("wrappedKeys" in envelope) ||
    !Array.isArray(envelope.wrappedKeys)
  ) {
    return null;
  }

  return envelope as SealedEnvelope;
}

function parseAddress(value: string): Address | null {
  try {
    return address(value);
  } catch {
    return null;
  }
}

function parsePublicKey(body: unknown): string | null {
  if (
    body === null ||
    typeof body !== "object" ||
    !("publicKey" in body) ||
    typeof body.publicKey !== "string" ||
    body.publicKey.length < 32 ||
    body.publicKey.length > 128
  ) {
    return null;
  }
  return body.publicKey;
}

function parseActorBody(body: unknown): Address | null {
  if (body === null || typeof body !== "object" || !("address" in body)) return null;
  return typeof body.address === "string" ? parseAddress(body.address) : null;
}

function parseSessionBody(body: unknown): {
  actor: Address;
  nonce: string;
  signature: `0x${string}`;
} | null {
  if (
    body === null ||
    typeof body !== "object" ||
    !("address" in body) ||
    typeof body.address !== "string" ||
    !("nonce" in body) ||
    typeof body.nonce !== "string" ||
    !("signature" in body) ||
    typeof body.signature !== "string" ||
    !isHex(body.signature) ||
    body.signature.length !== 132
  ) {
    return null;
  }
  const actor = parseAddress(body.address);
  return actor === null ? null : { actor, nonce: body.nonce, signature: body.signature };
}
