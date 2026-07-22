type Brand<Value, Name extends string> = Value & { readonly __brand: Name };

export type DomainErrorCode =
  | "ALREADY_EXISTS"
  | "BIDDING_CLOSED"
  | "BIDDING_NOT_OPEN"
  | "COMMITMENT_MISMATCH"
  | "DUPLICATE_ACTION"
  | "INVALID_INPUT"
  | "INVALID_TRANSITION"
  | "NO_COMMITMENT"
  | "NOT_FOUND"
  | "REVEAL_CLOSED"
  | "REVEAL_NOT_OPEN"
  | "UNAUTHORIZED";

export class DomainError extends Error {
  readonly code: DomainErrorCode;

  constructor(code: DomainErrorCode, message: string) {
    super(message);
    this.name = "DomainError";
    this.code = code;
  }
}

export type Address = Brand<`0x${string}`, "Address">;
export type CommitmentHash = Brand<`0x${string}`, "CommitmentHash">;
export type InvoiceId = Brand<string, "InvoiceId">;
export type TransactionReference = Brand<`0x${string}`, "TransactionReference">;
export type AuctionId = Brand<string, "AuctionId">;
export type UnixTimestamp = Brand<number, "UnixTimestamp">;
export type SecretSalt = Brand<`0x${string}`, "SecretSalt">;

export function address(value: string): Address {
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw new Error("Address must be a 20-byte hexadecimal value");
  }

  return value.toLowerCase() as Address;
}

export function commitmentHash(value: string): CommitmentHash {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error("Commitment hash must be a 32-byte hexadecimal value");
  }

  return value.toLowerCase() as CommitmentHash;
}

export function invoiceId(value: string): InvoiceId {
  if (value.trim().length === 0) {
    throw new Error("Invoice ID cannot be empty");
  }

  return value as InvoiceId;
}

export function transactionReference(value: string): TransactionReference {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error("Transaction reference must be a 32-byte hexadecimal value");
  }

  return value.toLowerCase() as TransactionReference;
}

export function auctionId(value: string): AuctionId {
  if (value.trim().length === 0) {
    throw new Error("Auction ID cannot be empty");
  }

  return value as AuctionId;
}

export function unixTimestamp(value: number): UnixTimestamp {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("Unix timestamp must be a non-negative safe integer");
  }

  return value as UnixTimestamp;
}

export function secretSalt(value: string): SecretSalt {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error("Secret salt must be a 32-byte hexadecimal value");
  }

  return value.toLowerCase() as SecretSalt;
}

export type PrivacyClassification =
  "PUBLIC_ONCHAIN" | "SIMULATED_NOT_BROADCAST" | "CONFIDENTIAL_ONCHAIN";

export type InvoiceState =
  "REGISTERED" | "APPROVED" | "PAYMENT_REFERENCED" | "COMPLETE" | "DISPUTED" | "CANCELLED";

export type InvoiceAction =
  | Readonly<{ type: "approve"; actor: Address }>
  | Readonly<{
      type: "attachPublicPayment";
      actor: Address;
      reference: TransactionReference;
    }>
  | Readonly<{ type: "complete"; actor: Address }>
  | Readonly<{ type: "dispute"; actor: Address }>
  | Readonly<{ type: "cancel"; actor: Address }>;

export type PublicPaymentView = Readonly<{
  reference: TransactionReference;
  classification: "PUBLIC_ONCHAIN";
  label: "Public onchain payment · amount and parties are inspectable";
}>;

export type CreateInvoice = Readonly<{
  actor: Address;
  id: InvoiceId;
  payer: Address;
  payee: Address;
  auditor?: Address;
  commitment: CommitmentHash;
  ciphertextReference: string;
}>;

export type InvoiceView = Readonly<{
  id: InvoiceId;
  payer: Address;
  payee: Address;
  commitment: CommitmentHash;
  ciphertextReference: string;
  state: InvoiceState;
  privacyLabel: "Encrypted workflow data · no private payment claim";
  payment: PublicPaymentView | null;
}>;

