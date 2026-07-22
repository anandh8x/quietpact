import { address, DomainError, type Address, type InvoiceState } from "@quietpact/domain";
import type { EncryptedInvoiceAction, InvoiceRecords, PublicInvoiceView } from "@quietpact/invoice";
import { zeroHash, type Hash, type PublicClient, type WalletClient } from "viem";

export const invoiceRegistryAbi = [
  {
    type: "function",
    name: "createInvoice",
    stateMutability: "nonpayable",
    inputs: [
      { name: "invoiceId", type: "bytes32" },
      { name: "payer", type: "address" },
      { name: "payee", type: "address" },
      { name: "commitment", type: "bytes32" },
      { name: "ciphertextHash", type: "bytes32" },
      { name: "auditorKeyId", type: "bytes32" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "approveInvoice",
    stateMutability: "nonpayable",
    inputs: [{ name: "invoiceId", type: "bytes32" }],
    outputs: [],
  },
  {
    type: "function",
    name: "getInvoice",
    stateMutability: "view",
    inputs: [{ name: "invoiceId", type: "bytes32" }],
    outputs: [
      {
        name: "invoice",
        type: "tuple",
        components: [
          { name: "payer", type: "address" },
          { name: "payee", type: "address" },
          { name: "commitment", type: "bytes32" },
          { name: "ciphertextHash", type: "bytes32" },
          { name: "auditorKeyId", type: "bytes32" },
          { name: "publicPaymentReference", type: "bytes32" },
          { name: "createdAt", type: "uint64" },
          { name: "state", type: "uint8" },
        ],
      },
    ],
  },
] as const;

export interface ViemInvoiceRecordsOptions {
  readonly registry: Address;
  readonly publicClient: PublicClient;
  readonly walletClientFor: (actor: Address) => WalletClient;
  readonly ciphertextReferenceFor?: (id: `0x${string}`) => string;
}

const stateByIndex: Readonly<Record<number, InvoiceState>> = {
  1: "REGISTERED",
  2: "APPROVED",
  3: "PAYMENT_REFERENCED",
  4: "COMPLETE",
  5: "DISPUTED",
  6: "CANCELLED",
};

export function createViemInvoiceRecords(options: ViemInvoiceRecordsOptions): InvoiceRecords {
  const referenceFor =
    options.ciphertextReferenceFor ?? ((id: `0x${string}`) => `invoice-envelope:${id}`);

  async function submit(
    actor: Address,
    request:
      | Readonly<{
          functionName: "createInvoice";
          args: readonly [
            `0x${string}`,
            Address,
            Address,
            `0x${string}`,
            `0x${string}`,
            `0x${string}`,
          ];
        }>
      | Readonly<{
          functionName: "approveInvoice";
          args: readonly [`0x${string}`];
        }>,
  ): Promise<void> {
    const wallet = options.walletClientFor(actor);
    if (wallet.account === undefined) {
      throw new Error("Invoice registry wallet has no account");
    }
    if (wallet.account.address.toLowerCase() !== actor) {
      throw new DomainError("UNAUTHORIZED", "The connected wallet does not match the actor");
    }

    const transaction = {
      account: wallet.account,
      address: options.registry,
      abi: invoiceRegistryAbi,
      chain: wallet.chain,
    } as const;
    const hash =
      request.functionName === "createInvoice"
        ? await wallet.writeContract({
            ...transaction,
            functionName: request.functionName,
            args: request.args,
          })
        : await wallet.writeContract({
            ...transaction,
            functionName: request.functionName,
            args: request.args,
          });
    const receipt = await options.publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") {
      throw new Error(`Invoice registry transaction reverted (${hash})`);
    }
  }

  async function view(id: `0x${string}`): Promise<PublicInvoiceView> {
    const invoice = await options.publicClient.readContract({
      address: options.registry,
      abi: invoiceRegistryAbi,
      functionName: "getInvoice",
      args: [id],
    });
    const state = stateByIndex[invoice.state];
    if (state === undefined) throw new Error(`Unknown onchain invoice state ${invoice.state}`);

    return Object.freeze({
      id,
      payer: address(invoice.payer),
      payee: address(invoice.payee),
      commitment: invoice.commitment,
      ciphertextHash: invoice.ciphertextHash,
      ciphertextReference: referenceFor(id),
      state,
      privacyLabel: "Encrypted workflow data · no private payment claim",
    });
  }

  return {
    async register(input) {
      if (input.actor !== input.payer && input.actor !== input.payee) {
        throw new DomainError("UNAUTHORIZED", "Only an invoice party can register it");
      }
      if (input.ciphertextReference !== referenceFor(input.id)) {
        throw new Error("Encrypted invoice reference does not match the chain adapter convention");
      }
      await submit(input.actor, {
        functionName: "createInvoice",
        args: [
          input.id,
          input.payer,
          input.payee,
          input.commitment,
          input.ciphertextHash,
          zeroHash,
        ],
      });
      return view(input.id);
    },
    async act(id, actor, action: EncryptedInvoiceAction) {
      const current = await view(id);
      if (action.type === "approve") {
        if (actor !== current.payer) {
          throw new DomainError("UNAUTHORIZED", "Only the payer can approve an invoice");
        }
        await submit(actor, { functionName: "approveInvoice", args: [id] });
        return view(id);
      }
      throw new Error("Unsupported invoice action");
    },
    view,
  };
}

export type InvoiceRegistryTransactionHash = Hash;
