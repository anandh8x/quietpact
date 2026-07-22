import { DomainError, type Address, type InvoiceState } from "@quietpact/domain";
import {
  canonicalize,
  type EnvelopeModule,
  type Hex32,
  type RecipientIdentity,
  type RecipientKey,
  type SealedEnvelope,
} from "@quietpact/envelope";
import { keccak256, toHex, type Hex } from "viem";

export interface InvoiceParticipant {
  readonly address: Address;
  readonly encryption: RecipientIdentity;
}

export interface InvoiceParty {
  readonly address: Address;
  readonly encryption: RecipientKey;
}

export interface CreateEncryptedInvoice<T> {
  readonly id: Hex32;
  readonly payer: InvoiceParty;
  readonly payee: InvoiceParty;
  readonly body: T;
}

export interface PublicInvoiceView {
  readonly id: Hex32;
  readonly payer: Address;
  readonly payee: Address;
  readonly commitment: Hex;
  readonly ciphertextHash: Hex;
  readonly ciphertextReference: string;
  readonly state: InvoiceState;
  readonly privacyLabel: "Encrypted workflow data · no private payment claim";
}

export interface EncryptedInvoiceView<T> {
  readonly public: PublicInvoiceView;
  readonly body: T | null;
}

export interface EncryptedInvoiceModule {
  create<T>(input: CreateEncryptedInvoice<T>): Promise<EncryptedInvoiceView<T>>;
  act<T>(id: Hex32, action: EncryptedInvoiceAction): Promise<EncryptedInvoiceView<T>>;
  view<T>(id: Hex32): Promise<EncryptedInvoiceView<T>>;
}

export type EncryptedInvoiceAction = Readonly<{ type: "approve" }>;

export interface InvoiceBlobStore {
  put(
    id: Hex32,
    envelope: SealedEnvelope,
  ): Promise<{
    reference: string;
    ciphertextHash: Hex;
  }>;
  get(reference: string): Promise<SealedEnvelope>;
}

export interface InvoiceRecords {
  register(input: {
    actor: Address;
    id: Hex32;
    payer: Address;
    payee: Address;
    commitment: Hex;
    ciphertextHash: Hex;
    ciphertextReference: string;
  }): Promise<PublicInvoiceView>;
  act(id: Hex32, actor: Address, action: EncryptedInvoiceAction): Promise<PublicInvoiceView>;
  view(id: Hex32): Promise<PublicInvoiceView>;
}

export interface InvoiceModuleDependencies {
  readonly actor: InvoiceParticipant;
  readonly chainId: bigint;
  readonly registry: `0x${string}`;
  readonly envelopes: EnvelopeModule;
  readonly blobs: InvoiceBlobStore;
  readonly records: InvoiceRecords;
}

export function createEncryptedInvoiceModule(
  dependencies: InvoiceModuleDependencies,
): EncryptedInvoiceModule {
  assertIdentity(dependencies.actor);

  return {
    async create<T>(input: CreateEncryptedInvoice<T>): Promise<EncryptedInvoiceView<T>> {
      assertParty(input.payer);
      assertParty(input.payee);

      const envelope = dependencies.envelopes.seal(
        {
          chainId: dependencies.chainId,
          registry: dependencies.registry,
          workflowId: input.id,
          payer: input.payer.address,
          payee: input.payee.address,
        },
        input.body,
        [input.payer.encryption, input.payee.encryption],
      );
      const stored = await dependencies.blobs.put(input.id, envelope);
      const publicView = await dependencies.records.register({
        actor: dependencies.actor.address,
        id: input.id,
        payer: input.payer.address,
        payee: input.payee.address,
        commitment: envelope.commitment,
        ciphertextHash: stored.ciphertextHash,
        ciphertextReference: stored.reference,
      });

      return { public: publicView, body: input.body };
    },

    async act<T>(id: Hex32, action: EncryptedInvoiceAction): Promise<EncryptedInvoiceView<T>> {
      const publicView = await dependencies.records.act(id, dependencies.actor.address, action);
      const envelope = await dependencies.blobs.get(publicView.ciphertextReference);
      const opened = dependencies.envelopes.open<T>(envelope, dependencies.actor.encryption);
      return { public: publicView, body: opened.value };
    },

    async view<T>(id: Hex32): Promise<EncryptedInvoiceView<T>> {
      const publicView = await dependencies.records.view(id);
      const envelope = await dependencies.blobs.get(publicView.ciphertextReference);
      if (
        envelope.commitment.toLowerCase() !== publicView.commitment.toLowerCase() ||
        hashEnvelope(envelope) !== publicView.ciphertextHash
      ) {
        throw new Error("Encrypted invoice does not match its public chain record");
      }

      const isRecipient = envelope.wrappedKeys.some(
        (wrapped) => wrapped.recipientId === dependencies.actor.encryption.id,
      );
      const body = isRecipient
        ? dependencies.envelopes.open<T>(envelope, dependencies.actor.encryption).value
        : null;

      return { public: publicView, body };
    },
  };
}

