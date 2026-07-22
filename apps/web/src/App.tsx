import { useMemo, useState, type ChangeEvent, type FormEvent } from "react";

import {
  createViemAuctionRecords,
  createViemInvoiceRecords,
  type PublicAuctionBidRecord,
  type PublicAuctionRecord,
} from "@quietpact/chain-records";
import { address, secretSalt, type Address } from "@quietpact/domain";
import {
  createEnvelopeModule,
  type EnvelopeModule,
  type RecipientIdentity,
} from "@quietpact/envelope";
import {
  createEncryptedInvoiceModule,
  createHttpInvoiceBlobStore,
  type InvoiceParticipant,
  type InvoiceParty,
} from "@quietpact/invoice";
import { formatEther, parseEther, type Hash } from "viem";

import {
  bidSecretUnlockMessage,
  createBidSecretBackup,
  decryptBidSecret,
  encryptBidSecret,
  loadEncryptedBidSecret,
  parseEncryptedBidSecret,
  sameBidSecretIdentity,
  saveEncryptedBidSecret,
  serializeEncryptedBidSecret,
  type BidSecretBackup,
  type EncryptedBidSecretBackup,
} from "./bid-secrets.js";
import {
  connectInjectedWallet,
  createApiSession,
  getEncryptionKey,
  loadOrCreateIdentity,
  publishEncryptionKey,
  type WalletSession,
} from "./wallet.js";

const apiUrl = import.meta.env.VITE_QUIETPACT_API_URL ?? "/api";
const publicPaymentNotice = "Payments are public onchain.";

type DemoResult = Readonly<{
  id: string;
  commitment: string;
  state: string;
  detail: string;
}>;

type ConnectedWallet = Readonly<{
  session: WalletSession;
  envelopes: EnvelopeModule;
  identity: RecipientIdentity;
  apiToken: string;
}>;

type AuctionSnapshot = Readonly<{
  view: PublicAuctionRecord;
  bid: PublicAuctionBidRecord;
  credit: bigint;
}>;

