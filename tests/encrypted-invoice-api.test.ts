import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { createApp, createInMemoryInvoiceEnvelopeRepository } from "../apps/api/src/app.js";
import { address } from "../packages/domain/src/index.js";
import { createEnvelopeModule } from "../packages/envelope/src/index.js";
import {
  createEncryptedInvoiceModule,
  createHttpInvoiceBlobStore,
  createInMemoryInvoiceAdapters,
  type InvoiceParticipant,
} from "../packages/invoice/src/index.js";

describe("encrypted invoice through the local API", () => {
  const closeCallbacks: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.all(closeCallbacks.splice(0).map(async (close) => close()));
  });

  it("persists ciphertext over HTTP and lets the other party decrypt it", async () => {
    const envelopes = await createEnvelopeModule();
    const payerAddress = address("0x2000000000000000000000000000000000000002");
    const payeeAddress = address("0x3000000000000000000000000000000000000003");
    const payer: InvoiceParticipant = {
      address: payerAddress,
      encryption: envelopes.generateRecipientKeyPair(payerAddress),
    };
    const payee: InvoiceParticipant = {
      address: payeeAddress,
      encryption: envelopes.generateRecipientKeyPair(payeeAddress),
    };
    const app = createApp({
      authenticate: (request) => address(String(request.headers["x-test-wallet"])),
      invoiceEnvelopes: createInMemoryInvoiceEnvelopeRepository(),
    });
    await app.listen({ host: "127.0.0.1", port: 0 });
    closeCallbacks.push(async () => app.close());
    const { port } = app.server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${port}`;
    const { records } = createInMemoryInvoiceAdapters();
    const moduleFor = (actor: InvoiceParticipant) =>
      createEncryptedInvoiceModule({
        actor,
        chainId: 31_337n,
        registry: "0x1111111111111111111111111111111111111111",
        envelopes,
        records,
        blobs: createHttpInvoiceBlobStore({
          baseUrl,
          headers: () => ({ "x-test-wallet": actor.address }),
        }),
      });
    const id = `0x${"76".repeat(32)}` as const;
    const body = { amount: "875.00", memo: "HTTP_PRIVATE_CANARY_c431" };

    await moduleFor(payee).create({ id, payer, payee, body });
    const reopened = await moduleFor(payer).view<typeof body>(id);

    expect(reopened.body).toEqual(body);
    expect(JSON.stringify(reopened.public)).not.toContain("HTTP_PRIVATE_CANARY_c431");
  });
});
