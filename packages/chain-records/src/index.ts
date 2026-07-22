import {
  address,
  commitmentHash,
  DomainError,
  type Address,
  type CommitmentHash,
  type InvoiceState,
  type SecretSalt,
} from "@quietpact/domain";
import type { EncryptedInvoiceAction, InvoiceRecords, PublicInvoiceView } from "@quietpact/invoice";
import {
  encodeAbiParameters,
  keccak256,
  zeroAddress,
  zeroHash,
  type Hash,
  type PublicClient,
  type WalletClient,
} from "viem";

export const invoiceCreatedEvent = {
  type: "event",
  name: "InvoiceCreated",
  inputs: [
    { name: "invoiceId", type: "bytes32", indexed: true },
    { name: "payer", type: "address", indexed: true },
    { name: "payee", type: "address", indexed: true },
    { name: "commitment", type: "bytes32", indexed: false },
    { name: "ciphertextHash", type: "bytes32", indexed: false },
    { name: "auditorKeyId", type: "bytes32", indexed: false },
  ],
  anonymous: false,
} as const;

export const invoiceStateChangedEvent = {
  type: "event",
  name: "InvoiceStateChanged",
  inputs: [
    { name: "invoiceId", type: "bytes32", indexed: true },
    { name: "state", type: "uint8", indexed: false },
  ],
  anonymous: false,
} as const;

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
  invoiceCreatedEvent,
  invoiceStateChangedEvent,
] as const;

