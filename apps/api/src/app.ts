import type { Address } from "@quietpact/domain";
import type { SealedEnvelope } from "@quietpact/envelope";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";

export interface InvoiceEnvelopeRepository {
  put(id: string, envelope: SealedEnvelope): Promise<string>;
  get(id: string): Promise<SealedEnvelope | null>;
}

export interface AppOptions {
  readonly authenticate?: (request: FastifyRequest) => Address | Promise<Address>;
  readonly invoiceEnvelopes?: InvoiceEnvelopeRepository;
}

export function createApp(options: AppOptions = {}): FastifyInstance {
  const app = Fastify({ logger: true });

  app.get("/health", () => ({
    name: "quietpact-api",
    status: "ok",
  }));

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

  return app;
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