export function App() {
  const [amount, setAmount] = useState("1250.00");
  const [memo, setMemo] = useState("Quarterly security review");
  const [payerInput, setPayerInput] = useState("");
  const [invoiceInput, setInvoiceInput] = useState("");
  const [connected, setConnected] = useState<ConnectedWallet | null>(null);
  const [result, setResult] = useState<DemoResult | null>(null);
  const [auctionInput, setAuctionInput] = useState("");
  const [bidAmount, setBidAmount] = useState("75");
  const [bondEth, setBondEth] = useState("0.01");
  const [commitDelay, setCommitDelay] = useState("10");
  const [commitSeconds, setCommitSeconds] = useState("120");
  const [revealSeconds, setRevealSeconds] = useState("120");
  const [auctionSnapshot, setAuctionSnapshot] = useState<AuctionSnapshot | null>(null);
  const [secretBackup, setSecretBackup] = useState<BidSecretBackup | null>(null);
  const [encryptedBackup, setEncryptedBackup] = useState<EncryptedBidSecretBackup | null>(null);
  const [auctionMessage, setAuctionMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const actor = connected?.session.account ?? null;
  const invoiceModule = useMemo(() => {
    if (connected === null) return null;
    const participant: InvoiceParticipant = {
      address: connected.session.account,
      encryption: connected.identity,
    };
    return createEncryptedInvoiceModule({
      actor: participant,
      chainId: connected.session.chainId,
      registry: connected.session.registry,
      envelopes: connected.envelopes,
      records: createViemInvoiceRecords({
        registry: connected.session.registry,
        publicClient: connected.session.publicClient,
        walletClientFor: () => connected.session.walletClient,
      }),
      blobs: createHttpInvoiceBlobStore({
        baseUrl: apiUrl,
        headers: () => ({ authorization: `Bearer ${connected.apiToken}` }),
      }),
    });
  }, [connected]);
  const auctionRecords = useMemo(() => {
    if (connected === null) return null;
    return createViemAuctionRecords({
      auction: connected.session.auction,
      publicClient: connected.session.publicClient,
      walletClientFor: () => connected.session.walletClient,
    });
  }, [connected]);

  const connect = async () => {
    setBusy(true);
    setError(null);
    try {
      const session = await connectInjectedWallet();
      const envelopes = await createEnvelopeModule();
      const identity = loadOrCreateIdentity(session.account, envelopes);
      const apiToken = await createApiSession(apiUrl, session);
      await publishEncryptionKey(apiUrl, session.account, identity, apiToken);
      setConnected({ session, envelopes, identity, apiToken });
      setResult(null);
      setAuctionSnapshot(null);
      setSecretBackup(null);
      setEncryptedBackup(null);
    } catch (cause: unknown) {
      setError(messageFor(cause));
    } finally {
      setBusy(false);
    }
  };

  const createInvoice = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setResult(null);

    try {
      if (connected === null || invoiceModule === null) throw new Error("Connect a wallet first");
      const payerAddress = address(payerInput);
      if (payerAddress === connected.session.account) {
        throw new Error("Payer and payee must use different wallets");
      }
      const payerKey = await getEncryptionKey(apiUrl, payerAddress);
      const payer: InvoiceParty = { address: payerAddress, encryption: payerKey };
      const payee: InvoiceParticipant = {
        address: connected.session.account,
        encryption: connected.identity,
      };
      const id = randomHex32();
      const body = { amount, currency: "USDC", memo };
      const created = await invoiceModule.create({ id, payer, payee, body });

      setResult({
        id,
        commitment: created.public.commitment,
        state: created.public.state,
        detail: `${amount} USDC · encrypted for ${shortAddress(payerAddress)}`,
      });
      setInvoiceInput(id);
    } catch (cause: unknown) {
      setError(messageFor(cause));
    } finally {
      setBusy(false);
    }
  };

  const openInvoice = async (approve: boolean) => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      if (invoiceModule === null) throw new Error("Connect a wallet first");
      const id = parseHex32(invoiceInput, "Invoice ID");
      const opened = approve
        ? await invoiceModule.act<{ amount: string; memo: string }>(id, { type: "approve" })
        : await invoiceModule.view<{ amount: string; memo: string }>(id);
      if (opened.body === null) throw new Error("This wallet is not an encrypted recipient");
      setResult({
        id,
        commitment: opened.public.commitment,
        state: opened.public.state,
        detail: `${opened.body.amount} USDC · ${opened.body.memo}`,
      });
    } catch (cause: unknown) {
      setError(messageFor(cause));
    } finally {
      setBusy(false);
    }
  };

  const refreshAuction = async (idValue = auctionInput) => {
    if (connected === null || auctionRecords === null) throw new Error("Connect a wallet first");
    const id = parseHex32(idValue, "Auction ID");
    const [view, bid, credit] = await Promise.all([
      auctionRecords.view(id),
      auctionRecords.bid(id, connected.session.account),
      auctionRecords.credit(connected.session.account),
    ]);
    setAuctionSnapshot({ view, bid, credit });
    const identity = {
      chainId: connected.session.chainId.toString(),
      auction: connected.session.auction,
      auctionId: id,
      bidder: connected.session.account,
    };
    const saved = loadEncryptedBidSecret(localStorage, identity);
    setEncryptedBackup(saved);
    setSecretBackup((current) =>
      current !== null && sameBidSecretIdentity(current, identity) ? current : null,
    );
    return { view, bid, credit };
  };

  const createAuction = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    await runAuctionAction(async () => {
      if (connected === null || auctionRecords === null) throw new Error("Connect a wallet first");
      const startDelay = positiveInteger(commitDelay, "Commit delay");
      const commitLength = positiveInteger(commitSeconds, "Commit duration");
      const revealLength = positiveInteger(revealSeconds, "Reveal duration");
      const bond = parseEther(bondEth);
      if (bond <= 0n) throw new Error("Bond must be greater than zero");
      const latest = await connected.session.publicClient.getBlock({ blockTag: "latest" });
      const id = randomHex32();
      const commitOpensAt = latest.timestamp + startDelay;
      const revealOpensAt = commitOpensAt + commitLength;
      const revealClosesAt = revealOpensAt + revealLength;
      await auctionRecords.create({
        actor: connected.session.account,
        id,
        commitOpensAt,
        revealOpensAt,
        revealClosesAt,
        bond,
      });
      setAuctionInput(id);
      await refreshAuction(id);
      setAuctionMessage("Auction created. Share its ID with bidders.");
    });
  };

  const viewAuction = async () => {
    await runAuctionAction(async () => {
      await refreshAuction();
      setAuctionMessage("Auction state refreshed from the local chain.");
    });
  };

  const commitBid = async () => {
    await runAuctionAction(async () => {
      if (connected === null || auctionRecords === null) throw new Error("Connect a wallet first");
      const id = parseHex32(auctionInput, "Auction ID");
      const amountValue = positiveInteger(bidAmount, "Bid amount");
      const salt = secretSalt(randomHex32());
      const opening = auctionRecords.commitment({
        bidder: connected.session.account,
        id,
        amount: amountValue,
        salt,
      });
      const backup = createBidSecretBackup({
        chainId: connected.session.chainId,
        auction: connected.session.auction,
        auctionId: id,
        bidder: connected.session.account,
        amount: amountValue,
        salt,
        commitment: opening,
      });
      const signature = await signBidBackup(connected, backup);
      const encrypted = await encryptBidSecret(backup, signature);
      saveEncryptedBidSecret(localStorage, encrypted);
      setSecretBackup(backup);
      setEncryptedBackup(encrypted);
      await auctionRecords.commit({
        actor: connected.session.account,
        id,
        amount: amountValue,
        salt,
      });
      await refreshAuction(id);
      setAuctionMessage("Bid committed. Export the opening backup before leaving this browser.");
    });
  };

  const revealBid = async () => {
    await runAuctionAction(async () => {
      if (connected === null || auctionRecords === null) throw new Error("Connect a wallet first");
      const id = parseHex32(auctionInput, "Auction ID");
      const backup = secretBackup;
      if (backup === null || !sameBidSecretIdentity(backup, backupIdentity(connected, id))) {
        throw new Error("Unlock the encrypted bid opening for this wallet and auction first");
      }
      const amountValue = BigInt(backup.amount);
      const expected = auctionRecords.commitment({
        bidder: connected.session.account,
        id,
        amount: amountValue,
        salt: backup.salt,
      });
      if (expected !== backup.commitment)
        throw new Error("Bid backup does not match its commitment");
      await auctionRecords.reveal({
        actor: connected.session.account,
        id,
        amount: amountValue,
        salt: backup.salt,
      });
      await refreshAuction(id);
      setAuctionMessage("Bid revealed. Its amount is now public onchain.");
    });
  };

  const finalizeAuction = async () => {
    await runAuctionAction(async () => {
      if (connected === null || auctionRecords === null) throw new Error("Connect a wallet first");
      const id = parseHex32(auctionInput, "Auction ID");
      await auctionRecords.finalize({ actor: connected.session.account, id });
      await refreshAuction(id);
      setAuctionMessage("Auction finalized and bond credits calculated.");
    });
  };

  const withdrawCredit = async () => {
    await runAuctionAction(async () => {
      if (connected === null || auctionRecords === null) throw new Error("Connect a wallet first");
      await auctionRecords.withdraw(connected.session.account);
      await refreshAuction();
      setAuctionMessage("Available bond credit withdrawn.");
    });
  };

  const importBackup = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file === undefined) return;
    await runAuctionAction(async () => {
      if (connected === null || auctionRecords === null) throw new Error("Connect a wallet first");
      const encrypted = parseEncryptedBidSecret(await file.text());
      requireBackupIdentity(encrypted, connected);
      saveEncryptedBidSecret(localStorage, encrypted);
      setEncryptedBackup(encrypted);
      setSecretBackup(null);
      setAuctionInput(encrypted.auctionId);
      await refreshAuction(encrypted.auctionId);
      setAuctionMessage("Encrypted backup imported. Unlock it with this wallet before reveal.");
    });
    event.target.value = "";
  };

  const exportBackup = () => {
    if (encryptedBackup === null) return;
    const blob = new Blob([serializeEncryptedBidSecret(encryptedBackup)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `quietpact-bid-${encryptedBackup.auctionId.slice(2, 10)}.json`;
    link.click();
    URL.revokeObjectURL(url);
    setAuctionMessage("Bid opening backup exported. Keep it private until reveal.");
  };

  const unlockBackup = async () => {
    await runAuctionAction(async () => {
      if (connected === null || auctionRecords === null || encryptedBackup === null) {
        throw new Error("No encrypted bid backup is available");
      }
      requireBackupIdentity(encryptedBackup, connected);
      const signature = await signBidBackup(connected, encryptedBackup);
      const backup = await decryptBidSecret(encryptedBackup, signature);
      const expected = auctionRecords.commitment({
        bidder: backup.bidder,
        id: backup.auctionId,
        amount: BigInt(backup.amount),
        salt: backup.salt,
      });
      if (expected !== backup.commitment)
        throw new Error("Bid opening does not match its commitment");
      setSecretBackup(backup);
      setBidAmount(backup.amount);
      setAuctionMessage("Bid opening unlocked in memory and verified.");
    });
  };

  const runAuctionAction = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    setAuctionMessage(null);
    try {
      await action();
    } catch (cause: unknown) {
      setError(messageFor(cause));
    } finally {
      setBusy(false);
    }
  };

  const phase = auctionSnapshot?.view.phase;

  return (
    <main>
      <div className="topline">
        <div className="status">Arc-ready prototype · Local development</div>
        <button className="wallet" disabled={busy} type="button" onClick={() => void connect()}>
          {actor === null ? "Connect wallet" : shortAddress(actor)}
        </button>
      </div>
      <section className="hero">
        <p className="eyebrow">QuietPact</p>
        <h1>Private commercial workflows, ready for Arc.</h1>
        <p className="lede">
          Encrypt invoice bodies and commit sealed procurement bids locally, while keeping every
          public onchain action precisely labelled.
        </p>
      </section>

      <section className="demo" aria-labelledby="invoice-title">
        <div>
          <p className="eyebrow">Encrypted invoices</p>
          <h2 id="invoice-title">Encrypt, register, and approve</h2>
          <p className="demo-copy">
            Connect the future payer once to publish their encryption key. Then connect the payee to
            create the invoice and sign its public commitment transaction.
          </p>
        </div>
        <form onSubmit={(event) => void createInvoice(event)}>
          <label>
            Payer wallet
            <input
              required
              placeholder="0x…"
              value={payerInput}
              onChange={(event) => setPayerInput(event.target.value)}
            />
          </label>
          <label>
            Amount
            <input
              required
              inputMode="decimal"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
            />
          </label>
          <label>
            Private memo
            <textarea required value={memo} onChange={(event) => setMemo(event.target.value)} />
          </label>
          <button disabled={busy} type="submit">
            {busy ? "Waiting…" : "Encrypt and register"}
          </button>
        </form>

        <div className="invoice-actions">
          <label>
            Invoice ID
            <input
              placeholder="0x…"
              value={invoiceInput}
              onChange={(event) => setInvoiceInput(event.target.value)}
            />
          </label>
          <div className="action-row">
            <button disabled={busy} type="button" onClick={() => void openInvoice(false)}>
              Open invoice
            </button>
            <button disabled={busy} type="button" onClick={() => void openInvoice(true)}>
              Approve as payer
            </button>
          </div>
        </div>

        {result ? (
          <div className="result" aria-live="polite">
            <strong>{result.state}</strong>
            <span>{result.detail}</span>
            <code>{result.id}</code>
            <code>{result.commitment}</code>
          </div>
        ) : null}
      </section>

      <section className="demo auction-demo" aria-labelledby="auction-title">
        <div>
          <p className="eyebrow">Phase 5 · Sealed-bid procurement</p>
          <h2 id="auction-title">Commit hidden. Reveal public.</h2>
          <p className="demo-copy">
            Bid amounts stay hidden while commitments are open. During reveal, amount and bidder
            become public onchain. Missing the reveal deadline forfeits the fixed bond.
          </p>
        </div>

        <form onSubmit={(event) => void createAuction(event)}>
          <div className="field-grid">
            <label>
              Opens after (seconds)
              <input
                required
                inputMode="numeric"
                value={commitDelay}
                onChange={(event) => setCommitDelay(event.target.value)}
              />
            </label>
            <label>
              Commit window (seconds)
              <input
                required
                inputMode="numeric"
                value={commitSeconds}
                onChange={(event) => setCommitSeconds(event.target.value)}
              />
            </label>
            <label>
              Reveal window (seconds)
              <input
                required
                inputMode="numeric"
                value={revealSeconds}
                onChange={(event) => setRevealSeconds(event.target.value)}
              />
            </label>
            <label>
              Fixed bond (local ETH)
              <input
                required
                inputMode="decimal"
                value={bondEth}
                onChange={(event) => setBondEth(event.target.value)}
              />
            </label>
          </div>
          <button disabled={busy || actor === null} type="submit">
            Create auction
          </button>
        </form>

        <div className="auction-workspace">
          <label>
            Auction ID
            <input
              placeholder="0x…"
              value={auctionInput}
              onChange={(event) => setAuctionInput(event.target.value)}
            />
          </label>
          <button
            disabled={busy || actor === null}
            type="button"
            onClick={() => void viewAuction()}
          >
            Refresh auction
          </button>
          <label>
            Bid amount
            <input
              inputMode="numeric"
              value={bidAmount}
              onChange={(event) => setBidAmount(event.target.value)}
            />
          </label>
          <button
            disabled={busy || phase !== "COMMIT_OPEN"}
            type="button"
            onClick={() => void commitBid()}
          >
            Commit bid + bond
          </button>
          <button disabled={busy || encryptedBackup === null} type="button" onClick={exportBackup}>
            Export opening backup
          </button>
          <label className="file-button">
            Import opening backup
            <input
              type="file"
              accept="application/json,.json"
              onChange={(event) => void importBackup(event)}
            />
          </label>
          <button
            disabled={busy || encryptedBackup === null || secretBackup !== null}
            type="button"
            onClick={() => void unlockBackup()}
          >
            Unlock saved opening
          </button>
          <button
            disabled={busy || phase !== "REVEAL_OPEN" || secretBackup === null}
            type="button"
            onClick={() => void revealBid()}
          >
            Reveal saved bid
          </button>
          <button
            disabled={busy || phase !== "FINALIZABLE"}
            type="button"
            onClick={() => void finalizeAuction()}
          >
            Finalize auction
          </button>
          <button
            disabled={busy || (auctionSnapshot?.credit ?? 0n) === 0n}
            type="button"
            onClick={() => void withdrawCredit()}
          >
            Withdraw bond credit
          </button>
        </div>

        {auctionSnapshot ? <AuctionStatus snapshot={auctionSnapshot} /> : null}
        {auctionMessage ? <p className="result success">{auctionMessage}</p> : null}
      </section>

      {error ? (
        <p className="result error" aria-live="assertive">
          {error}
        </p>
      ) : null}

      <aside className="notice" aria-label="Prototype privacy notice">
        <strong>Prototype privacy notice</strong>
        <span>
          Invoice bodies are encrypted offchain; contract activity remains public. Sealed bid
          amounts are hidden only before reveal and become public after reveal.{" "}
          {publicPaymentNotice} Browser storage holds prototype encryption keys; bid openings are
          AES-GCM encrypted behind a wallet-signature unlock. Export bid backups and keep them
          private. Local-chain ETH has no real value.
        </span>
      </aside>
      <footer>Local prototype · unaudited · no real funds</footer>
    </main>
  );
}

