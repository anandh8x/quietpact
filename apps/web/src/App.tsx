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
import {
  PUBLIC_PAYMENT_ACKNOWLEDGEMENT,
  acknowledgePublicPayment,
  createBrowserPaymentRecords,
  createSimulatedPayments,
  createViemPublicPayments,
  type PublicChainPayment,
  type SimulatedPayment,
} from "@quietpact/payments";
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
  const [paymentAmount, setPaymentAmount] = useState("0.001");
  const [publicPaymentAccepted, setPublicPaymentAccepted] = useState(false);
  const [paymentResult, setPaymentResult] = useState<SimulatedPayment | PublicChainPayment | null>(
    null,
  );
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
  const paymentRecords = useMemo(() => createBrowserPaymentRecords(localStorage), []);
  const simulatedPayments = useMemo(
    () => createSimulatedPayments({ records: paymentRecords.simulations }),
    [paymentRecords],
  );
  const publicPayments = useMemo(() => {
    if (connected === null) return null;
    return createViemPublicPayments({
      publicClient: connected.session.publicClient,
      walletClientFor: () => connected.session.walletClient,
      records: paymentRecords.publicPayments,
    });
  }, [connected, paymentRecords]);

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
      setPaymentResult(null);
      setPublicPaymentAccepted(false);
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

  const simulateInvoicePayment = async () => {
    await runPaymentAction(async () => {
      if (connected === null || invoiceModule === null) throw new Error("Connect a wallet first");
      const id = parseHex32(invoiceInput, "Invoice ID");
      const invoice = await invoiceModule.view<unknown>(id);
      if (invoice.public.payer !== connected.session.account) {
        throw new Error("Only the invoice payer can prepare its payment");
      }
      const simulation = await simulatedPayments.send({
        payer: invoice.public.payer,
        payee: invoice.public.payee,
        amount: parsePositiveEther(paymentAmount),
      });
      setPaymentResult(simulation);
    });
  };

  const sendPublicInvoicePayment = async () => {
    await runPaymentAction(async () => {
      if (connected === null || invoiceModule === null || publicPayments === null) {
        throw new Error("Connect a wallet first");
      }
      const id = parseHex32(invoiceInput, "Invoice ID");
      const invoice = await invoiceModule.view<unknown>(id);
      if (invoice.public.payer !== connected.session.account) {
        throw new Error("Only the invoice payer can send its payment");
      }
      if (invoice.public.state !== "APPROVED") {
        throw new Error("Approve the invoice before attaching a public payment");
      }
      const payment = await publicPayments.send(
        {
          payer: invoice.public.payer,
          payee: invoice.public.payee,
          amount: parsePositiveEther(paymentAmount),
        },
        acknowledgePublicPayment(publicPaymentAccepted),
      );
      setPaymentResult(payment);
      const referenced = await invoiceModule.act<unknown>(id, {
        type: "attachPublicPayment",
        reference: payment.reference,
      });
      setResult({
        id,
        commitment: referenced.public.commitment,
        state: referenced.public.state,
        detail: "Confirmed public transfer reference attached; amount was not reconciled",
      });
    });
  };

  const runPaymentAction = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    setPaymentResult(null);
    try {
      await action();
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
    <>
      <a className="skip-link" href="#main-content">
        Skip to workspace
      </a>
      <header className="site-header">
        <a className="wordmark" href="#top" aria-label="QuietPact home">
          QuietPact
        </a>
        <nav aria-label="Primary navigation">
          <a href="#purpose">Why QuietPact</a>
          <a href="#workflows">Workflows</a>
          <a href="#privacy-boundary">Privacy boundary</a>
          <a href="#local-prototype">Local prototype</a>
        </nav>
        <div className="wallet-cluster">
          <span
            className={`network-dot ${actor === null ? "offline" : "online"}`}
            aria-hidden="true"
          />
          <span className="network-label">
            {actor === null ? "Disconnected" : "Local Anvil · 31337"}
          </span>
          <button className="wallet" disabled={busy} type="button" onClick={() => void connect()}>
            {actor === null ? "Connect wallet" : shortAddress(actor)}
          </button>
        </div>
      </header>

      <main id="main-content">
        <section className="hero" id="top" aria-labelledby="hero-title">
          <div className="hero-copy">
            <p className="eyebrow">Arc-ready · local prototype</p>
            <h1 id="hero-title">Commercial privacy, without the theatre.</h1>
            <p className="lede">
              Encrypted invoices. Sealed bids. Public payments labelled exactly as they are.
            </p>
            <div className="hero-actions">
              <a className="button-link primary" href="#workflows">
                Open local workspace <span aria-hidden="true">→</span>
              </a>
              <a className="button-link secondary" href="#privacy-boundary">
                See the privacy boundary <span aria-hidden="true">→</span>
              </a>
            </div>
            <div className="chain-marker" aria-label="Local Anvil network, chain ID 31337">
              <span>Local Anvil / Chain ID</span>
              <strong>31337</strong>
            </div>
          </div>

          <div className="hero-ledger" aria-label="QuietPact workflow classifications">
            <HeroLedgerRow
              number="01"
              title="Encrypted invoice"
              status="ENCRYPTED OFFCHAIN"
              detail="Bodies stay with authorized recipients"
              tone="private"
            />
            <HeroLedgerRow
              number="02"
              title="Sealed bid"
              status="HIDDEN UNTIL REVEAL"
              detail="Commitment public, opening encrypted"
              tone="private"
            />
            <HeroLedgerRow
              number="03"
              title="Public payment"
              status="PUBLIC ONCHAIN"
              detail="Amount, sender, and recipient inspectable"
              tone="public"
            />
            <div className="ledger-foot">
              <span>● {actor === null ? "Wallet not connected" : "Connected to local chain"}</span>
              <span>Local Anvil · Chain 31337</span>
            </div>
          </div>
        </section>

        <section className="purpose-section" id="purpose" aria-labelledby="purpose-title">
          <div className="problem-copy">
            <p className="eyebrow">The problem</p>
            <h2 id="purpose-title">Public ledgers make poor filing cabinets.</h2>
            <p>
              Blockchains make coordination verifiable by making data widely inspectable. For
              commercial workflows, publishing everything can expose prices, terms, relationships,
              and bidding strategy.
            </p>
            <p>
              Moving every record into a private database restores confidentiality, but asks every
              participant to trust one operator and its version of history.
            </p>
          </div>

          <ol className="problem-ledger" aria-label="Problems QuietPact addresses">
            <li>
              <span>01</span>
              <div>
                <h3>Commercial data leaks</h3>
                <p>
                  Publishing invoices or bids directly can expose pricing, terms, counterparties,
                  and strategy.
                </p>
              </div>
            </li>
            <li>
              <span>02</span>
              <div>
                <h3>Private systems demand trust</h3>
                <p>
                  Keeping every record in one database asks all parties to trust its operator and
                  history.
                </p>
              </div>
            </li>
            <li className="public-problem">
              <span>03</span>
              <div>
                <h3>Privacy claims blur public facts</h3>
                <p>
                  Wallets, timing, transfers, and revealed bids can remain visible even when an
                  interface feels private.
                </p>
              </div>
            </li>
          </ol>

          <div className="purpose-panel">
            <div className="purpose-statement">
              <p className="eyebrow">QuietPact&apos;s purpose</p>
              <h3>Separate private content from public coordination.</h3>
            </div>
            <article className="purpose-proof">
              <span aria-hidden="true">⌑</span>
              <h4>Encrypted invoice bodies</h4>
              <p>
                Named recipients can open the details while a public commitment anchors integrity.
              </p>
            </article>
            <article className="purpose-proof">
              <span aria-hidden="true">◉</span>
              <h4>Sealed bids until reveal</h4>
              <p>Bid openings stay encrypted while commitments and deadlines remain shared.</p>
            </article>
            <article className="purpose-proof public-proof">
              <span aria-hidden="true">◎</span>
              <h4>Honest public state</h4>
              <p>Workflow changes and current payments stay inspectable and are labelled public.</p>
            </article>
          </div>
        </section>

        <section className="workspace-intro" id="workflows" aria-labelledby="workspace-title">
          <p className="eyebrow">Working local prototype</p>
          <h2 id="workspace-title">Two workflows. One honest boundary.</h2>
          <p>
            Every control below talks to the local contracts and API. Connect an injected wallet on
            Anvil before starting.
          </p>
        </section>

        <section className="workflow-section invoice-section" aria-labelledby="invoice-title">
          <div className="section-intro">
            <span className="section-number">01</span>
            <p className="eyebrow">Encrypted invoice</p>
            <h2 id="invoice-title">Private in the record. Public in the state.</h2>
            <p>
              The invoice body is encrypted in your browser. The contract receives parties,
              commitment, ciphertext hash, and public workflow state. It never stores the private
              memo or amount.
            </p>
            <div className="fact-line">
              <span className="fact-icon" aria-hidden="true">
                ⌑
              </span>
              <span>
                <strong>Recipients only.</strong>
                <br />
                Public chain activity remains inspectable.
              </span>
            </div>
          </div>

          <div className="product-console invoice-console">
            <ol className="step-rail" aria-label="Invoice workflow steps" tabIndex={0}>
              {["Connect", "Encrypt", "Register", "Approve", "Reference"].map((step, index) => (
                <li className={index === 0 && actor !== null ? "active" : ""} key={step}>
                  <span>{index + 1}</span>
                  {step}
                </li>
              ))}
            </ol>

            <div className="console-heading">
              <div>
                <h3>
                  Invoice details <span>(private)</span>
                </h3>
                <p>Encrypted offchain before any contract write.</p>
              </div>
              <span className="classification private">Encrypted offchain</span>
            </div>

            <form className="invoice-create-form" onSubmit={(event) => void createInvoice(event)}>
              <label className="wide-field">
                Payer wallet
                <input
                  required
                  autoComplete="off"
                  placeholder="0x…"
                  value={payerInput}
                  onChange={(event) => setPayerInput(event.target.value)}
                />
              </label>
              <label>
                Amount <span className="field-note">encrypted</span>
                <input
                  required
                  inputMode="decimal"
                  value={amount}
                  onChange={(event) => setAmount(event.target.value)}
                />
              </label>
              <label className="wide-field">
                Private memo
                <textarea required value={memo} onChange={(event) => setMemo(event.target.value)} />
              </label>
              <button className="primary-action" disabled={busy || actor === null} type="submit">
                {busy ? "Action pending…" : "Encrypt and register"}
              </button>
            </form>

            <div className="record-actions">
              <label>
                Invoice ID
                <input
                  autoComplete="off"
                  placeholder="0x…"
                  value={invoiceInput}
                  onChange={(event) => setInvoiceInput(event.target.value)}
                />
              </label>
              <button
                disabled={busy || actor === null}
                type="button"
                onClick={() => void openInvoice(false)}
              >
                Open invoice
              </button>
              <button
                disabled={busy || actor === null}
                type="button"
                onClick={() => void openInvoice(true)}
              >
                Approve as payer
              </button>
            </div>

            <div className="payment-adapter">
              <div className="adapter-heading">
                <div>
                  <p className="eyebrow">Payment adapters</p>
                  <h3>Simulate, or send publicly</h3>
                </div>
                <p>Entered separately. Never reconciled against the encrypted invoice amount.</p>
              </div>
              <div className="payment-options">
                <div className="payment-option simulation-option">
                  <div className="option-title">
                    <strong>Simulation</strong>
                    <span>Not broadcast</span>
                  </div>
                  <p>Preview the path without a transfer, gas, or invoice state change.</p>
                  <button
                    disabled={busy || actor === null}
                    type="button"
                    onClick={() => void simulateInvoicePayment()}
                  >
                    Simulate payment
                  </button>
                </div>
                <div className="payment-option public-option">
                  <div className="option-title">
                    <strong>Public onchain</strong>
                    <span>Requires action</span>
                  </div>
                  <p className="public-warning">
                    This transfer is visible onchain. Only its confirmed hash is attached.
                  </p>
                  <label>
                    Amount to send <span className="field-note">local ETH</span>
                    <input
                      required
                      inputMode="decimal"
                      value={paymentAmount}
                      onChange={(event) => setPaymentAmount(event.target.value)}
                    />
                  </label>
                  <label className="acknowledgement">
                    <input
                      type="checkbox"
                      checked={publicPaymentAccepted}
                      onChange={(event) => setPublicPaymentAccepted(event.target.checked)}
                    />
                    <span>{PUBLIC_PAYMENT_ACKNOWLEDGEMENT}</span>
                  </label>
                  <button
                    className="public-payment-button"
                    disabled={busy || actor === null || !publicPaymentAccepted}
                    type="button"
                    onClick={() => void sendPublicInvoicePayment()}
                  >
                    Send public payment
                  </button>
                </div>
              </div>
            </div>

            {paymentResult ? (
              <div
                className={`payment-result ${paymentResult.kind === "SIMULATION" ? "simulation" : "public"}`}
                aria-live="polite"
              >
                <strong>{paymentResult.label}</strong>
                <span>{formatEther(paymentResult.amount)} local ETH</span>
                <span>{paymentResult.classification}</span>
                <code>{paymentResult.reference}</code>
              </div>
            ) : null}

            {result ? (
              <div className="result record-result" aria-live="polite">
                <span className="result-check" aria-hidden="true">
                  ✓
                </span>
                <strong>{result.state}</strong>
                <span>{result.detail}</span>
                <code>{result.id}</code>
                <code>{result.commitment}</code>
              </div>
            ) : (
              <div className="empty-state">
                No invoice loaded yet. Create one or paste an invoice ID.
              </div>
            )}
          </div>
        </section>

        <section className="workflow-section auction-section" aria-labelledby="auction-title">
          <div className="product-console auction-console">
            <div className="auction-console-title">
              <div>
                <p className="eyebrow">Sealed-bid auction</p>
                <h3>Local procurement console</h3>
              </div>
              <button
                disabled={busy || actor === null}
                type="button"
                onClick={() => void viewAuction()}
              >
                Refresh auction
              </button>
            </div>
            <ol className="phase-rail" aria-label="Auction phases" tabIndex={0}>
              {["SCHEDULED", "COMMIT_OPEN", "REVEAL_OPEN", "FINALIZED"].map((item) => (
                <li className={phase === item ? "active" : ""} key={item}>
                  <span aria-hidden="true">{phase === item ? "●" : "○"}</span>
                  {item.replace("_", " ")}
                </li>
              ))}
            </ol>

            <form className="auction-create-form" onSubmit={(event) => void createAuction(event)}>
              <div className="console-subpanel">
                <p className="panel-label">Auction timing</p>
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
                <button className="dark-primary" disabled={busy || actor === null} type="submit">
                  Create auction
                </button>
              </div>
            </form>

            <div className="auction-workspace console-subpanel">
              <p className="panel-label">Bid actions</p>
              <label className="auction-id-field">
                Auction ID
                <input
                  autoComplete="off"
                  placeholder="0x…"
                  value={auctionInput}
                  onChange={(event) => setAuctionInput(event.target.value)}
                />
              </label>
              <label>
                Bid amount
                <input
                  inputMode="numeric"
                  value={bidAmount}
                  onChange={(event) => setBidAmount(event.target.value)}
                />
              </label>
              <button
                className="dark-primary"
                disabled={busy || phase !== "COMMIT_OPEN"}
                type="button"
                onClick={() => void commitBid()}
              >
                Commit bid + bond
              </button>
              <button
                disabled={busy || encryptedBackup === null}
                type="button"
                onClick={exportBackup}
              >
                Export encrypted opening
              </button>
              <label className="file-button">
                Import encrypted opening
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

            {auctionSnapshot ? (
              <AuctionStatus snapshot={auctionSnapshot} />
            ) : (
              <div className="empty-state dark-empty">
                Paste an auction ID and refresh to load its public state.
              </div>
            )}
            {auctionMessage ? (
              <p className="result success" aria-live="polite">
                {auctionMessage}
              </p>
            ) : null}
            <p className="forfeit-warning">
              △ Missing the reveal deadline forfeits the fixed bond.
            </p>
          </div>

          <div className="section-intro auction-intro">
            <span className="section-number">02</span>
            <p className="eyebrow">Sealed-bid procurement</p>
            <h2 id="auction-title">Hidden until reveal. Accountable after.</h2>
            <p>
              Commit the bid and fixed bond while the window is open. The amount stays hidden until
              its owner reveals; after that, the bid and winner are public.
            </p>
            <ul className="feature-list">
              <li>
                <span>⌑</span>
                <div>
                  <strong>Encrypted opening</strong>
                  <p>Amount and salt stay encrypted in browser storage and exported backups.</p>
                </div>
              </li>
              <li>
                <span>◉</span>
                <div>
                  <strong>Time-bound reveal</strong>
                  <p>The contract, not the interface, enforces every deadline.</p>
                </div>
              </li>
              <li>
                <span>✓</span>
                <div>
                  <strong>Deterministic outcome</strong>
                  <p>Lowest valid bid wins; address order breaks exact ties.</p>
                </div>
              </li>
            </ul>
          </div>
        </section>

        <section className="privacy-boundary" id="privacy-boundary" aria-labelledby="privacy-title">
          <p className="eyebrow">Closing / privacy boundary</p>
          <h2 id="privacy-title">
            Know what stays <em>private</em>. Know what goes public.
          </h2>
          <div className="boundary-grid">
            <BoundaryItem
              number="01"
              title="Encrypted offchain"
              subtitle="invoice bodies"
              detail="Bodies are encrypted locally for named recipients; commitments and workflow state are public."
              boundaryLabel="PRIVATE CONTENT"
              tone="private"
            />
            <BoundaryItem
              number="02"
              title="Hidden until reveal"
              subtitle="sealed bids"
              detail="Commitments hide bid openings until each bidder reveals during the public window."
              boundaryLabel="PRIVATE UNTIL REVEAL"
              tone="private"
            />
            <BoundaryItem
              number="03"
              title="Public onchain"
              subtitle="transfers and revealed bids"
              detail="Transfers, wallet addresses, contract calls, and revealed bids are inspectable by anyone."
              boundaryLabel="PUBLIC"
              tone="public"
            />
          </div>
        </section>

        <aside className="notice" aria-label="Prototype privacy notice">
          <strong>Prototype privacy notice</strong>
          <span>
            Invoice bodies are encrypted offchain; contract activity remains public. Sealed bid
            amounts are hidden only before reveal and become public after reveal.{" "}
            {publicPaymentNotice}
            Browser storage holds prototype encryption keys; bid openings use wallet-unlocked
            AES-GCM encryption. Local-chain ETH has no real value.
          </span>
        </aside>

        <section className="closing-cta" id="local-prototype" aria-labelledby="cta-title">
          <div className="cta-mark" aria-hidden="true">
            ⌑
          </div>
          <div>
            <h2 id="cta-title">Run the local prototype</h2>
            <p>Unaudited. No real funds. Not an Arc testnet deployment.</p>
          </div>
          <a className="button-link moss" href="#workflows">
            Open workspace <span aria-hidden="true">→</span>
          </a>
          <div className="footer-links">
            <a href="https://github.com/anandh8x/quietpact">GitHub ↗</a>
            <a href="https://www.apache.org/licenses/LICENSE-2.0">Apache-2.0 ↗</a>
          </div>
        </section>

        <footer>
          <span>QuietPact</span>
          <span>Arc-ready local prototype</span>
        </footer>
      </main>

      {busy ? (
        <div className="pending-toast" role="status" aria-live="polite">
          Wallet or chain action pending…
        </div>
      ) : null}
      {error ? (
        <div className="error-toast" role="alert">
          <div>
            <strong>Action needs attention</strong>
            <span>{error}</span>
          </div>
          <button type="button" onClick={() => setError(null)} aria-label="Dismiss error">
            ×
          </button>
        </div>
      ) : null}
    </>
  );
}

