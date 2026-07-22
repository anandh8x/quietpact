import { address } from "@quietpact/domain";
import { describe, expect, it } from "vitest";

import {
  PUBLIC_PAYMENT_ACKNOWLEDGEMENT,
  acknowledgePublicPayment,
  createBrowserPaymentRecords,
  createInMemoryPaymentRecords,
  createSimulatedPayments,
  publicPaymentReference,
  type PublicChainPayment,
} from "../src/index.js";

const request = {
  payer: address("0x1000000000000000000000000000000000000001"),
  payee: address("0x2000000000000000000000000000000000000002"),
  amount: 25n,
};

describe("payment adapters", () => {
  it("keeps simulations permanently non-broadcast and non-payable", async () => {
    const records = createInMemoryPaymentRecords();
    const payments = createSimulatedPayments({
      records: records.simulations,
      nextId: () => "demo-001",
    });

    const result = await payments.send(request);

    expect(result).toEqual({
      kind: "SIMULATION",
      reference: "simulation:demo-001",
      classification: "SIMULATED_NOT_BROADCAST",
      status: "NOT_BROADCAST",
      canAttachToInvoice: false,
      label: "Simulation only · no payment sent",
      payer: request.payer,
      payee: request.payee,
      amount: 25n,
    });
    await expect(records.simulations.get(result.reference)).resolves.toEqual(result);
    await expect(records.publicPayments.get(result.reference as never)).resolves.toBeNull();
  });

  it("requires the exact public-payment acknowledgement", () => {
    expect(() => acknowledgePublicPayment(false)).toThrow(
      "acknowledge that the transfer is public",
    );
    expect(acknowledgePublicPayment(true)).toEqual({
      accepted: true,
      statement: PUBLIC_PAYMENT_ACKNOWLEDGEMENT,
    });
  });

  it("persists public payments separately from simulations", async () => {
    const storage = memoryStorage();
    const records = createBrowserPaymentRecords(storage);
    const payment: PublicChainPayment = {
      kind: "PUBLIC_CHAIN",
      reference: publicPaymentReference(`0x${"ab".repeat(32)}`),
      classification: "PUBLIC_ONCHAIN",
      status: "CONFIRMED_ONCHAIN",
      canAttachToInvoice: true,
      label: "Public onchain transfer · amount and parties are inspectable",
      payer: request.payer,
      payee: request.payee,
      amount: request.amount,
      blockNumber: 12n,
    };

    await records.publicPayments.put(payment);

    await expect(records.publicPayments.get(payment.reference)).resolves.toEqual(payment);
    await expect(records.simulations.get("simulation:demo-001")).resolves.toBeNull();
    expect([...storageKeys(storage)]).toEqual([`quietpact:public-payment:${payment.reference}`]);
  });
});

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value),
  };
}

function* storageKeys(storage: Storage): Iterable<string> {
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (key !== null) yield key;
  }
}
