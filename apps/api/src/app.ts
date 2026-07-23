import { address, type Address } from "@quietpact/domain";
import type { RecipientKey, SealedEnvelope } from "@quietpact/envelope";
import type { InvoiceProjectionRepository } from "@quietpact/chain-records";
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
  type FastifyServerOptions,
} from "fastify";
import { isHex } from "viem";

import { WalletAuthError, type WalletAuth } from "./wallet-auth.js";
import type { SafeReadinessReport } from "./operational-monitor.js";

export interface InvoiceEnvelopeRepository {
  put(id: string, envelope: SealedEnvelope): Promise<string>;
  get(id: string): Promise<SealedEnvelope | null>;
}

export class InvoiceEnvelopeConflictError extends Error {
  override readonly name = "InvoiceEnvelopeConflictError";
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
  readonly invoiceProjection?: InvoiceProjectionRepository;
  readonly logger?: FastifyServerOptions["logger"];
  readonly bodyLimitBytes?: number;
  readonly authRateLimit?: AuthRateLimitOptions;
  readonly readiness?: () => SafeReadinessReport | Promise<SafeReadinessReport>;
  readonly refreshInvoiceProjection?: () => void | Promise<void>;
  readonly requestPathPrefix?: string;
}

export interface AuthRateLimitOptions {
  readonly maxRequests: number;
  readonly windowMs: number;
  readonly now?: () => number;
}

export function createApp(options: AppOptions = {}): FastifyInstance {
  const bodyLimit = options.bodyLimitBytes ?? 256 * 1024;
  if (!Number.isSafeInteger(bodyLimit) || bodyLimit <= 0) {
    throw new Error("API body limit must be a positive integer");
  }
  const requestPathPrefix = options.requestPathPrefix ?? "";
  if (requestPathPrefix !== "" && !/^\/[A-Za-z0-9/_-]+$/.test(requestPathPrefix)) {
    throw new Error("API request path prefix is invalid");
  }
  const app =
    requestPathPrefix === ""
      ? Fastify({ bodyLimit, logger: options.logger ?? true })
      : Fastify({
          bodyLimit,
          logger: options.logger ?? true,
          rewriteUrl(request) {
            const url = request.url ?? "/";
            return url === requestPathPrefix
              ? "/"
              : url.startsWith(`${requestPathPrefix}/`)
                ? url.slice(requestPathPrefix.length)
                : url;
          },
        });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof WalletAuthError) {
      return reply.code(error.statusCode).send({ code: error.code });
    }
    if (error instanceof InvoiceEnvelopeConflictError) {
      return reply.code(409).send({ code: "INVOICE_ENVELOPE_CONFLICT" });
    }
    if (
      error !== null &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "FST_ERR_CTP_BODY_TOO_LARGE"
    ) {
      return reply.code(413).send({ code: "PAYLOAD_TOO_LARGE" });
    }
    const statusCode =
      error !== null &&
      typeof error === "object" &&
      "statusCode" in error &&
      typeof error.statusCode === "number"
        ? error.statusCode
        : null;
    if (statusCode !== null && statusCode >= 400 && statusCode < 500) {
      return reply.code(statusCode).send({ code: "INVALID_REQUEST" });
    }
    request.log.error(
      { errorName: error instanceof Error ? error.name : "UnknownError" },
      "request failed",
    );
    return reply.code(500).send({ code: "INTERNAL_ERROR" });
  });

  app.get("/health", () => ({
    name: "quietpact-api",
    status: "ok",
  }));

  if (options.readiness !== undefined) {
    const readiness = options.readiness;
    app.get("/ready", async (_request, reply) => {
      const report = await readiness();
      return reply.code(report.status === "ready" ? 200 : 503).send(report);
    });
  }

  if (options.walletAuth !== undefined) {
    const walletAuth = options.walletAuth;
    const enforceAuthRateLimit = createRateLimitHook(
      options.authRateLimit ?? {
        maxRequests: 20,
        windowMs: 60_000,
      },
    );

    app.post("/v1/auth/challenges", { onRequest: enforceAuthRateLimit }, async (request, reply) => {
      const actor = parseActorBody(request.body);
      return actor === null
        ? reply.code(400).send({ code: "INVALID_ADDRESS" })
        : { challenge: await walletAuth.issueChallenge(actor) };
    });

    app.post("/v1/auth/sessions", { onRequest: enforceAuthRateLimit }, async (request, reply) => {
      const input = parseSessionBody(request.body);
      if (input === null) return reply.code(400).send({ code: "INVALID_SESSION_REQUEST" });
      const session = await walletAuth.createSession(input);
      return reply.code(201).send({ session });
    });
  }

  if (options.invoiceProjection !== undefined) {
    const projection = options.invoiceProjection;
    app.get<{ Params: { id: string } }>("/v1/invoice-records/:id", async (request, reply) => {
      const id = parseHex32(request.params.id);
      if (id === null) return reply.code(400).send({ code: "INVALID_INVOICE_ID" });
      await options.refreshInvoiceProjection?.();
      const invoice = await projection.view(id);
      return invoice === null
        ? reply.code(404).send({ code: "NOT_FOUND" })
        : { invoice: { ...invoice, latestBlock: invoice.latestBlock.toString() } };
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

function createRateLimitHook(options: AuthRateLimitOptions) {
  if (!Number.isSafeInteger(options.maxRequests) || options.maxRequests <= 0) {
    throw new Error("Authentication rate limit must be a positive integer");
  }
  if (!Number.isSafeInteger(options.windowMs) || options.windowMs <= 0) {
    throw new Error("Authentication rate-limit window must be a positive integer");
  }
  const now = options.now ?? Date.now;
  const buckets = new Map<string, { count: number; resetsAt: number }>();

  return (request: FastifyRequest, reply: FastifyReply, done: () => void) => {
    const timestamp = now();
    let bucket = buckets.get(request.ip);
    if (bucket === undefined || timestamp >= bucket.resetsAt) {
      if (buckets.size >= 10_000) {
        for (const [key, candidate] of buckets) {
          if (timestamp >= candidate.resetsAt) buckets.delete(key);
        }
        if (buckets.size >= 10_000) {
          const oldestKey = buckets.keys().next().value;
          if (oldestKey !== undefined) buckets.delete(oldestKey);
        }
      }
      bucket = { count: 0, resetsAt: timestamp + options.windowMs };
      buckets.set(request.ip, bucket);
    }

    const remaining = Math.max(0, options.maxRequests - bucket.count - 1);
    reply.header("x-ratelimit-limit", String(options.maxRequests));
    reply.header("x-ratelimit-remaining", String(remaining));
    reply.header("x-ratelimit-reset", String(Math.ceil(bucket.resetsAt / 1000)));
    if (bucket.count >= options.maxRequests) {
      const retryAfterSeconds = Math.max(1, Math.ceil((bucket.resetsAt - timestamp) / 1000));
      void reply
        .header("retry-after", String(retryAfterSeconds))
        .code(429)
        .send({ code: "RATE_LIMITED" });
      return;
    }
    bucket.count += 1;
    done();
  };
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
      const key = id.toLowerCase();
      const existing = envelopes.get(key);
      if (existing !== undefined && JSON.stringify(existing) !== JSON.stringify(envelope)) {
        return Promise.reject(
          new InvoiceEnvelopeConflictError("Invoice envelope is already stored"),
        );
      }
      envelopes.set(key, structuredClone(envelope));
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

function parseHex32(value: string): `0x${string}` | null {
  return /^0x[0-9a-fA-F]{64}$/.test(value) ? (value.toLowerCase() as `0x${string}`) : null;
}
