import { describe, expect, it } from "vitest";

import {
  createEnvelopeModule,
  EnvelopeError,
  type CommitmentContext,
  type EnvelopeErrorCode,
  type SealedEnvelope,
} from "../src/index.js";

const context: CommitmentContext = {
  chainId: 5042002n,
  registry: "0x1111111111111111111111111111111111111111",
  workflowId: `0x${"22".repeat(32)}`,
  payer: "0x3333333333333333333333333333333333333333",
  payee: "0x4444444444444444444444444444444444444444",
};

function expectEnvelopeError(action: () => unknown, code: EnvelopeErrorCode): void {
  try {
    action();
    expect.fail(`Expected EnvelopeError with code ${code}`);
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(EnvelopeError);
    if (!(error instanceof EnvelopeError)) throw error;
    expect(error.code).toBe(code);
  }
}

describe("sealed envelopes", () => {
  it("round-trips for every authorized recipient without exposing plaintext", async () => {
    const envelopes = await createEnvelopeModule();
    const payer = envelopes.generateRecipientKeyPair("payer");
    const payee = envelopes.generateRecipientKeyPair("payee");
    const auditor = envelopes.generateRecipientKeyPair("auditor");
    const invoice = {
      amount: "1250.00",
      currency: "USDC",
      memo: "CANARY_PRIVATE_INVOICE_7c94",
    };

    const sealed = envelopes.seal(context, invoice, [payer, payee, auditor]);

    for (const recipient of [payer, payee, auditor]) {
      const opened = envelopes.open<typeof invoice>(sealed, recipient);
      expect(opened.value).toEqual(invoice);
      expect(opened.salt).toMatch(/^0x[0-9a-f]{64}$/);
      expect(envelopes.verify(context, opened.value, opened.salt, sealed.commitment)).toBe(true);
    }

    expect(JSON.stringify(sealed)).not.toContain("CANARY_PRIVATE_INVOICE_7c94");
    expect(sealed.context.chainId).toBe("5042002");
  });

  it("rejects recipients that were not authorized", async () => {
    const envelopes = await createEnvelopeModule();
    const payee = envelopes.generateRecipientKeyPair("payee");
    const stranger = envelopes.generateRecipientKeyPair("stranger");
    const sealed = envelopes.seal(context, { amount: "1.00" }, [payee]);

    expectEnvelopeError(() => envelopes.open(sealed, stranger), "RECIPIENT_NOT_AUTHORIZED");

    const impostor = envelopes.generateRecipientKeyPair("payee");
    expectEnvelopeError(() => envelopes.open(sealed, impostor), "DECRYPTION_FAILED");
  });

  it("round-trips randomized payloads and produces fresh ciphertext", async () => {
    const envelopes = await createEnvelopeModule();
    const recipient = envelopes.generateRecipientKeyPair("recipient");
    const commitments = new Set<string>();

    for (let index = 0; index < 25; index += 1) {
      const value = { index, nested: { enabled: index % 2 === 0 }, tags: ["private", `${index}`] };
      const sealed = envelopes.seal(context, value, [recipient]);
      expect(envelopes.open<typeof value>(sealed, recipient).value).toEqual(value);
      commitments.add(sealed.commitment);
    }

    expect(commitments.size).toBe(25);
  });

  it("rejects empty and duplicate recipient lists", async () => {
    const envelopes = await createEnvelopeModule();
    const payee = envelopes.generateRecipientKeyPair("payee");

    expect(() => envelopes.seal(context, { amount: "1.00" }, [])).toThrow("At least one recipient");
    expect(() => envelopes.seal(context, { amount: "1.00" }, [payee, payee])).toThrow(
      "Duplicate recipient",
    );
  });

  it("detects ciphertext and public-context tampering", async () => {
    const envelopes = await createEnvelopeModule();
    const payee = envelopes.generateRecipientKeyPair("payee");
    const sealed = envelopes.seal(context, { amount: "1.00" }, [payee]);
    const corrupt = (value: string) => `${value.slice(0, -2)}AA`;

    const tamperedCiphertext: SealedEnvelope = {
      ...sealed,
      ciphertext: corrupt(sealed.ciphertext),
    };
    expectEnvelopeError(() => envelopes.open(tamperedCiphertext, payee), "DECRYPTION_FAILED");

    const tamperedContext: SealedEnvelope = {
      ...sealed,
      context: { ...sealed.context, chainId: "5042003" },
    };
    expectEnvelopeError(() => envelopes.open(tamperedContext, payee), "DECRYPTION_FAILED");

    const auditor = envelopes.generateRecipientKeyPair("auditor");
    const shared = envelopes.seal(context, { amount: "1.00" }, [payee, auditor]);
    const strippedRecipient: SealedEnvelope = { ...shared, wrappedKeys: [shared.wrappedKeys[0]!] };
    expectEnvelopeError(() => envelopes.open(strippedRecipient, payee), "DECRYPTION_FAILED");
  });

  it("does not verify against a different workflow context", async () => {
    const envelopes = await createEnvelopeModule();
    const payee = envelopes.generateRecipientKeyPair("payee");
    const value = { amount: "1.00" };
    const sealed = envelopes.seal(context, value, [payee]);
    const opened = envelopes.open(sealed, payee);

    expect(
      envelopes.verify(
        { ...context, workflowId: `0x${"99".repeat(32)}` },
        opened.value,
        opened.salt,
        sealed.commitment,
      ),
    ).toBe(false);
  });
});