export function createInMemoryInvoiceAdapters(): {
  blobs: InvoiceBlobStore;
  records: InvoiceRecords;
} {
  const envelopes = new Map<string, SealedEnvelope>();
  const invoices = new Map<Hex32, PublicInvoiceView>();

  return {
    blobs: {
      put(id, envelope) {
        const reference = `encrypted-invoices/${id}`;
        envelopes.set(reference, structuredClone(envelope));
        return Promise.resolve({ reference, ciphertextHash: hashEnvelope(envelope) });
      },
      get(reference) {
        const envelope = envelopes.get(reference);
        return envelope === undefined
          ? Promise.reject(new Error("Encrypted invoice not found"))
          : Promise.resolve(structuredClone(envelope));
      },
    },
    records: {
      register(input) {
        if (input.actor !== input.payer && input.actor !== input.payee) {
          return Promise.reject(new Error("Only an invoice party can register it"));
        }
        if (invoices.has(input.id)) {
          return Promise.reject(new Error("Invoice ID is already registered"));
        }

        const view: PublicInvoiceView = Object.freeze({
          id: input.id,
          payer: input.payer,
          payee: input.payee,
          commitment: input.commitment,
          ciphertextHash: input.ciphertextHash,
          ciphertextReference: input.ciphertextReference,
          state: "REGISTERED",
          privacyLabel: "Encrypted workflow data · no private payment claim",
        });
        invoices.set(input.id, view);
        return Promise.resolve(view);
      },
      act(id, actor, action) {
        const invoice = invoices.get(id);
        if (invoice === undefined) return Promise.reject(new Error("Invoice not found"));

        if (action.type === "approve") {
          if (actor !== invoice.payer) {
            return Promise.reject(
              new DomainError("UNAUTHORIZED", "Only the payer can approve an invoice"),
            );
          }
          if (invoice.state !== "REGISTERED") {
            return Promise.reject(new Error("Invoice cannot be approved"));
          }
          const approved: PublicInvoiceView = Object.freeze({ ...invoice, state: "APPROVED" });
          invoices.set(id, approved);
          return Promise.resolve(approved);
        }

        return Promise.reject(new Error("Unsupported invoice action"));
      },
      view(id) {
        const invoice = invoices.get(id);
        return invoice === undefined
          ? Promise.reject(new Error("Invoice not found"))
          : Promise.resolve(invoice);
      },
    },
  };
}

export function createHttpInvoiceBlobStore(options: {
  readonly baseUrl: string;
  readonly headers?: () => Readonly<Record<string, string>>;
}): InvoiceBlobStore {
  const baseUrl = options.baseUrl.replace(/\/$/, "");
  const headers = () => options.headers?.() ?? {};

  return {
    async put(id, envelope) {
      const response = await fetch(`${baseUrl}/v1/invoice-envelopes/${encodeURIComponent(id)}`, {
        method: "PUT",
        credentials: "include",
        headers: { "content-type": "application/json", ...headers() },
        body: JSON.stringify({ envelope }),
      });
      if (!response.ok) throw new Error(`Encrypted invoice storage failed (${response.status})`);

      const result: unknown = await response.json();
      if (
        result === null ||
        typeof result !== "object" ||
        !("reference" in result) ||
        typeof result.reference !== "string"
      ) {
        throw new Error("Encrypted invoice storage returned an invalid response");
      }
      return { reference: result.reference, ciphertextHash: hashEnvelope(envelope) };
    },
    async get(reference) {
      const prefix = "invoice-envelope:";
      if (!reference.startsWith(prefix)) throw new Error("Invalid encrypted invoice reference");
      const id = reference.slice(prefix.length);
      const response = await fetch(`${baseUrl}/v1/invoice-envelopes/${encodeURIComponent(id)}`, {
        credentials: "include",
        headers: headers(),
      });
      if (!response.ok) throw new Error(`Encrypted invoice retrieval failed (${response.status})`);

      const result: unknown = await response.json();
      if (result === null || typeof result !== "object" || !("envelope" in result)) {
        throw new Error("Encrypted invoice retrieval returned an invalid response");
      }
      return result.envelope as SealedEnvelope;
    },
  };
}

function hashEnvelope(envelope: SealedEnvelope): Hex {
  return keccak256(toHex(canonicalize(envelope)));
}

function assertIdentity(participant: InvoiceParticipant): void {
  if (participant.encryption.id !== participant.address) {
    throw new TypeError("Actor encryption identity must use its wallet address as recipient id");
  }
}

function assertParty(party: InvoiceParty): void {
  if (party.encryption.id !== party.address) {
    throw new TypeError("Party encryption key must use its wallet address as recipient id");
  }
}