function AuctionStatus({ snapshot }: { readonly snapshot: AuctionSnapshot }) {
  const { view, bid, credit } = snapshot;
  return (
    <div className="auction-status" aria-live="polite">
      <div>
        <span>Phase</span>
        <strong>{view.phase}</strong>
      </div>
      <div>
        <span>Bidders</span>
        <strong>{view.bidderCount}</strong>
      </div>
      <div>
        <span>Bond</span>
        <strong>{formatEther(view.bond)} local ETH</strong>
      </div>
      <div>
        <span>Your credit</span>
        <strong>{formatEther(credit)} local ETH</strong>
      </div>
      <div>
        <span>Commit opens</span>
        <strong>{formatTimestamp(view.commitOpensAt)}</strong>
      </div>
      <div>
        <span>Reveal opens</span>
        <strong>{formatTimestamp(view.revealOpensAt)}</strong>
      </div>
      <div>
        <span>Reveal closes</span>
        <strong>{formatTimestamp(view.revealClosesAt)}</strong>
      </div>
      <div>
        <span>Your bid</span>
        <strong>
          {bid.revealed
            ? `${bid.amount?.toString() ?? "—"} · PUBLIC AFTER REVEAL`
            : bid.commitment === null
              ? "Not committed"
              : "HIDDEN UNTIL REVEAL"}
        </strong>
      </div>
      <div>
        <span>Winner</span>
        <strong>{view.winner === null ? "—" : shortAddress(view.winner)}</strong>
      </div>
      <div>
        <span>Winning amount</span>
        <strong>{view.winningAmount?.toString() ?? "—"}</strong>
      </div>
    </div>
  );
}

