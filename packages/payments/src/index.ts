import { DomainError, type Address } from "@quietpact/domain";
import type { Hash, PublicClient, WalletClient } from "viem";

export const PUBLIC_PAYMENT_ACKNOWLEDGEMENT =
  "I understand this transfer's amount, sender, recipient, and transaction are public onchain.";

export type SimulationReference = `simulation:${string}`;
export type PublicPaymentReference = Hash & { readonly __brand: "PublicPaymentReference" };

export interface PaymentRequest {
  readonly payer: Address;
  readonly payee: Address;
  readonly amount: bigint;
}

export interface PublicityAcknowledgement {
  readonly accepted: true;
  readonly statement: typeof PUBLIC_PAYMENT_ACKNOWLEDGEMENT;
}

export interface SimulatedPayment {
  readonly kind: "SIMULATION";
  readonly reference: SimulationReference;
  readonly classification: "SIMULATED_NOT_BROADCAST";
  readonly status: "NOT_BROADCAST";
  readonly canAttachToInvoice: false;
  readonly label: "Simulation only · no payment sent";
  readonly payer: Address;
  readonly payee: Address;
  readonly amount: bigint;
}

export interface PublicChainPayment {
  readonly kind: "PUBLIC_CHAIN";
  readonly reference: PublicPaymentReference;
  readonly classification: "PUBLIC_ONCHAIN";
  readonly status: "CONFIRMED_ONCHAIN";
  readonly canAttachToInvoice: true;
  readonly label: "Public onchain transfer · amount and parties are inspectable";
  readonly payer: Address;
  readonly payee: Address;
  readonly amount: bigint;
  readonly blockNumber: bigint;
}

export interface SimulationRecords {
  put(payment: SimulatedPayment): Promise<void>;
  get(reference: SimulationReference): Promise<SimulatedPayment | null>;
}

export interface PublicPaymentRecords {
  put(payment: PublicChainPayment): Promise<void>;
  get(reference: PublicPaymentReference): Promise<PublicChainPayment | null>;
}

export interface SimulatedPayments {
  send(request: PaymentRequest): Promise<SimulatedPayment>;
}

export interface PublicPayments {
  send(
    request: PaymentRequest,
    acknowledgement: PublicityAcknowledgement,
  ): Promise<PublicChainPayment>;
}

export function acknowledgePublicPayment(accepted: boolean): PublicityAcknowledgement {
  if (!accepted) throw new Error("You must acknowledge that the transfer is public onchain");
  return Object.freeze({ accepted: true, statement: PUBLIC_PAYMENT_ACKNOWLEDGEMENT });
}

export function publicPaymentReference(value: Hash): PublicPaymentReference {
  return value as PublicPaymentReference;
}

export function createSimulatedPayments(options: {
  readonly records: SimulationRecords;
  readonly nextId?: () => string;
}): SimulatedPayments {
  return {
    async send(request) {
      validateRequest(request);
      const id = (options.nextId ?? (() => crypto.randomUUID()))();
      if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error("Simulation identifier is invalid");
      const payment: SimulatedPayment = Object.freeze({
        kind: "SIMULATION",
        reference: `simulation:${id}`,
        classification: "SIMULATED_NOT_BROADCAST",
        status: "NOT_BROADCAST",
        canAttachToInvoice: false,
        label: "Simulation only · no payment sent",
        payer: request.payer,
        payee: request.payee,
        amount: request.amount,
      });
      await options.records.put(payment);
      return payment;
    },
  };
}

export function createViemPublicPayments(options: {
  readonly publicClient: PublicClient;
  readonly walletClientFor: (payer: Address) => WalletClient;
  readonly records: PublicPaymentRecords;
}): PublicPayments {
  return {
    async send(request, acknowledgement) {
      validateRequest(request);
      if (
        acknowledgement?.accepted !== true ||
        acknowledgement.statement !== PUBLIC_PAYMENT_ACKNOWLEDGEMENT
      ) {
        throw new Error("Explicit public-payment acknowledgement is required");
      }
      const wallet = options.walletClientFor(request.payer);
      if (wallet.account === undefined) throw new Error("Payment wallet has no account");
      if (wallet.account.address.toLowerCase() !== request.payer) {
        throw new DomainError("UNAUTHORIZED", "The connected wallet does not match the payer");
      }

      const transactionHash = await wallet.sendTransaction({
        account: wallet.account,
        chain: wallet.chain,
        to: request.payee,
        value: request.amount,
      });
      const receipt = await options.publicClient.waitForTransactionReceipt({
        hash: transactionHash,
      });
      if (receipt.status !== "success") {
        throw new Error(`Public transfer reverted (${transactionHash})`);
      }
      const reference = publicPaymentReference(transactionHash);
      const payment: PublicChainPayment = Object.freeze({
        kind: "PUBLIC_CHAIN",
        reference,
        classification: "PUBLIC_ONCHAIN",
        status: "CONFIRMED_ONCHAIN",
        canAttachToInvoice: true,
        label: "Public onchain transfer · amount and parties are inspectable",
        payer: request.payer,
        payee: request.payee,
        amount: request.amount,
        blockNumber: receipt.blockNumber,
      });
      await options.records.put(payment);
      return payment;
    },
  };
}

