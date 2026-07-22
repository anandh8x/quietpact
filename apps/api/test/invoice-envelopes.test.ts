import { describe, expect, it } from "vitest";

import { address } from "@quietpact/domain";
import { createEnvelopeModule } from "@quietpact/envelope";

import { createApp, createInMemoryInvoiceEnvelopeRepository } from "../src/app.js";

const payer = address("0x2000000000000000000000000000000000000002");
const payee = address("0x3000000000000000000000000000000000000003");
const invoiceId = `0x${"12".repeat(32)}` as const;

describe("invoice envelope HTTP interface", () => {
  it("stores and returns an opaque envelope to authorized invoice parties", async () => {
    const envelopes = await createEnvelopeModule();
    const payerKey = envelopes.generateRecipientKeyPair(payer);
    const payeeKey = envelopes.generateRecipientKeyPair(payee);
    const envelope = envelopes.seal(
      {
        chainId: 31_337n,
        registry: "0x1111111111111111111111111111111111111111",
        workflowId: invoiceId,
        payer,
        payee,
      },
      { amount: "1250.00", memo: "API_PRIVATE_CANARY_b6e1" },
      [payerKey, payeeKey],
    );
    const app = createApp({
      authenticate: (request) => address(String(request.headers["x-test-wallet"])),
      invoiceEnvelopes: createInMemoryInvoiceEnvelopeRepository(),
    });

    const stored = await app.inject({
      method: "PUT",
      url: `/v1/invoice-envelopes/${invoiceId}`,
      headers: { "x-test-wallet": payee },
      payload: { envelope },
    });
    const retrieved = await app.inject({
      method: "GET",
      url: `/v1/invoice-envelopes/${invoiceId}`,
      headers: { "x-test-wallet": payer },
    });

    expect(stored.statusCode).toBe(201);
    expect(stored.json()).toMatchObject({ reference: `invoice-envelope:${invoiceId}` });
    expect(retrieved.statusCode).toBe(200);
    expect(retrieved.json()).toEqual({ envelope });
    expect(retrieved.body).not.toContain("API_PRIVATE_CANARY_b6e1");
    await app.close();
  });

  it("rejects plaintext-shaped invoice payloads", async () => {
    const app = createApp({
      authenticate: () => payee,
      invoiceEnvelopes: createInMemoryInvoiceEnvelopeRepository(),
    });

    const response = await app.inject({
      method: "PUT",
      url: `/v1/invoice-envelopes/${invoiceId}`,
      payload: { amount: "1250.00", memo: "PLAINTEXT_REJECTION_CANARY_84a1" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ code: "INVALID_ENVELOPE" });
    expect(response.body).not.toContain("PLAINTEXT_REJECTION_CANARY_84a1");
    await app.close();
  });
});