function backupIdentity(connected: ConnectedWallet, auctionId: Hash) {
  return {
    chainId: connected.session.chainId.toString(),
    auction: connected.session.auction,
    auctionId,
    bidder: connected.session.account,
  } as const;
}

function requireBackupIdentity(
  backup: BidSecretBackup | EncryptedBidSecretBackup,
  connected: ConnectedWallet,
): void {
  if (backup.chainId !== connected.session.chainId.toString()) {
    throw new Error("Bid backup belongs to a different chain");
  }
  if (backup.auction !== connected.session.auction) {
    throw new Error("Bid backup belongs to a different auction contract");
  }
  if (backup.bidder !== connected.session.account) {
    throw new Error("Bid backup belongs to a different wallet");
  }
}

async function signBidBackup(
  connected: ConnectedWallet,
  identity: BidSecretBackup | EncryptedBidSecretBackup,
): Promise<string> {
  return connected.session.walletClient.signMessage({
    account: connected.session.account,
    message: bidSecretUnlockMessage(identity),
  });
}

function randomHex32(): Hash {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return `0x${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function parseHex32(value: string, label: string): Hash {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) throw new Error(`${label} must be 32-byte hex`);
  return value.toLowerCase() as Hash;
}

function positiveInteger(value: string, label: string): bigint {
  if (!/^[1-9][0-9]*$/.test(value)) throw new Error(`${label} must be a positive integer`);
  return BigInt(value);
}

function formatTimestamp(value: bigint): string {
  const milliseconds = value * 1000n;
  if (milliseconds > BigInt(Number.MAX_SAFE_INTEGER)) return value.toString();
  return new Date(Number(milliseconds)).toLocaleString();
}

function shortAddress(value: Address): string {
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}

function messageFor(cause: unknown): string {
  return cause instanceof Error ? cause.message : "The local QuietPact workflow failed";
}