export type InvoiceModule = {
  create(input: CreateInvoice): Promise<InvoiceView>;
  act(id: InvoiceId, action: InvoiceAction): Promise<InvoiceView>;
  view(id: InvoiceId): Promise<InvoiceView>;
};

export function createInvoiceModule(): InvoiceModule {
  const invoices = new Map<InvoiceId, InvoiceView>();

  return {
    async create(input) {
      if (input.actor !== input.payer && input.actor !== input.payee) {
        throw new DomainError("UNAUTHORIZED", "Only an invoice party can register it");
      }
      if (invoices.has(input.id)) {
        throw new DomainError("ALREADY_EXISTS", "Invoice ID is already registered");
      }

      const view: InvoiceView = Object.freeze({
        id: input.id,
        payer: input.payer,
        payee: input.payee,
        commitment: input.commitment,
        ciphertextReference: input.ciphertextReference,
        state: "REGISTERED",
        privacyLabel: "Encrypted workflow data · no private payment claim",
        payment: null,
      });

      invoices.set(input.id, view);
      return view;
    },
    async view(id) {
      return requireInvoice(invoices, id);
    },
    async act(id, action) {
      const current = requireInvoice(invoices, id);
      let next: InvoiceView;

      switch (action.type) {
        case "approve": {
          requireActor(action.actor, current.payer, "Only the payer can approve an invoice");
          requireState(current, "REGISTERED", action.type);
          next = Object.freeze({ ...current, state: "APPROVED" });
          break;
        }
        case "attachPublicPayment": {
          requireActor(
            action.actor,
            current.payer,
            "Only the payer can attach a public payment reference",
          );
          requireState(current, "APPROVED", action.type);
          next = Object.freeze({
            ...current,
            state: "PAYMENT_REFERENCED",
            payment: Object.freeze({
              reference: action.reference,
              classification: "PUBLIC_ONCHAIN",
              label: "Public onchain payment · amount and parties are inspectable",
            }),
          });
          break;
        }
        case "complete": {
          requireActor(action.actor, current.payee, "Only the payee can complete the workflow");
          requireState(current, "PAYMENT_REFERENCED", action.type);
          next = Object.freeze({ ...current, state: "COMPLETE" });
          break;
        }
        case "dispute": {
          requireParty(action.actor, current);
          if (
            current.state !== "REGISTERED" &&
            current.state !== "APPROVED" &&
            current.state !== "PAYMENT_REFERENCED"
          ) {
            throw invalidTransition(current, action.type);
          }
          next = Object.freeze({ ...current, state: "DISPUTED" });
          break;
        }
        case "cancel": {
          requireParty(action.actor, current);
          if (current.state !== "REGISTERED" && current.state !== "APPROVED") {
            throw invalidTransition(current, action.type);
          }
          next = Object.freeze({ ...current, state: "CANCELLED" });
          break;
        }
      }

      invoices.set(id, next);
      return next;
    },
  };
}

function requireInvoice(invoices: ReadonlyMap<InvoiceId, InvoiceView>, id: InvoiceId): InvoiceView {
  const invoice = invoices.get(id);
  if (!invoice) {
    throw new DomainError("NOT_FOUND", "Invoice not found");
  }

  return invoice;
}

function requireActor(actor: Address, expected: Address, message: string): void {
  if (actor !== expected) {
    throw new DomainError("UNAUTHORIZED", message);
  }
}

function requireState(invoice: InvoiceView, expected: InvoiceState, action: string): void {
  if (invoice.state !== expected) {
    throw invalidTransition(invoice, action);
  }
}

function requireParty(actor: Address, invoice: InvoiceView): void {
  if (actor !== invoice.payer && actor !== invoice.payee) {
    throw new DomainError("UNAUTHORIZED", "Only an invoice party can perform this action");
  }
}

