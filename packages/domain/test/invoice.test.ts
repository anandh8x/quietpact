import { describe, expect, it } from "vitest";

import {
  address,
  commitmentHash,
  createInvoiceModule,
  invoiceId,
  transactionReference,
} from "../src/index.js";

describe("invoice workflow", () => {
  it("registers an invoice commitment without exposing invoice contents", async () => {
    const invoices = createInvoiceModule();
    const payer = address("0x1000000000000000000000000000000000000001");
    const payee = address("0x2000000000000000000000000000000000000002");

    const created = await invoices.create({
      actor: payee,
      id: invoiceId("invoice-001"),
      payer,
      payee,
      commitment: commitmentHash(`0x${"ab".repeat(32)}`),
      ciphertextReference: "ciphertext/invoice-001",
    });

    expect(created).toEqual({
      id: "invoice-001",
      payer,
      payee,
      commitment: `0x${"ab".repeat(32)}`,
      ciphertextReference: "ciphertext/invoice-001",
      state: "REGISTERED",
      privacyLabel: "Encrypted workflow data · no private payment claim",
      payment: null,
    });
    await expect(invoices.view(invoiceId("invoice-001"))).resolves.toEqual(created);
    expect(JSON.stringify(created)).not.toContain("amount");
  });

  it("rejects registration by someone outside the invoice", async () => {
    const invoices = createInvoiceModule();

    await expect(
      invoices.create({
        actor: address("0x3000000000000000000000000000000000000003"),
        id: invoiceId("invoice-unauthorized"),
        payer: address("0x1000000000000000000000000000000000000001"),
        payee: address("0x2000000000000000000000000000000000000002"),
        commitment: commitmentHash(`0x${"cd".repeat(32)}`),
        ciphertextReference: "ciphertext/invoice-unauthorized",
      }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("moves an approved invoice through an explicitly public payment reference", async () => {
    const invoices = createInvoiceModule();
    const payer = address("0x1000000000000000000000000000000000000001");
    const payee = address("0x2000000000000000000000000000000000000002");
    const id = invoiceId("invoice-lifecycle");
    await invoices.create({
      actor: payee,
      id,
      payer,
      payee,
      commitment: commitmentHash(`0x${"ef".repeat(32)}`),
      ciphertextReference: "ciphertext/invoice-lifecycle",
    });

    await expect(invoices.act(id, { type: "approve", actor: payer })).resolves.toMatchObject({
      state: "APPROVED",
      payment: null,
    });
    await expect(
      invoices.act(id, {
        type: "attachPublicPayment",
        actor: payer,
        reference: transactionReference(`0x${"12".repeat(32)}`),
      }),
    ).resolves.toMatchObject({
      state: "PAYMENT_REFERENCED",
      payment: {
        reference: `0x${"12".repeat(32)}`,
        classification: "PUBLIC_ONCHAIN",
        label: "Public onchain payment · amount and parties are inspectable",
      },
    });
    const completed = await invoices.act(id, { type: "complete", actor: payee });

    expect(completed.state).toBe("COMPLETE");
    expect(JSON.stringify(completed)).not.toMatch(/settled.?privately/i);
  });

  it("rejects a duplicate invoice identifier without replacing the original", async () => {
    const invoices = createInvoiceModule();
    const payer = address("0x1000000000000000000000000000000000000001");
    const payee = address("0x2000000000000000000000000000000000000002");
    const id = invoiceId("invoice-duplicate");
    const original = await invoices.create({
      actor: payee,
      id,
      payer,
      payee,
      commitment: commitmentHash(`0x${"34".repeat(32)}`),
      ciphertextReference: "ciphertext/original",
    });

    await expect(
      invoices.create({
        actor: payer,
        id,
        payer,
        payee,
        commitment: commitmentHash(`0x${"56".repeat(32)}`),
        ciphertextReference: "ciphertext/replacement",
      }),
    ).rejects.toMatchObject({ code: "ALREADY_EXISTS" });
    await expect(invoices.view(id)).resolves.toEqual(original);
  });

  it("allows only the payer to approve and rejects repeated approval", async () => {
    const invoices = createInvoiceModule();
    const payer = address("0x1000000000000000000000000000000000000001");
    const payee = address("0x2000000000000000000000000000000000000002");
    const auditor = address("0x3000000000000000000000000000000000000003");
    const stranger = address("0x4000000000000000000000000000000000000004");
    const id = invoiceId("invoice-approval-policy");
    await invoices.create({
      actor: payee,
      id,
      payer,
      payee,
      auditor,
      commitment: commitmentHash(`0x${"78".repeat(32)}`),
      ciphertextReference: "ciphertext/invoice-approval-policy",
    });

    for (const actor of [payee, auditor, stranger]) {
      await expect(invoices.act(id, { type: "approve", actor })).rejects.toMatchObject({
        code: "UNAUTHORIZED",
      });
    }

    await expect(invoices.act(id, { type: "approve", actor: payer })).resolves.toMatchObject({
      state: "APPROVED",
    });
    await expect(invoices.act(id, { type: "approve", actor: payer })).rejects.toMatchObject({
      code: "INVALID_TRANSITION",
    });
  });

  it("lets invoice parties enter explicit disputed or cancelled terminal states", async () => {
    const invoices = createInvoiceModule();
    const payer = address("0x1000000000000000000000000000000000000001");
    const payee = address("0x2000000000000000000000000000000000000002");
    const auditor = address("0x3000000000000000000000000000000000000003");
    const disputedId = invoiceId("invoice-disputed");
    const cancelledId = invoiceId("invoice-cancelled");

    for (const [id, byte] of [
      [disputedId, "9a"],
      [cancelledId, "bc"],
    ] as const) {
      await invoices.create({
        actor: payee,
        id,
        payer,
        payee,
        auditor,
        commitment: commitmentHash(`0x${byte.repeat(32)}`),
        ciphertextReference: `ciphertext/${id}`,
      });
    }

    await invoices.act(disputedId, { type: "approve", actor: payer });
    await expect(
      invoices.act(disputedId, { type: "dispute", actor: payee }),
    ).resolves.toMatchObject({ state: "DISPUTED" });
    await expect(
      invoices.act(cancelledId, { type: "cancel", actor: payer }),
    ).resolves.toMatchObject({ state: "CANCELLED" });
    await expect(
      invoices.act(cancelledId, { type: "dispute", actor: auditor }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(invoices.act(disputedId, { type: "cancel", actor: payer })).rejects.toMatchObject({
      code: "INVALID_TRANSITION",
    });
  });
});
