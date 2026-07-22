import { describe, expect, it } from "vitest";

import { address } from "@quietpact/domain";
import { createEnvelopeModule } from "@quietpact/envelope";

import {
  createEncryptedInvoiceModule,
  createInMemoryInvoiceAdapters,
  type InvoiceParticipant,
} from "../src/index.js";

const chainId = 31_337n;
const registry = "0x1111111111111111111111111111111111111111";
const invoiceId = `0x${"12".repeat(32)}` as const;

describe("encrypted invoice workflow", () => {
  it("lets an authorized payer reopen an invoice without exposing its body publicly", async () => {
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
    const adapters = createInMemoryInvoiceAdapters();
    const payeeInvoices = createEncryptedInvoiceModule({
      actor: payee,
      chainId,
      registry,
      envelopes,
      ...adapters,
    });
    const payerInvoices = createEncryptedInvoiceModule({
      actor: payer,
      chainId,
      registry,
      envelopes,
      ...adapters,
    });
    const body = {
      amount: "1250.00",
      currency: "USDC",
      memo: "PHASE4_PRIVATE_CANARY_91d2",
    };

    const created = await payeeInvoices.create({ id: invoiceId, payer, payee, body });
    const reopened = await payerInvoices.view<typeof body>(invoiceId);

    expect(created.body).toEqual(body);
    expect(reopened.body).toEqual(body);
    expect(reopened.public).toMatchObject({
      id: invoiceId,
      payer: payerAddress,
      payee: payeeAddress,
      state: "REGISTERED",
      privacyLabel: "Encrypted workflow data · no private payment claim",
    });
    expect(JSON.stringify(reopened.public)).not.toContain("PHASE4_PRIVATE_CANARY_91d2");
  });

  it("lets the payer approve through the same encrypted workflow interface", async () => {
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
    const adapters = createInMemoryInvoiceAdapters();
    const moduleFor = (actor: InvoiceParticipant) =>
      createEncryptedInvoiceModule({
        actor,
        chainId,
        registry,
        envelopes,
        ...adapters,
      });
    await moduleFor(payee).create({
      id: invoiceId,
      payer,
      payee,
      body: { amount: "1250.00", currency: "USDC" },
    });

    const approved = await moduleFor(payer).act(invoiceId, { type: "approve" });

    expect(approved.public.state).toBe("APPROVED");
    expect(approved.body).toEqual({ amount: "1250.00", currency: "USDC" });
    await expect(moduleFor(payee).view(invoiceId)).resolves.toMatchObject({
      public: { state: "APPROVED" },
    });
  });

  it("shows only public state to a stranger and rejects their approval", async () => {
    const envelopes = await createEnvelopeModule();
    const payerAddress = address("0x2000000000000000000000000000000000000002");
    const payeeAddress = address("0x3000000000000000000000000000000000000003");
    const strangerAddress = address("0x4000000000000000000000000000000000000004");
    const payer: InvoiceParticipant = {
      address: payerAddress,
      encryption: envelopes.generateRecipientKeyPair(payerAddress),
    };
    const payee: InvoiceParticipant = {
      address: payeeAddress,
      encryption: envelopes.generateRecipientKeyPair(payeeAddress),
    };
    const stranger: InvoiceParticipant = {
      address: strangerAddress,
      encryption: envelopes.generateRecipientKeyPair(strangerAddress),
    };
    const adapters = createInMemoryInvoiceAdapters();
    const moduleFor = (actor: InvoiceParticipant) =>
      createEncryptedInvoiceModule({
        actor,
        chainId,
        registry,
        envelopes,
        ...adapters,
      });
    await moduleFor(payee).create({
      id: invoiceId,
      payer,
      payee,
      body: { memo: "STRANGER_MUST_NOT_SEE_3f82" },
    });

    const publicOnly = await moduleFor(stranger).view(invoiceId);

    expect(publicOnly.body).toBeNull();
    expect(JSON.stringify(publicOnly)).not.toContain("STRANGER_MUST_NOT_SEE_3f82");
    await expect(moduleFor(stranger).act(invoiceId, { type: "approve" })).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });
});