function HeroLedgerRow({
  number,
  title,
  status,
  detail,
  tone,
}: Readonly<{
  number: string;
  title: string;
  status: string;
  detail: string;
  tone: "private" | "public";
}>) {
  return (
    <div className="ledger-row">
      <span className="ledger-number">{number}</span>
      <div>
        <small>Workflow</small>
        <strong>{title}</strong>
        <span>{detail}</span>
      </div>
      <span className={`classification ${tone}`}>{status}</span>
      <span aria-hidden="true">→</span>
    </div>
  );
}

function BoundaryItem({
  number,
  title,
  subtitle,
  detail,
  boundaryLabel,
  tone,
}: Readonly<{
  number: string;
  title: string;
  subtitle: string;
  detail: string;
  boundaryLabel: string;
  tone: "private" | "public";
}>) {
  return (
    <article className={`boundary-item ${tone}`}>
      <div className={`boundary-icon ${tone}`} aria-hidden="true">
        {tone === "private" ? "⌑" : "◎"}
      </div>
      <div>
        <span>{number}</span>
        <h3>{title}</h3>
        <em>{subtitle}</em>
      </div>
      <p>{detail}</p>
      <strong className={tone}>{boundaryLabel}</strong>
    </article>
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
            ? `${bid.amount?.toString() ?? "Not revealed"} · PUBLIC AFTER REVEAL`
            : bid.commitment === null
              ? "Not committed"
              : "HIDDEN UNTIL REVEAL"}
        </strong>
      </div>
      <div>
        <span>Winner</span>
        <strong>{view.winner === null ? "Not selected" : shortAddress(view.winner)}</strong>
      </div>
      <div>
        <span>Winning amount</span>
        <strong>{view.winningAmount?.toString() ?? "Not revealed"}</strong>
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

function parsePositiveEther(value: string): bigint {
  const parsed = parseEther(value);
  if (parsed <= 0n) throw new Error("Payment amount must be greater than zero");
  return parsed;
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
  const shortMessage =
    typeof cause === "object" &&
    cause !== null &&
    "shortMessage" in cause &&
    typeof cause.shortMessage === "string"
      ? cause.shortMessage
      : undefined;
  const message = shortMessage ?? (cause instanceof Error ? cause.message : undefined);

  if (!message) return "The local QuietPact workflow failed. Please try again.";
  if (/user rejected|user denied|request rejected/i.test(message)) {
    return "The wallet request was cancelled. Nothing was submitted.";
  }
  if (/\b401\b|unauthori[sz]ed/i.test(message)) {
    return "Your wallet session expired. Reconnect your wallet and try again.";
  }
  if (/failed to fetch|network error/i.test(message)) {
    return "QuietPact could not reach the local service. Check that the API and Anvil are running.";
  }

  return message;
}