export function createInMemoryPaymentRecords(): {
  readonly simulations: SimulationRecords;
  readonly publicPayments: PublicPaymentRecords;
} {
  const simulations = new Map<SimulationReference, SimulatedPayment>();
  const publicPayments = new Map<PublicPaymentReference, PublicChainPayment>();
  return {
    simulations: {
      put(payment) {
        simulations.set(payment.reference, payment);
        return Promise.resolve();
      },
      get(reference) {
        return Promise.resolve(simulations.get(reference) ?? null);
      },
    },
    publicPayments: {
      put(payment) {
        publicPayments.set(payment.reference, payment);
        return Promise.resolve();
      },
      get(reference) {
        return Promise.resolve(publicPayments.get(reference) ?? null);
      },
    },
  };
}

export function createBrowserPaymentRecords(storage: Storage): {
  readonly simulations: SimulationRecords;
  readonly publicPayments: PublicPaymentRecords;
} {
  return {
    simulations: {
      put(payment) {
        storage.setItem(`quietpact:simulation:${payment.reference}`, serialize(payment));
        return Promise.resolve();
      },
      get(reference) {
        const value = storage.getItem(`quietpact:simulation:${reference}`);
        return Promise.resolve(value === null ? null : parseSimulation(value));
      },
    },
    publicPayments: {
      put(payment) {
        storage.setItem(`quietpact:public-payment:${payment.reference}`, serialize(payment));
        return Promise.resolve();
      },
      get(reference) {
        const value = storage.getItem(`quietpact:public-payment:${reference}`);
        return Promise.resolve(value === null ? null : parsePublicPayment(value));
      },
    },
  };
}

function validateRequest(request: PaymentRequest): void {
  if (request.payer === request.payee) throw new Error("Payer and payee must be different wallets");
  if (request.amount <= 0n) throw new Error("Payment amount must be greater than zero");
}

function serialize(payment: SimulatedPayment | PublicChainPayment): string {
  return JSON.stringify(payment, (_, value: unknown) =>
    typeof value === "bigint" ? value.toString() : value,
  );
}

function parseSimulation(value: string): SimulatedPayment {
  const parsed = JSON.parse(value) as Record<string, unknown>;
  if (
    parsed.kind !== "SIMULATION" ||
    parsed.classification !== "SIMULATED_NOT_BROADCAST" ||
    parsed.status !== "NOT_BROADCAST" ||
    parsed.canAttachToInvoice !== false ||
    typeof parsed.reference !== "string" ||
    !parsed.reference.startsWith("simulation:") ||
    typeof parsed.amount !== "string"
  ) {
    throw new Error("Stored simulation is invalid");
  }
  return Object.freeze({
    ...parsed,
    amount: BigInt(parsed.amount),
  }) as unknown as SimulatedPayment;
}

function parsePublicPayment(value: string): PublicChainPayment {
  const parsed = JSON.parse(value) as Record<string, unknown>;
  if (
    parsed.kind !== "PUBLIC_CHAIN" ||
    parsed.classification !== "PUBLIC_ONCHAIN" ||
    parsed.status !== "CONFIRMED_ONCHAIN" ||
    parsed.canAttachToInvoice !== true ||
    typeof parsed.reference !== "string" ||
    !/^0x[0-9a-fA-F]{64}$/.test(parsed.reference) ||
    typeof parsed.amount !== "string" ||
    typeof parsed.blockNumber !== "string"
  ) {
    throw new Error("Stored public payment is invalid");
  }
  return Object.freeze({
    ...parsed,
    amount: BigInt(parsed.amount),
    blockNumber: BigInt(parsed.blockNumber),
  }) as unknown as PublicChainPayment;
}