function invalidTransition(invoice: InvoiceView, action: string): DomainError {
  return new DomainError(
    "INVALID_TRANSITION",
    `Cannot ${action} an invoice in ${invoice.state} state`,
  );
}

export type AuctionState =
  "SCHEDULED" | "COMMIT_OPEN" | "REVEAL_OPEN" | "FINALIZABLE" | "FINALIZED";

export type CreateAuction = Readonly<{
  actor: Address;
  id: AuctionId;
  owner: Address;
  commitOpensAt: UnixTimestamp;
  revealOpensAt: UnixTimestamp;
  revealClosesAt: UnixTimestamp;
  fixedBond: bigint;
}>;

export type AuctionView = Readonly<{
  id: AuctionId;
  owner: Address;
  state: AuctionState;
  commitOpensAt: UnixTimestamp;
  revealOpensAt: UnixTimestamp;
  revealClosesAt: UnixTimestamp;
  fixedBond: bigint;
  bids: readonly AuctionBidView[];
  winner: AuctionWinnerView | null;
}>;

export type AuctionWinnerView = Readonly<{ bidder: Address; amount: bigint }>;

export type AuctionBidView =
  | Readonly<{
      bidder: Address;
      status: "COMMITTED";
      visibility: "HIDDEN_UNTIL_REVEAL";
    }>
  | Readonly<{
      bidder: Address;
      status: "REVEALED";
      visibility: "PUBLIC_AFTER_REVEAL";
      amount: bigint;
    }>;

export type AuctionAction =
  | Readonly<{
      type: "commitBid";
      actor: Address;
      commitment: CommitmentHash;
    }>
  | Readonly<{
      type: "revealBid";
      actor: Address;
      amount: bigint;
      salt: SecretSalt;
    }>
  | Readonly<{ type: "finalize"; actor: Address }>;

export type ProcurementModule = {
  create(input: CreateAuction): Promise<AuctionView>;
  act(id: AuctionId, action: AuctionAction): Promise<AuctionView>;
  view(id: AuctionId): Promise<AuctionView>;
};

type AuctionRecord = Omit<CreateAuction, "actor"> & {
  bids: Map<Address, Readonly<{ commitment: CommitmentHash; amount?: bigint }>>;
  finalized: boolean;
  winner: AuctionWinnerView | null;
};

