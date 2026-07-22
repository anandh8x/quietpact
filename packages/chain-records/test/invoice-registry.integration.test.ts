import { spawn, type ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";

import { address } from "@quietpact/domain";
import { canonicalize, createEnvelopeModule, type SealedEnvelope } from "@quietpact/envelope";
import {
  createEncryptedInvoiceModule,
  type InvoiceBlobStore,
  type InvoiceParticipant,
} from "@quietpact/invoice";
import { createPublicClient, createWalletClient, http, keccak256, toHex, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createViemInvoiceRecords } from "../src/index.js";

const rpcUrl = "http://127.0.0.1:18545";
const payerAccount = privateKeyToAccount(
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
);
const payeeAccount = privateKeyToAccount(
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
);
const strangerAccount = privateKeyToAccount(
  "0x5de4111afa1c4b3daadb3f07a73be3a39dd05d084e7aa37d10b8c6b4d8c2f4b8",
);
const publicClient = createPublicClient({ chain: foundry, transport: http(rpcUrl) });
const walletFor = (account: typeof payerAccount) =>
  createWalletClient({ account, chain: foundry, transport: http(rpcUrl) });

let anvil: ChildProcess;
let registry: `0x${string}`;

beforeAll(async () => {
  anvil = spawn(process.env.ANVIL_BIN ?? "anvil", ["--silent", "--port", "18545"], {
    stdio: "ignore",
  });
  await waitForAnvil();

  const artifactUrl = new URL(
    "../../../contracts/out/InvoiceRegistry.sol/InvoiceRegistry.json",
    import.meta.url,
  );
  const artifact = JSON.parse(await readFile(artifactUrl, "utf8")) as {
    bytecode: { object: Hex };
  };
  const deploymentHash = await walletFor(payerAccount).deployContract({
    abi: [],
    bytecode: artifact.bytecode.object,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: deploymentHash });
  if (receipt.contractAddress == null) throw new Error("InvoiceRegistry deployment failed");
  registry = receipt.contractAddress;
}, 15_000);

afterAll(() => {
  anvil.kill("SIGTERM");
});

describe("Viem InvoiceRegistry adapter on Anvil", () => {
  it("registers and approves an encrypted invoice record on a real local chain", async () => {
    const wallets = new Map([
      [payerAccount.address.toLowerCase(), walletFor(payerAccount)],
      [payeeAccount.address.toLowerCase(), walletFor(payeeAccount)],
    ]);
    const records = createViemInvoiceRecords({
      registry: address(registry),
      publicClient,
      walletClientFor: (actor) => {
        const wallet = wallets.get(actor);
        if (wallet === undefined) throw new Error("No wallet for actor");
        return wallet;
      },
    });
    const id = `0x${"42".repeat(32)}` as const;
    const payer = address(payerAccount.address);
    const payee = address(payeeAccount.address);

    const registered = await records.register({
      actor: payee,
      id,
      payer,
      payee,
      commitment: `0x${"11".repeat(32)}`,
      ciphertextHash: `0x${"22".repeat(32)}`,
      ciphertextReference: `invoice-envelope:${id}`,
    });
    const approved = await records.act(id, payer, { type: "approve" });

    expect(registered).toMatchObject({
      id,
      payer,
      payee,
      state: "REGISTERED",
      ciphertextReference: `invoice-envelope:${id}`,
    });
    expect(approved.state).toBe("APPROVED");
    await expect(records.view(id)).resolves.toMatchObject({ state: "APPROVED" });
  });

  it("rejects an actor whose connected wallet does not match", async () => {
    const records = createViemInvoiceRecords({
      registry: address(registry),
      publicClient,
      walletClientFor: () => walletFor(strangerAccount),
    });

    await expect(
      records.register({
        actor: address(payeeAccount.address),
        id: `0x${"43".repeat(32)}`,
        payer: address(payerAccount.address),
        payee: address(payeeAccount.address),
        commitment: `0x${"33".repeat(32)}`,
        ciphertextHash: `0x${"44".repeat(32)}`,
        ciphertextReference: `invoice-envelope:0x${"43".repeat(32)}`,
      }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("runs the encrypted create, reopen, and approval flow across two wallets", async () => {
    const envelopes = await createEnvelopeModule();
    const payerAddress = address(payerAccount.address);
    const payeeAddress = address(payeeAccount.address);
    const payer: InvoiceParticipant = {
      address: payerAddress,
      encryption: envelopes.generateRecipientKeyPair(payerAddress),
    };
    const payee: InvoiceParticipant = {
      address: payeeAddress,
      encryption: envelopes.generateRecipientKeyPair(payeeAddress),
    };
    const wallets = new Map([
      [payerAddress, walletFor(payerAccount)],
      [payeeAddress, walletFor(payeeAccount)],
    ]);
    const records = createViemInvoiceRecords({
      registry: address(registry),
      publicClient,
      walletClientFor: (actor) => {
        const wallet = wallets.get(actor);
        if (wallet === undefined) throw new Error("No wallet for actor");
        return wallet;
      },
    });
    const stored = new Map<string, SealedEnvelope>();
    const blobs: InvoiceBlobStore = {
      put(id, envelope) {
        const reference = `invoice-envelope:${id}`;
        stored.set(reference, structuredClone(envelope));
        return Promise.resolve({
          reference,
          ciphertextHash: keccak256(toHex(canonicalize(envelope))),
        });
      },
      get(reference) {
        const envelope = stored.get(reference);
        return envelope === undefined
          ? Promise.reject(new Error("Envelope not found"))
          : Promise.resolve(structuredClone(envelope));
      },
    };
    const moduleFor = (actor: InvoiceParticipant) =>
      createEncryptedInvoiceModule({
        actor,
        chainId: 31_337n,
        registry: address(registry),
        envelopes,
        records,
        blobs,
      });
    const id = `0x${"45".repeat(32)}` as const;
    const body = { amount: "625.00", currency: "USDC", memo: "LIVE_CHAIN_PRIVATE_42" };

    await moduleFor(payee).create({ id, payer, payee, body });
    const reopened = await moduleFor(payer).view<typeof body>(id);
    const approved = await moduleFor(payer).act<typeof body>(id, { type: "approve" });

    expect(reopened.body).toEqual(body);
    expect(approved).toMatchObject({ public: { state: "APPROVED" }, body });
    expect(JSON.stringify(approved.public)).not.toContain("LIVE_CHAIN_PRIVATE_42");
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