export const sealedBidAuctionAbi = [
  {
    type: "function",
    name: "createAuction",
    stateMutability: "nonpayable",
    inputs: [
      { name: "auctionId", type: "bytes32" },
      { name: "commitOpensAt", type: "uint64" },
      { name: "revealOpensAt", type: "uint64" },
      { name: "revealClosesAt", type: "uint64" },
      { name: "bond", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "commitBid",
    stateMutability: "payable",
    inputs: [
      { name: "auctionId", type: "bytes32" },
      { name: "commitment", type: "bytes32" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "revealBid",
    stateMutability: "nonpayable",
    inputs: [
      { name: "auctionId", type: "bytes32" },
      { name: "amount", type: "uint256" },
      { name: "salt", type: "bytes32" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "finalizeAuction",
    stateMutability: "nonpayable",
    inputs: [{ name: "auctionId", type: "bytes32" }],
    outputs: [],
  },
  {
    type: "function",
    name: "withdrawCredit",
    stateMutability: "nonpayable",
    inputs: [],
    outputs: [],
  },
  {
    type: "function",
    name: "creditOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "credit", type: "uint256" }],
  },
  {
    type: "function",
    name: "getAuction",
    stateMutability: "view",
    inputs: [{ name: "auctionId", type: "bytes32" }],
    outputs: [
      {
        name: "auction",
        type: "tuple",
        components: [
          { name: "owner", type: "address" },
          { name: "commitOpensAt", type: "uint64" },
          { name: "revealOpensAt", type: "uint64" },
          { name: "revealClosesAt", type: "uint64" },
          { name: "bond", type: "uint256" },
          { name: "bidderCount", type: "uint32" },
          { name: "winner", type: "address" },
          { name: "winningAmount", type: "uint256" },
          { name: "finalized", type: "bool" },
        ],
      },
    ],
  },
  {
    type: "function",
    name: "getBid",
    stateMutability: "view",
    inputs: [
      { name: "auctionId", type: "bytes32" },
      { name: "bidder", type: "address" },
    ],
    outputs: [
      {
        name: "bid",
        type: "tuple",
        components: [
          { name: "commitment", type: "bytes32" },
          { name: "amount", type: "uint256" },
          { name: "revealed", type: "bool" },
        ],
      },
    ],
  },
] as const;

export type AuctionPhase =
  "SCHEDULED" | "COMMIT_OPEN" | "REVEAL_OPEN" | "FINALIZABLE" | "FINALIZED";

export interface PublicAuctionRecord {
  readonly id: Hash;
  readonly owner: Address;
  readonly phase: AuctionPhase;
  readonly commitOpensAt: bigint;
  readonly revealOpensAt: bigint;
  readonly revealClosesAt: bigint;
  readonly bond: bigint;
  readonly bidderCount: number;
  readonly winner: Address | null;
  readonly winningAmount: bigint | null;
}

export interface PublicAuctionBidRecord {
  readonly commitment: CommitmentHash | null;
  readonly revealed: boolean;
  readonly amount: bigint | null;
  readonly visibility: "HIDDEN_UNTIL_REVEAL" | "PUBLIC_AFTER_REVEAL";
}

export interface AuctionRecords {
  create(input: {
    readonly actor: Address;
    readonly id: Hash;
    readonly commitOpensAt: bigint;
    readonly revealOpensAt: bigint;
    readonly revealClosesAt: bigint;
    readonly bond: bigint;
  }): Promise<PublicAuctionRecord>;
  view(id: Hash): Promise<PublicAuctionRecord>;
  bid(id: Hash, bidder: Address): Promise<PublicAuctionBidRecord>;
  commitment(input: {
    readonly bidder: Address;
    readonly id: Hash;
    readonly amount: bigint;
    readonly salt: SecretSalt;
  }): CommitmentHash;
  commit(input: {
    readonly actor: Address;
    readonly id: Hash;
    readonly amount: bigint;
    readonly salt: SecretSalt;
  }): Promise<PublicAuctionBidRecord>;
  reveal(input: {
    readonly actor: Address;
    readonly id: Hash;
    readonly amount: bigint;
    readonly salt: SecretSalt;
  }): Promise<PublicAuctionBidRecord>;
  finalize(input: { readonly actor: Address; readonly id: Hash }): Promise<PublicAuctionRecord>;
  credit(account: Address): Promise<bigint>;
  withdraw(actor: Address): Promise<void>;
}

export function createViemAuctionRecords(options: {
  readonly auction: Address;
  readonly publicClient: PublicClient;
  readonly walletClientFor: (actor: Address) => WalletClient;
}): AuctionRecords {
  const transactionFor = (actor: Address) => {
    const wallet = options.walletClientFor(actor);
    if (wallet.account === undefined) throw new Error("Auction wallet has no account");
    if (wallet.account.address.toLowerCase() !== actor) {
      throw new DomainError("UNAUTHORIZED", "The connected wallet does not match the actor");
    }
    return {
      wallet,
      transaction: {
        account: wallet.account,
        address: options.auction,
        abi: sealedBidAuctionAbi,
        chain: wallet.chain,
      } as const,
    };
  };

  const waitForSuccess = async (hash: Hash): Promise<void> => {
    const receipt = await options.publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`Auction transaction reverted (${hash})`);
  };

  const commitment = (input: {
    readonly bidder: Address;
    readonly id: Hash;
    readonly amount: bigint;
    readonly salt: SecretSalt;
  }): CommitmentHash => {
    if (input.amount <= 0n) throw new Error("Bid amount must be greater than zero");
    return commitmentHash(
      keccak256(
        encodeAbiParameters(
          [
            { type: "uint256" },
            { type: "address" },
            { type: "bytes32" },
            { type: "address" },
            { type: "uint256" },
            { type: "bytes32" },
          ],
          [
            BigInt(options.publicClient.chain?.id ?? 0),
            options.auction,
            input.id,
            input.bidder,
            input.amount,
            input.salt,
          ],
        ),
      ),
    );
  };

  const view = async (id: Hash): Promise<PublicAuctionRecord> => {
    const [auction, block] = await Promise.all([
      options.publicClient.readContract({
        address: options.auction,
        abi: sealedBidAuctionAbi,
        functionName: "getAuction",
        args: [id],
      }),
      options.publicClient.getBlock({ blockTag: "latest" }),
    ]);
    const phase: AuctionPhase = auction.finalized
      ? "FINALIZED"
      : block.timestamp < auction.commitOpensAt
        ? "SCHEDULED"
        : block.timestamp < auction.revealOpensAt
          ? "COMMIT_OPEN"
          : block.timestamp < auction.revealClosesAt
            ? "REVEAL_OPEN"
            : "FINALIZABLE";
    return Object.freeze({
      id,
      owner: address(auction.owner),
      phase,
      commitOpensAt: auction.commitOpensAt,
      revealOpensAt: auction.revealOpensAt,
      revealClosesAt: auction.revealClosesAt,
      bond: auction.bond,
      bidderCount: auction.bidderCount,
      winner: auction.winner === zeroAddress ? null : address(auction.winner),
      winningAmount:
        auction.finalized && auction.winner !== zeroAddress ? auction.winningAmount : null,
    });
  };

  const bid = async (id: Hash, bidder: Address): Promise<PublicAuctionBidRecord> => {
    const record = await options.publicClient.readContract({
      address: options.auction,
      abi: sealedBidAuctionAbi,
      functionName: "getBid",
      args: [id, bidder],
    });
    return Object.freeze({
      commitment: record.commitment === zeroHash ? null : commitmentHash(record.commitment),
      revealed: record.revealed,
      amount: record.revealed ? record.amount : null,
      visibility: record.revealed ? "PUBLIC_AFTER_REVEAL" : "HIDDEN_UNTIL_REVEAL",
    });
  };

  return {
    commitment,
    view,
    bid,
    async create(input) {
      const { wallet, transaction } = transactionFor(input.actor);
      const hash = await wallet.writeContract({
        ...transaction,
        functionName: "createAuction",
        args: [
          input.id,
          input.commitOpensAt,
          input.revealOpensAt,
          input.revealClosesAt,
          input.bond,
        ],
      });
      await waitForSuccess(hash);
      return view(input.id);
    },
    async commit(input) {
      const auction = await view(input.id);
      const opening = commitment({
        bidder: input.actor,
        id: input.id,
        amount: input.amount,
        salt: input.salt,
      });
      const { wallet, transaction } = transactionFor(input.actor);
      const hash = await wallet.writeContract({
        ...transaction,
        functionName: "commitBid",
        args: [input.id, opening],
        value: auction.bond,
      });
      await waitForSuccess(hash);
      return bid(input.id, input.actor);
    },
    async reveal(input) {
      const { wallet, transaction } = transactionFor(input.actor);
      const hash = await wallet.writeContract({
        ...transaction,
        functionName: "revealBid",
        args: [input.id, input.amount, input.salt],
      });
      await waitForSuccess(hash);
      return bid(input.id, input.actor);
    },
    async finalize(input) {
      const { wallet, transaction } = transactionFor(input.actor);
      const hash = await wallet.writeContract({
        ...transaction,
        functionName: "finalizeAuction",
        args: [input.id],
      });
      await waitForSuccess(hash);
      return view(input.id);
    },
    credit(account) {
      return options.publicClient.readContract({
        address: options.auction,
        abi: sealedBidAuctionAbi,
        functionName: "creditOf",
        args: [account],
      });
    },
    async withdraw(actor) {
      const { wallet, transaction } = transactionFor(actor);
      const hash = await wallet.writeContract({
        ...transaction,
        functionName: "withdrawCredit",
      });
      await waitForSuccess(hash);
    },
  };
}

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

export interface PublicInvoiceProjection {
  readonly id: `0x${string}`;
  readonly payer: Address;
  readonly payee: Address;
  readonly commitment: `0x${string}`;
  readonly ciphertextHash: `0x${string}`;
  readonly state: InvoiceState;
  readonly createdTransactionHash: Hash;
  readonly latestTransactionHash: Hash;
  readonly latestBlock: bigint;
}

export type InvoiceProjectionEvent =
  | Readonly<{
      type: "created";
      invoice: PublicInvoiceProjection;
      logIndex: number;
    }>
  | Readonly<{
      type: "stateChanged";
      id: `0x${string}`;
      state: InvoiceState;
      transactionHash: Hash;
      blockNumber: bigint;
      logIndex: number;
    }>;

export interface InvoiceProjectionRepository {
  cursor(): Promise<Readonly<{ blockNumber: bigint; blockHash: Hash }> | null>;
  apply(batch: {
    readonly events: readonly InvoiceProjectionEvent[];
    readonly throughBlock: bigint;
    readonly throughBlockHash: Hash;
    readonly reset: boolean;
  }): Promise<void>;
  view(id: `0x${string}`): Promise<PublicInvoiceProjection | null>;
}

export interface InvoiceProjector {
  sync(): Promise<Readonly<{ fromBlock: bigint | null; throughBlock: bigint; events: number }>>;
}

export function createViemInvoiceProjector(options: {
  readonly registry: Address;
  readonly publicClient: PublicClient;
  readonly repository: InvoiceProjectionRepository;
  readonly startBlock?: bigint;
}): InvoiceProjector {
  return {
    async sync() {
      const throughBlockData = await options.publicClient.getBlock({ blockTag: "latest" });
      const throughBlock = throughBlockData.number;
      const cursor = await options.repository.cursor();
      let reset = false;
      if (cursor !== null) {
        try {
          const cursorBlock = await options.publicClient.getBlock({
            blockNumber: cursor.blockNumber,
          });
          reset = cursorBlock.hash !== cursor.blockHash;
        } catch {
          reset = true;
        }
      }
      const fromBlock =
        cursor === null || reset ? (options.startBlock ?? 0n) : cursor.blockNumber + 1n;
      if (fromBlock > throughBlock) {
        return { fromBlock: null, throughBlock, events: 0 };
      }

      const [createdLogs, stateLogs] = await Promise.all([
        options.publicClient.getLogs({
          address: options.registry,
          event: invoiceCreatedEvent,
          fromBlock,
          toBlock: throughBlock,
        }),
        options.publicClient.getLogs({
          address: options.registry,
          event: invoiceStateChangedEvent,
          fromBlock,
          toBlock: throughBlock,
        }),
      ]);
      const events: InvoiceProjectionEvent[] = [
        ...createdLogs.map((log) => {
          const location = requireLogLocation(log);
          const args = requireCreatedArgs(log.args);
          return {
            type: "created" as const,
            invoice: {
              id: args.invoiceId,
              payer: address(args.payer),
              payee: address(args.payee),
              commitment: args.commitment,
              ciphertextHash: args.ciphertextHash,
              state: "REGISTERED" as const,
              createdTransactionHash: location.transactionHash,
              latestTransactionHash: location.transactionHash,
              latestBlock: location.blockNumber,
            },
            logIndex: location.logIndex,
          };
        }),
        ...stateLogs.map((log) => {
          const location = requireLogLocation(log);
          const args = requireStateChangedArgs(log.args);
          return {
            type: "stateChanged" as const,
            id: args.invoiceId,
            state: invoiceStateFromIndex(args.state),
            transactionHash: location.transactionHash,
            blockNumber: location.blockNumber,
            logIndex: location.logIndex,
          };
        }),
      ].sort(compareProjectionEvents);

      await options.repository.apply({
        events,
        throughBlock,
        throughBlockHash: throughBlockData.hash,
        reset,
      });
      return { fromBlock, throughBlock, events: events.length };
    },
  };
}

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

function invoiceStateFromIndex(value: number): InvoiceState {
  const state = stateByIndex[value];
  if (state === undefined) throw new Error(`Unknown onchain invoice state ${value}`);
  return state;
}

function requireLogLocation(log: {
  readonly transactionHash: Hash | null;
  readonly blockNumber: bigint | null;
  readonly logIndex: number | null;
}): Readonly<{ transactionHash: Hash; blockNumber: bigint; logIndex: number }> {
  if (log.transactionHash === null || log.blockNumber === null || log.logIndex === null) {
    throw new Error("Invoice projector received a pending log");
  }
  return {
    transactionHash: log.transactionHash,
    blockNumber: log.blockNumber,
    logIndex: log.logIndex,
  };
}

function requireCreatedArgs(args: {
  readonly invoiceId?: Hash | undefined;
  readonly payer?: `0x${string}` | undefined;
  readonly payee?: `0x${string}` | undefined;
  readonly commitment?: Hash | undefined;
  readonly ciphertextHash?: Hash | undefined;
}): Readonly<{
  invoiceId: Hash;
  payer: `0x${string}`;
  payee: `0x${string}`;
  commitment: Hash;
  ciphertextHash: Hash;
}> {
  if (
    args.invoiceId === undefined ||
    args.payer === undefined ||
    args.payee === undefined ||
    args.commitment === undefined ||
    args.ciphertextHash === undefined
  ) {
    throw new Error("InvoiceCreated log is missing arguments");
  }
  return {
    invoiceId: args.invoiceId,
    payer: args.payer,
    payee: args.payee,
    commitment: args.commitment,
    ciphertextHash: args.ciphertextHash,
  };
}

function requireStateChangedArgs(args: {
  readonly invoiceId?: Hash | undefined;
  readonly state?: number | undefined;
}): Readonly<{ invoiceId: Hash; state: number }> {
  if (args.invoiceId === undefined || args.state === undefined) {
    throw new Error("InvoiceStateChanged log is missing arguments");
  }
  return { invoiceId: args.invoiceId, state: args.state };
}

function compareProjectionEvents(
  left: InvoiceProjectionEvent,
  right: InvoiceProjectionEvent,
): number {
  const leftBlock = left.type === "created" ? left.invoice.latestBlock : left.blockNumber;
  const rightBlock = right.type === "created" ? right.invoice.latestBlock : right.blockNumber;
  return leftBlock === rightBlock
    ? left.logIndex - right.logIndex
    : leftBlock < rightBlock
      ? -1
      : 1;
}