export function createProcurementModule(dependencies: {
  now: () => UnixTimestamp;
  verifyOpening?: (input: {
    bidder: Address;
    commitment: CommitmentHash;
    amount: bigint;
    salt: SecretSalt;
  }) => boolean;
}): ProcurementModule {
  const auctions = new Map<AuctionId, AuctionRecord>();

  const toView = (auction: AuctionRecord): AuctionView => {
    const now = dependencies.now();
    const state: AuctionState = auction.finalized
      ? "FINALIZED"
      : now < auction.commitOpensAt
        ? "SCHEDULED"
        : now < auction.revealOpensAt
          ? "COMMIT_OPEN"
          : now < auction.revealClosesAt
            ? "REVEAL_OPEN"
            : "FINALIZABLE";

    const bids = [...auction.bids.entries()].map(([bidder, bid]): AuctionBidView => {
      if (bid.amount !== undefined) {
        return Object.freeze({
          bidder,
          status: "REVEALED",
          visibility: "PUBLIC_AFTER_REVEAL",
          amount: bid.amount,
        });
      }

      return Object.freeze({
        bidder,
        status: "COMMITTED",
        visibility: "HIDDEN_UNTIL_REVEAL",
      });
    });

    return Object.freeze({
      id: auction.id,
      owner: auction.owner,
      commitOpensAt: auction.commitOpensAt,
      revealOpensAt: auction.revealOpensAt,
      revealClosesAt: auction.revealClosesAt,
      fixedBond: auction.fixedBond,
      state,
      bids,
      winner: auction.winner,
    });
  };

  return {
    async create(input) {
      if (input.actor !== input.owner) {
        throw new DomainError("UNAUTHORIZED", "Only the auction owner can create it");
      }
      if (
        input.commitOpensAt >= input.revealOpensAt ||
        input.revealOpensAt >= input.revealClosesAt
      ) {
        throw new DomainError("INVALID_INPUT", "Auction windows must be ordered and non-empty");
      }
      if (input.fixedBond < 0n) {
        throw new DomainError("INVALID_INPUT", "The fixed bond cannot be negative");
      }
      if (auctions.has(input.id)) {
        throw new DomainError("ALREADY_EXISTS", "Auction ID is already registered");
      }

      const record: AuctionRecord = {
        id: input.id,
        owner: input.owner,
        commitOpensAt: input.commitOpensAt,
        revealOpensAt: input.revealOpensAt,
        revealClosesAt: input.revealClosesAt,
        fixedBond: input.fixedBond,
        bids: new Map(),
        finalized: false,
        winner: null,
      };
      auctions.set(input.id, record);
      return toView(record);
    },
    async act(id, action) {
      const auction = auctions.get(id);
      if (!auction) {
        throw new DomainError("NOT_FOUND", "Auction not found");
      }

      const now = dependencies.now();
      if (action.type === "finalize") {
        if (action.actor !== auction.owner) {
          throw new DomainError("UNAUTHORIZED", "Only the auction owner can finalize it");
        }
        if (now < auction.revealClosesAt) {
          throw new DomainError("INVALID_TRANSITION", "The reveal window is still open");
        }
        if (auction.finalized) {
          throw new DomainError("DUPLICATE_ACTION", "The auction is already finalized");
        }

        const revealed = [...auction.bids.entries()].flatMap(([bidder, bid]) =>
          bid.amount === undefined ? [] : [{ bidder, amount: bid.amount }],
        );
        revealed.sort((left, right) => {
          if (left.amount !== right.amount) {
            return left.amount < right.amount ? -1 : 1;
          }
          return left.bidder.localeCompare(right.bidder);
        });
        const winningBid = revealed[0];
        auction.winner = winningBid ? Object.freeze(winningBid) : null;
        auction.finalized = true;
        return toView(auction);
      }

      if (action.type === "commitBid") {
        if (now < auction.commitOpensAt) {
          throw new DomainError("BIDDING_NOT_OPEN", "The bidding window has not opened");
        }
        if (now >= auction.revealOpensAt) {
          throw new DomainError("BIDDING_CLOSED", "The bidding window is closed");
        }
        if (auction.bids.has(action.actor)) {
          throw new DomainError("DUPLICATE_ACTION", "The bidder already committed a bid");
        }

        auction.bids.set(action.actor, Object.freeze({ commitment: action.commitment }));
        return toView(auction);
      }

      if (now < auction.revealOpensAt) {
        throw new DomainError("REVEAL_NOT_OPEN", "The reveal window has not opened");
      }
      if (now >= auction.revealClosesAt) {
        throw new DomainError("REVEAL_CLOSED", "The reveal window is closed");
      }
      if (action.amount <= 0n) {
        throw new DomainError("INVALID_INPUT", "A revealed bid must be greater than zero");
      }

      const committed = auction.bids.get(action.actor);
      if (!committed) {
        throw new DomainError("NO_COMMITMENT", "The bidder has no committed bid");
      }
      if (committed.amount !== undefined) {
        throw new DomainError("DUPLICATE_ACTION", "The bidder already revealed their bid");
      }
      if (
        !dependencies.verifyOpening?.({
          bidder: action.actor,
          commitment: committed.commitment,
          amount: action.amount,
          salt: action.salt,
        })
      ) {
        throw new DomainError("COMMITMENT_MISMATCH", "The bid opening is invalid");
      }

      auction.bids.set(
        action.actor,
        Object.freeze({ commitment: committed.commitment, amount: action.amount }),
      );
      return toView(auction);
    },
    async view(id) {
      const auction = auctions.get(id);
      if (!auction) {
        throw new DomainError("NOT_FOUND", "Auction not found");
      }

      return toView(auction);
    },
  };
}
