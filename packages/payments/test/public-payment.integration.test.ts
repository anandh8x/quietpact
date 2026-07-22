import { spawn, type ChildProcess } from "node:child_process";

import { address } from "@quietpact/domain";
import { createPublicClient, createWalletClient, http, parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  acknowledgePublicPayment,
  createInMemoryPaymentRecords,
  createViemPublicPayments,
} from "../src/index.js";

const rpcUrl = "http://127.0.0.1:18549";
const payerAccount = privateKeyToAccount(
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
);
const payeeAccount = privateKeyToAccount(
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
);
const publicClient = createPublicClient({ chain: foundry, transport: http(rpcUrl) });
const walletClient = createWalletClient({
  account: payerAccount,
  chain: foundry,
  transport: http(rpcUrl),
});
let anvil: ChildProcess;

beforeAll(async () => {
  anvil = spawn(process.env.ANVIL_BIN ?? "anvil", ["--silent", "--port", "18549"], {
    stdio: "ignore",
  });
  await waitForAnvil();
}, 15_000);

afterAll(() => {
  anvil.kill("SIGTERM");
});

describe("Viem public payment adapter on Anvil", () => {
  it("requires acknowledgement, confirms a public transfer, and records its real hash", async () => {
    const records = createInMemoryPaymentRecords();
    const payments = createViemPublicPayments({
      publicClient,
      walletClientFor: () => walletClient,
      records: records.publicPayments,
    });
    const request = {
      payer: address(payerAccount.address),
      payee: address(payeeAccount.address),
      amount: parseEther("1"),
    };
    const payeeBefore = await publicClient.getBalance({ address: payeeAccount.address });

    await expect(payments.send(request, null as never)).rejects.toThrow(
      "Explicit public-payment acknowledgement is required",
    );
    const result = await payments.send(request, acknowledgePublicPayment(true));

    expect(result).toMatchObject({
      kind: "PUBLIC_CHAIN",
      classification: "PUBLIC_ONCHAIN",
      status: "CONFIRMED_ONCHAIN",
      canAttachToInvoice: true,
      payer: request.payer,
      payee: request.payee,
      amount: request.amount,
    });
    expect(result.reference).toMatch(/^0x[0-9a-f]{64}$/);
    await expect(publicClient.getBalance({ address: payeeAccount.address })).resolves.toBe(
      payeeBefore + request.amount,
    );
    await expect(records.publicPayments.get(result.reference)).resolves.toEqual(result);
  });
});

async function waitForAnvil(): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (anvil.exitCode !== null) throw new Error("Anvil exited before accepting connections");
    try {
      await publicClient.getChainId();
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error("Timed out waiting for Anvil");
}
